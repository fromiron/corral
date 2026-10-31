# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.3.5", "scikit-learn==1.7.2", "scipy==1.16.3", "joblib==1.5.2", "threadpoolctl==3.6.0"]
# ///
"""Compare frozen-embedding heads without selecting on either final evaluation set.

Usage: uv run --no-project train-v2.py <original.jsonl> <original.f32>
       <curriculum.jsonl> <curriculum.f32> <output-dir>

Writes candidates and validation evidence first. Final held-out evaluation is a separate
TypeScript command that loads these artifacts through the product classifier.
"""
import hashlib
import json
import sys
import warnings
from pathlib import Path

import numpy as np
from scipy.optimize import minimize_scalar
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

LEVELS = ['low', 'medium', 'high', 'xhigh']
ORIGINAL_SHA = '2f3cea1d2ffac043ec8f886c6e57b30db35b5c73a52f6d4fa5ea0400ad5bd5f2'
ROOT = Path(__file__).resolve().parents[3]


def split(row):
    if 'split' in row:
        return row['split']
    if row['use'] == 'eval':
        return 'eval'
    unit = int.from_bytes(hashlib.sha256(row['group'].encode()).digest()[:4], 'big') / 2**32
    return 'train' if unit < .7 else 'calibration' if unit < .85 else 'test'


def read(samples, vectors, expected_sha=None):
    raw = Path(samples).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if expected_sha is not None and digest != expected_sha:
        raise ValueError('original evaluation corpus changed')
    rows = [json.loads(line) for line in raw.splitlines()]
    info = json.loads(Path(vectors + '.json').read_text())
    if info['samplesSha256'] != digest or info['count'] != len(rows) or info['device'] != 'cpu':
        raise ValueError('embedding provenance does not match CPU samples')
    x = np.fromfile(vectors, dtype='<f4').reshape(len(rows), info['dims']).astype(np.float64)
    if not np.isfinite(x).all():
        raise ValueError('non-finite embedding')
    return rows, x, info


def softmax(logits):
    ex = np.exp(logits - logits.max(axis=1, keepdims=True))
    return ex / ex.sum(axis=1, keepdims=True)


def export(model, scaler, info, name):
    common = dict(schemaVersion=2, version=name, labels=LEVELS, dims=info['dims'],
                  baseModelSha256=info['baseModelSha256'], preprocessVersion=info['preprocessVersion'],
                  task='classification', temperature=1., abstainBelow=0.)
    if isinstance(model, LogisticRegression):
        w = model.coef_ / scaler.scale_
        return {**common, 'weights': w.tolist(),
                'bias': (model.intercept_ - w @ scaler.mean_).tolist()}
    w = model.coefs_[0].T / scaler.scale_
    return {**common, 'hidden': {'weights': w.tolist(),
                                'bias': (model.intercepts_[0] - w @ scaler.mean_).tolist()},
            'weights': model.coefs_[1].T.tolist(), 'bias': model.intercepts_[1].tolist()}


def logits(weights, x):
    if 'hidden' in weights:
        hidden = weights['hidden']
        x = np.maximum(0, x @ np.array(hidden['weights']).T + hidden['bias'])
    return x @ np.array(weights['weights']).T + weights['bias']


def scores(y, pred):
    return dict(accuracy=float(np.mean(y == pred)), macroF1=float(f1_score(y, pred, average='macro')),
                levelError=float(np.abs(y-pred).mean()))


def main(args, reuse=False):
    old, old_x, info = read(args[0], args[1], ORIGINAL_SHA)
    added, added_x, added_info = read(args[2], args[3])
    for key in ('baseModelSha256', 'dims', 'preprocessVersion', 'device'):
        if info[key] != added_info[key]:
            raise ValueError('different embedding pipelines')
    rows = old + added
    x = np.concatenate([old_x, added_x])
    y = np.array([LEVELS.index(r['label']) for r in rows])
    splits = np.array([split(r) for r in rows])
    # Group-separated halves: architecture selection and probability calibration do not share groups.
    probability_half = np.array([hashlib.sha256(('probability:' + r['group']).encode()).digest()[0] < 128 for r in rows])
    validation = (splits == 'calibration') & ~probability_half
    calibration = (splits == 'calibration') & probability_half
    historical = np.arange(len(rows)) < len(old)
    coding = np.array([r['source'] in ('commitpackft', 'swe-rebench', 'swe-rebench-title', 'taco') for r in rows])
    subsets = {'historical': validation & historical, 'coding': validation & coding,
               'curriculum': validation & ~historical}
    if any(not mask.any() for mask in subsets.values()) or not calibration.any():
        raise ValueError('empty validation group')
    out = Path(args[4])
    out.mkdir(parents=True, exist_ok=True)
    baseline = json.loads((ROOT / 'packages/local-intelligence/weights/effort-v1.json').read_text())
    if reuse:
        saved = json.loads((out / 'validation.json').read_text())
        if saved['corpusSha256'] != ORIGINAL_SHA or saved['addedSha256'] != added_info['samplesSha256'] or saved['embedding'] != info:
            raise ValueError('cannot reuse candidates trained on different inputs')
    evidence = {'corpusSha256': ORIGINAL_SHA, 'addedSha256': added_info['samplesSha256'],
                'embedding': info, 'selection': '0.3 historical + 0.4 coding + 0.3 authored coding macro-F1; no validation accuracy/F1 regression on historical or coding; validation groups only',
                'candidates': []}
    pred = logits(baseline, x).argmax(axis=1)
    evidence['baselineValidation'] = {k: scores(y[m], pred[m]) for k,m in subsets.items()}
    chosen = None
    warnings.filterwarnings('ignore', category=ConvergenceWarning)
    for augmented in (False, True):
        train = (splits == 'train') & (True if augmented else historical)
        scaler = StandardScaler().fit(x[train])
        tx = scaler.transform(x[train])
        ty = y[train]
        counts = np.bincount(ty, minlength=4)
        sw = len(ty) / (4 * counts[ty])
        # Give authored examples weight without letting translations multiply a family's influence.
        if augmented:
            sw *= np.where(historical[train], 1., 4.)
        for kind, regularizer in [('linear', .1), ('linear', 1.), ('mlp32', 1.), ('mlp32', 10.), ('mlp64', 10.)]:
            name = f"{'augmented' if augmented else 'original'}-{kind}-{regularizer:g}"
            print('training', name, flush=True)
            if kind == 'linear':
                model = LogisticRegression(C=regularizer, max_iter=350, solver='lbfgs', random_state=41)
            else:
                model = MLPClassifier(hidden_layer_sizes=(int(kind[3:]),), activation='relu',
                                      alpha=regularizer, max_iter=100, batch_size=256,
                                      learning_rate_init=.001, random_state=41,
                                      early_stopping=False, n_iter_no_change=12, tol=1e-5)
            if reuse:
                weights = json.loads((out / (name + '.json')).read_text())
            else:
                model.fit(tx, ty, sample_weight=sw)
                weights = export(model, scaler, info, 'effort-v2-' + name)
            pred = logits(weights, x[validation]).argmax(axis=1)
            metrics = {k: scores(y[mask], pred[mask[validation]]) for k,mask in subsets.items()}
            score = sum(metrics[k]['macroF1'] * w for k,w in [('historical', .3), ('coding', .4), ('curriculum', .3)])
            eligible = all(metrics[k][metric] >= evidence['baselineValidation'][k][metric]
                           for k in ('historical', 'coding') for metric in ('accuracy', 'macroF1'))
            entry = dict(name=name, augmented=augmented, score=score, eligible=eligible, validation=metrics)
            evidence['candidates'].append(entry)
            (out / (name + '.json')).write_text(json.dumps(weights) + '\n')
            print(json.dumps(entry), flush=True)
            if eligible and (chosen is None or score > chosen[0]):
                chosen = (score, name, weights)
    if chosen is None:
        raise ValueError('no candidate passed the validation non-regression gate')
    _, name, weights = chosen
    z = logits(weights, x[calibration])
    cy = y[calibration]
    result = minimize_scalar(lambda t: -np.log(np.maximum(softmax(z / np.exp(t))[np.arange(len(cy)), cy], 1e-12)).mean(),
                             bounds=(np.log(.1), np.log(10)), method='bounded')
    weights['temperature'] = float(np.exp(result.x))
    p = softmax(z / weights['temperature'])
    prediction, confidence = p.argmax(axis=1), p.max(axis=1)
    # Keep the existing policy's medium fallback objective, with twice the penalty for underestimation.
    def cost(threshold):
        applied = np.where(confidence < threshold, 1, prediction)
        delta = applied - cy
        return float(np.mean(np.abs(delta) * np.where(delta < 0, 2., 1.)))
    thresholds = np.unique(np.r_[0., confidence, 1.])
    weights['abstainBelow'] = float(min(thresholds, key=lambda t: (cost(t), t)))
    weights['version'] = 'effort-v2'
    evidence['chosen'] = name
    evidence['calibrationCount'] = int(calibration.sum())
    evidence['temperature'] = weights['temperature']
    evidence['abstainBelow'] = weights['abstainBelow']
    (out / 'effort-v2.json').write_text(json.dumps(weights) + '\n')
    (out / 'validation.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print('selected', name, flush=True)


if __name__ == '__main__':
    args = [arg for arg in sys.argv[1:] if arg != '--select-only']
    if len(args) != 5:
        sys.exit(__doc__)
    with threadpool_limits(limits=4):
        main(args, reuse='--select-only' in sys.argv)
