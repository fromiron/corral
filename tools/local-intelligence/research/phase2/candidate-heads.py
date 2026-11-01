#!/usr/bin/env python3
"""F-only shared participant rankers on unchanged native EG2 scalar features."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import time

import numpy as np
from scipy.optimize import minimize
from scipy.special import logsumexp
from threadpoolctl import threadpool_limits

VERSION = 'native-eg2-candidate-ranking-v1'
L2 = .01
HIDDEN = 16


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def validate_fit(rows):
    if not rows or len({row.get('id') for row in rows}) != len(rows):
        raise ValueError('unique nonempty F ranking rows required')
    dimensions = set()
    for row in rows:
        target = row.get('target', {}); candidates = row.get('candidates', [])
        ids = [candidate.get('id') for candidate in candidates]
        if (row.get('split') != 'fit' or row.get('domain') not in ('natural', 'synthetic') or not row.get('group')
                or not row.get('id') or target.get('mode') != 'one' or target.get('excludedIds') != []
                or not target.get('eligibleIds') or len(ids) != len(set(ids)) or not ids
                or not set(target['eligibleIds']) <= set(ids)):
            raise ValueError('training accepts F one-mode rows without exclusions only')
        for candidate in candidates:
            values = np.asarray(candidate['values'], dtype=float)
            if values.ndim != 1 or not values.size or not np.isfinite(values).all():
                raise ValueError('finite nonempty candidate features required')
            dimensions.add(len(values))
    if len(dimensions) != 1:
        raise ValueError('candidate feature dimensions differ')
    return rows


def grouped_folds(rows):
    validate_fit(rows)
    assignment = {}
    for domain in sorted({row['domain'] for row in rows}):
        groups = sorted({row['group'] for row in rows if row['domain'] == domain},
                        key=lambda group: sha(f'{VERSION}:41:{domain}:{group}'.encode()))
        if len(groups) < 3:
            raise ValueError('three grouped F folds require at least three groups per domain')
        assignment.update({(domain, group): index % 3 for index, group in enumerate(groups)})
    return np.array([assignment[(row['domain'], row['group'])] for row in rows])


def row_weights(rows):
    counts = Counter((row['domain'], row['group']) for row in rows)
    groups = Counter(domain for domain, _ in counts)
    return np.array([1 / (len(groups) * groups[row['domain']] * counts[(row['domain'], row['group'])]) for row in rows])


def fit_scaler(rows):
    validate_fit(rows)
    # Give each scene its group/domain weight, then divide over its candidates.
    weights = row_weights(rows)
    x = np.array([candidate['values'] for row in rows for candidate in row['candidates']])
    w = np.array([weight / len(row['candidates']) for row, weight in zip(rows, weights) for _ in row['candidates']])
    mean = np.average(x, axis=0, weights=w)
    scale = np.sqrt(np.average((x - mean) ** 2, axis=0, weights=w))
    scale[scale < 1e-12] = 1.
    return {'mean': mean.tolist(), 'scale': scale.tolist()}


def training_arrays(rows, scaler):
    validate_fit(rows)
    width = max(len(row['candidates']) for row in rows)
    dimensions = len(scaler['mean'])
    x = np.zeros((len(rows), width, dimensions)); eligible = np.full((len(rows), width), -1, dtype=int)
    for i, row in enumerate(rows):
        values = np.array([candidate['values'] for candidate in row['candidates']])
        x[i, :len(values)] = (values - scaler['mean']) / scaler['scale']
        eligible[i, :len(values)] = [candidate['id'] in row['target']['eligibleIds'] for candidate in row['candidates']]
    return x, eligible, row_weights(rows)


def initial_parameters(dimensions, kind, seed):
    if kind == 'linear': return np.zeros(dimensions)
    if kind != 'relu16': raise ValueError('only linear and ReLU16 recipes are frozen')
    random = np.random.default_rng(seed)
    return np.concatenate([random.normal(0, np.sqrt(2 / dimensions), (dimensions, HIDDEN)).ravel(),
                           np.full(HIDDEN, .01), random.normal(0, .05, HIDDEN)])


def unpack(parameters, dimensions, kind):
    if kind == 'linear': return parameters, None, None
    size = dimensions * HIDDEN
    return parameters[:size].reshape(dimensions, HIDDEN), parameters[size:size + HIDDEN], parameters[size + HIDDEN:]


def objective(parameters, x, eligible, weights, kind):
    first, bias, second = unpack(parameters, x.shape[-1], kind)
    hidden = None if kind == 'linear' else np.maximum(0, x @ first + bias)
    scores = x @ first if hidden is None else hidden @ second
    all_scores = np.where(eligible >= 0, scores, -np.inf)
    positive_scores = np.where(eligible == 1, scores, -np.inf)
    all_z = logsumexp(all_scores, axis=1, keepdims=True)
    positive_z = logsumexp(positive_scores, axis=1, keepdims=True)
    loss = np.dot(weights, (all_z - positive_z)[:, 0])
    derivative = weights[:, None] * (np.exp(all_scores - all_z) - np.exp(positive_scores - positive_z))
    if hidden is None:
        gradient = np.einsum('ij,ijk->k', derivative, x)
    else:
        d_hidden = derivative[:, :, None] * second * (hidden > 0)
        gradient = np.concatenate([np.einsum('ijk,ijl->kl', x, d_hidden).ravel(),
                                   d_hidden.sum(axis=(0, 1)), np.einsum('ij,ijk->k', derivative, hidden)])
    # Shared output bias is omitted: it cancels in the listwise distribution.
    return float(loss + .5 * L2 * np.dot(parameters, parameters)), gradient + L2 * parameters


def fit_head(rows, kind, seed):
    validate_fit(rows)
    scaler = fit_scaler(rows); x, eligible, weights = training_arrays(rows, scaler)
    start = time.monotonic()
    with threadpool_limits(limits=6):
        result = minimize(objective, initial_parameters(x.shape[-1], kind, seed), args=(x, eligible, weights, kind),
                          method='L-BFGS-B', jac=True, options={'maxiter': 200, 'ftol': 1e-9, 'gtol': 1e-6})
    first, bias, second = unpack(result.x, x.shape[-1], kind)
    model = {'kind': kind, 'scaler': scaler, 'first': first.tolist()}
    if kind == 'relu16': model.update(hiddenBias=bias.tolist(), second=second.tolist())
    return model, {'trainingRows': len(rows), 'trainingGroups': len({(r['domain'], r['group']) for r in rows}),
                   'seed': seed, 'l2': L2, 'maxIterations': 200, 'iterations': int(result.nit),
                   'converged': bool(result.success), 'optimizerMessage': str(result.message),
                   'trainingObjective': float(result.fun), 'seconds': time.monotonic() - start,
                   'holdoutUsedForTrainingOrCheckpoint': False}


def score(model, candidates):
    x = (np.asarray([candidate['values'] for candidate in candidates]) - model['scaler']['mean']) / model['scaler']['scale']
    if model['kind'] == 'linear': return x @ np.asarray(model['first'])
    return np.maximum(0, x @ np.asarray(model['first']) + model['hiddenBias']) @ np.asarray(model['second'])


def metrics(rows, selected):
    output = {}
    for domain in sorted({row['domain'] for row in rows}):
        values = []; by_group = defaultdict(list)
        for row in rows:
            if row['domain'] != domain: continue
            valid = selected[row['id']] in row['target']['eligibleIds']
            values.append(valid); by_group[row['group']].append(valid)
        output[domain] = {'rows': len(values), 'groups': len(by_group), 'correct': sum(values),
                          'rowAccuracy': float(np.mean(values)),
                          'equalGroupAccuracy': float(np.mean([np.mean(group) for group in by_group.values()]))}
    return output


def read_features(paths):
    rows = []; provenance = []; exclusions = Counter(); seen_domains = set(); shared = None
    for path in paths:
        raw = Path(path).read_bytes(); cached = json.loads(raw)
        if (cached.get('protocol') != VERSION or cached.get('split') != 'fit' or cached.get('maxInputTokens') != 256
                or cached.get('device') != 'cpu' or cached.get('domain') not in ('natural', 'synthetic')
                or cached['domain'] in seen_domains):
            raise ValueError('exact frozen native256 F caches required, one per domain')
        if cached['domain'] == 'natural' and not cached.get('manifestSha256'):
            raise ValueError('natural cache was not bound to its split freeze')
        identity = {key: cached[key] for key in ('baseModelSha256', 'release', 'helperSha256', 'engineSha256', 'baselineInputsSha256', 'featureNames', 'taskPrefix', 'extractorSha256')}
        if shared is not None and shared != identity: raise ValueError('native feature engines or representations differ')
        shared = identity; seen_domains.add(cached['domain'])
        if sha(Path(str(path) + '.vectors.f32').read_bytes()) != cached['vectorSha256']:
            raise ValueError('native embedding cache bytes changed')
        for row in cached['rows']:
            if row.get('split') != 'fit' or row.get('domain') != cached['domain']:
                raise ValueError('cache contains a non-F or differently sourced row')
            if row['target']['mode'] != 'one': exclusions[f"{row['domain']}:non-one"] += 1; continue
            if row['target']['excludedIds']: exclusions[f"{row['domain']}:explicit-exclusions"] += 1; continue
            rows.append(row)
        provenance.append({'sourceSha256': cached['inputSha256'], 'featuresSha256': sha(raw),
                           'vectorsSha256': cached['vectorSha256'], 'manifestSha256': cached['manifestSha256'], 'domain': cached['domain']})
    validate_fit(rows)
    return rows, {'sources': provenance, 'native': shared, 'outOfScopeCounts': dict(exclusions)}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--features', action='append', required=True)
    parser.add_argument('--out', required=True); args = parser.parse_args()
    out = Path(args.out).resolve()
    if out.exists(): raise ValueError('immutable F comparison output already exists')
    if any((parent / '.git').exists() for parent in (out, *out.parents)):
        raise ValueError('private feature-derived weights and per-row predictions stay outside Git')
    rows, provenance = read_features(args.features); folds = grouped_folds(rows)
    out.mkdir(parents=True, mode=0o700)
    comparisons = []; predictions = {kind: {} for kind in ('linear', 'relu16')}
    for fold in range(3):
        train = [row for row, number in zip(rows, folds) if number != fold]
        dev = [row for row, number in zip(rows, folds) if number == fold]
        for kind in ('linear', 'relu16'):
            model, receipt = fit_head(train, kind, 41 + fold)
            selected = {row['id']: row['candidates'][int(np.argmax(score(model, row['candidates'])))]['id'] for row in dev}
            predictions[kind].update(selected)
            references = {name: metrics(dev, {row['id']: row['references'][name][0] for row in dev}) for name in dev[0]['references']}
            result = {'fold': fold, 'kind': kind, 'trainingGroups': sorted({(r['domain'], r['group']) for r in train}),
                      'developmentGroups': sorted({(r['domain'], r['group']) for r in dev}), 'receipt': receipt,
                      'metrics': metrics(dev, selected), 'references': references, 'model': model, 'predictions': selected}
            comparisons.append(result)
            path = out / f'{kind}-fold{fold}.json'; path.write_text(json.dumps(result, indent=2)); path.chmod(0o600)
            print(json.dumps({'fold': fold, 'head': kind, 'converged': receipt['converged'], 'metrics': result['metrics']}), flush=True)
    pooled = {kind: metrics(rows, selected) for kind, selected in predictions.items()}
    references = {name: metrics(rows, {row['id']: row['references'][name][0] for row in rows}) for name in rows[0]['references']}
    report = {'protocol': VERSION, 'split': 'fit', 'provenance': provenance, 'sourceSha256': sha(Path(__file__).read_bytes()),
              'scope': 'one-mode observed-response ranking without explicit exclusions; no general dispatch claim',
              'folds': comparisons, 'pooledGroupHeldoutMetrics': pooled, 'references': references,
              'selection': 'none; no P selection, full-F refit, C calibration or H scoring performed'}
    path = out / 'report.json'; path.write_text(json.dumps(report, indent=2)); path.chmod(0o600)


if __name__ == '__main__': main()
