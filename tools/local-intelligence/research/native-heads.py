#!/usr/bin/env python3
"""Two CPU-only heads on actual shipped native embeddings; three F-only folds.

The outer F development fold selects the MLP epoch. These selected development
metrics are exploratory, not an unbiased final estimate or a release gate.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import warnings

import numpy as np
import sklearn
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

LEVELS = ['low', 'medium', 'high', 'xhigh']
INPUT_VERSION = 'judge-structured-v2'
PREFIX = 'task: classification | query: '
REPO = Path(__file__).resolve().parents[3]


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def fit_rows(rows):
    if not rows or any(row.get('split') != 'fit' for row in rows):
        raise ValueError('native head fitting accepts F rows only')
    rows = [row for row in rows if row.get('task') == 'effort']
    ids = set()
    for row in rows:
        if (not row.get('id') or row['id'] in ids or not isinstance(row.get('group'), str)
                or not row['group'].strip() or row.get('inputVersion') != INPUT_VERSION
                or not isinstance(row.get('text'), str) or not row['text'].strip()
                or row.get('target', {}).get('level') not in LEVELS
                or not isinstance(row['target'].get('acceptableLevels'), list)
                or row['target']['level'] not in row['target']['acceptableLevels']
                or any(level not in LEVELS for level in row['target']['acceptableLevels'])):
            raise ValueError('invalid structured F effort row')
        ids.add(row['id'])
    if not rows:
        raise ValueError('no F effort rows')
    return rows


def read_cache(source, cache):
    raw = Path(source).read_bytes()
    rows = fit_rows([json.loads(line) for line in raw.splitlines() if line.strip()])
    info = json.loads(Path(str(cache) + '.json').read_text())
    vectors = Path(cache).read_bytes()
    if (info.get('protocol') != 'native-frozen-effort-F-v1' or info.get('split') != 'fit'
            or info.get('task') != 'effort' or info.get('device') != 'cpu'
            or info.get('maxInputTokens') != 1024 or info.get('taskPrefix') != PREFIX
            or info.get('sourceSha256') != sha(raw) or info.get('vectorsSha256') != sha(vectors)
            or info.get('count') != len(rows) or len(info.get('rows', [])) != len(rows)):
        raise ValueError('native feature provenance does not match F CPU input')
    for row, saved in zip(rows, info['rows']):
        if (saved['id'] != row['id'] or saved['group'] != row['group']
                or saved['textSha256'] != sha(row['text'])
                or saved['prefixedTextSha256'] != sha(PREFIX + row['text'])):
            raise ValueError('native feature row ordering or structured input changed')
    x = np.frombuffer(vectors, dtype='<f4').reshape(len(rows), info['dims']).astype(np.float64)
    if not np.isfinite(x).all():
        raise ValueError('nonfinite native features')
    return rows, x, info


def group_fold(group):
    return int(hashlib.sha256(group.encode()).hexdigest()[:8], 16) % 5


def fold_scaler(rows, x, fold):
    rows = fit_rows(rows)
    if fold not in (0, 1, 2) or len(x) != len(rows):
        raise ValueError('only the three declared F folds are supported')
    dev = np.array([group_fold(row['group']) == fold for row in rows])
    train = ~dev
    if not train.any() or not dev.any():
        raise ValueError('empty grouped training/development partition')
    # No random row holdout: every original group stays on one side.
    scaler = StandardScaler().fit(x[train])
    return scaler, train, dev


def export_head(model, scaler, info, name):
    if not np.array_equal(model.classes_, np.arange(4)):
        raise ValueError('export requires all four effort labels in their original order')
    common = dict(schemaVersion=2, version=name, labels=LEVELS, dims=info['dims'],
                  baseModelSha256=info['baseModelSha256'], preprocessVersion=info['preprocessVersion'],
                  task='classification', temperature=1., abstainBelow=0.)
    if isinstance(model, LogisticRegression):
        weight = model.coef_ / scaler.scale_
        return {**common, 'weights': weight.tolist(),
                'bias': (model.intercept_ - weight @ scaler.mean_).tolist()}
    if not isinstance(model, MLPClassifier) or model.activation != 'relu' or model.coefs_[0].shape[1] != 64:
        raise ValueError('only the declared ReLU64 hidden architecture is exportable')
    weight = model.coefs_[0].T / scaler.scale_
    return {**common, 'hidden': {'weights': weight.tolist(),
                                'bias': (model.intercepts_[0] - weight @ scaler.mean_).tolist()},
            'weights': model.coefs_[1].T.tolist(), 'bias': model.intercepts_[1].tolist()}


def logits(weights, x):
    if 'hidden' in weights:
        hidden = weights['hidden']
        x = np.maximum(0, x @ np.asarray(hidden['weights']).T + hidden['bias'])
    return (x @ np.asarray(weights['weights']).T + weights['bias']) / weights['temperature']


def softmax(values):
    values = np.exp(values - values.max(axis=1, keepdims=True))
    return values / values.sum(axis=1, keepdims=True)


def js_parity(weights, vectors):
    module = (REPO / 'packages/local-intelligence/src/effort/classifier.ts').as_uri()
    script = f'''import {{readFileSync}} from 'node:fs';
import {{loadEffortClassifier}} from {json.dumps(module)};
const x=JSON.parse(readFileSync(0,'utf8'));
const c=loadEffortClassifier(x.weights,{{dims:x.weights.dims,baseModelSha256:x.weights.baseModelSha256,preprocessVersion:x.weights.preprocessVersion}});
console.log(JSON.stringify(x.vectors.map(v=>Object.values(c.judge(Float32Array.from(v)).probabilities))));'''
    values = np.asarray(vectors, dtype=np.float32).astype(np.float64)
    process = subprocess.run([os.environ.get('CORRAL_RESEARCH_NODE', 'node'), '--input-type=module', '-e', script],
                             input=json.dumps({'weights': weights, 'vectors': values.tolist()}),
                             text=True, capture_output=True, check=True, timeout=60)
    actual = np.asarray(json.loads(process.stdout))
    expected = softmax(logits(weights, values))
    error = float(np.max(np.abs(actual - expected)))
    if actual.shape != expected.shape or not np.isfinite(actual).all() or error > 1e-9:
        raise ValueError('Python and existing JS head math differ')
    return {'rows': len(values), 'maxProbabilityError': error, 'tolerance': 1e-9}


def metrics(rows, probabilities):
    target = np.array([LEVELS.index(row['target']['level']) for row in rows])
    predicted = probabilities.argmax(axis=1)
    strict = int((predicted == target).sum())
    acceptable = sum(LEVELS[index] in row['target']['acceptableLevels'] for row, index in zip(rows, predicted))
    return {'count': len(rows), 'strictCorrect': strict, 'strictAccuracy': strict / len(rows),
            'acceptableCorrect': acceptable, 'acceptableAccuracy': acceptable / len(rows),
            'nll': float(-np.log(np.maximum(probabilities[np.arange(len(rows)), target], 1e-15)).mean()),
            'meanLevelError': float(np.abs(predicted - target).mean()),
            'severeUnder': int(((predicted == 0) & (target >= 2)).sum()),
            'targetCounts': np.bincount(target, minlength=4).tolist(),
            'predictedCounts': np.bincount(predicted, minlength=4).tolist()}


def train_head(kind, tx, ty, dx, dy, seed):
    counts = np.bincount(ty, minlength=4)
    if not counts.all():
        raise ValueError('training fold must contain all four labels')
    sample_weight = len(ty) / (4 * counts[ty])
    history = []; observed_warnings = []
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always', ConvergenceWarning)
        if kind == 'linear':
            model = LogisticRegression(C=1., max_iter=1000, tol=1e-6, solver='lbfgs', random_state=seed)
            model.fit(tx, ty, sample_weight=sample_weight)
            selected = int(model.n_iter_.max())
        else:
            model = MLPClassifier(hidden_layer_sizes=(64,), activation='relu', solver='adam',
                                  alpha=1., learning_rate_init=.001, batch_size=128,
                                  random_state=np.random.RandomState(seed), early_stopping=False,
                                  shuffle=True, max_iter=1, tol=0., n_iter_no_change=101)
            best = float('inf'); stale = 0; chosen = None; selected = 0
            for epoch in range(1, 101):
                model.partial_fit(tx, ty, classes=np.arange(4), sample_weight=sample_weight)
                p = model.predict_proba(dx)
                loss = float(-np.log(np.maximum(p[np.arange(len(dy)), dy], 1e-15)).mean())
                history.append({'epoch': epoch, 'FdevNll': loss, 'trainLoss': float(model.loss_)})
                if loss < best - 1e-5:
                    best = loss; stale = 0; chosen = copy.deepcopy(model); selected = epoch
                else:
                    stale += 1
                if stale >= 12:
                    break
            model = chosen
        observed_warnings = sorted({str(item.message) for item in caught})
    return model, {'selectedIterationOrEpoch': selected, 'history': history, 'warnings': observed_warnings}


def write(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    Path(path).chmod(0o600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', required=True); parser.add_argument('--features', required=True)
    parser.add_argument('--out', required=True); parser.add_argument('--tokenizer')
    args = parser.parse_args(); out = Path(args.out)
    if out.exists():
        raise ValueError('head experiment output already exists')
    rows, x, info = read_cache(args.data, args.features)
    out.mkdir(parents=True, mode=0o700)
    report = {'protocol': 'native-frozen-effort-heads-F-v1', 'rows': len(rows), 'groups': len({r['group'] for r in rows}),
              'scope': 'teacher-label agreement; F-only development, not executable success or final evaluation',
              'selection': 'MLP epoch selected on outer Fdev NLL; reported development metrics are selected there',
              'folds': [0, 1, 2], 'foldRule': 'int(sha256(group).hexdigest()[:8],16)%5', 'seeds': [41, 42, 43],
              'recipes': {'linear': {'C': 1., 'solver': 'lbfgs', 'maxIterations': 1000, 'tol': 1e-6},
                          'relu64': {'alpha': 1., 'learningRate': .001, 'maxEpochs': 100, 'patience': 12, 'batchSize': 128}},
              'sampleWeight': 'inverse training label frequency; no dev label weighting in optimizer',
              'scaler': 'StandardScaler fitted to training groups only, folded into first affine layer',
              'features': info, 'scriptSha256': sha(Path(__file__).read_bytes()),
              'versions': {'numpy': np.__version__, 'scikitLearn': sklearn.__version__}, 'runs': []}
    if args.tokenizer:
        from transformers import AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained(args.tokenizer, local_files_only=True)
        token_rows = [{'id': row['id'], 'referenceTokenCount': len(tokenizer.encode(PREFIX + row['text'], add_special_tokens=True))} for row in rows]
        counts = np.array([entry['referenceTokenCount'] for entry in token_rows])
        report['tokenDiagnostic'] = {
            'scope': 'official local HF tokenizer diagnostic only; native tokenizer counts/truncation are not measured',
            'addSpecialTokens': True, 'tokenizerSha256': sha((Path(args.tokenizer) / 'tokenizer.json').read_bytes()),
            'p50': float(np.quantile(counts, .5)), 'p90': float(np.quantile(counts, .9)), 'max': int(counts.max()),
            'above1024': int((counts > 1024).sum()), 'rows': token_rows,
        }
    write(out / 'plan.json', {key: value for key, value in report.items() if key != 'runs'})
    y = np.array([LEVELS.index(row['target']['level']) for row in rows])
    with threadpool_limits(limits=6):
        for fold in range(3):
            scaler, train, dev = fold_scaler(rows, x, fold)
            tx, dx = scaler.transform(x[train]), scaler.transform(x[dev])
            dev_rows = [row for row, selected in zip(rows, dev) if selected]
            for kind in ('linear', 'relu64'):
                start = time.monotonic(); seed = 41 + fold; name = f'{kind}-fold{fold}-seed{seed}'
                model, training = train_head(kind, tx, y[train], dx, y[dev], seed)
                weights = export_head(model, scaler, info, f'native-frozen-effort-{name}')
                p = softmax(logits(weights, x[dev])); parity = js_parity(weights, x[dev][:32])
                original_probabilities = model.predict_proba(dx)
                if np.max(np.abs(original_probabilities - p)) > 1e-9:
                    raise ValueError('folding the scaler changed trained classifier probabilities')
                result = {'name': name, 'kind': kind, 'fold': fold, 'seed': seed,
                          'trainCount': int(train.sum()), 'devCount': int(dev.sum()),
                          'trainGroups': sorted({row['group'] for row, selected in zip(rows, train) if selected}),
                          'devGroups': sorted({row['group'] for row in dev_rows}),
                          'metrics': metrics(dev_rows, p), 'parity': parity, 'training': training,
                          'seconds': time.monotonic() - start}
                write(out / f'{name}.weights.json', weights)
                write(out / f'{name}.predictions.json', [{'id': row['id'], 'group': row['group'], 'probabilities': prob.tolist()}
                                                       for row, prob in zip(dev_rows, p)])
                report['runs'].append(result); write(out / 'report.json', report)
                print(json.dumps({key: result[key] for key in ('name', 'metrics', 'seconds', 'parity')}), flush=True)
    report['complete'] = True
    write(out / 'report.json', report)


if __name__ == '__main__':
    main()
