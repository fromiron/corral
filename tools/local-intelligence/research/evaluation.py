"""Offline calibration and paired evaluation; no provider calls or artifact reads.

See methods.md for estimands, confidence assumptions, and release-gate limits.
"""

from collections import Counter, defaultdict
import math

import numpy as np
from scipy.optimize import minimize_scalar
from scipy.special import logsumexp
from scipy.stats import beta

from metrics import LEVELS, valid_dispatch


def _confidence(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value < 1:
        raise ValueError('confidence must be strictly between zero and one')
    return float(value)


def _groups(groups, length):
    groups = list(groups)
    if len(groups) != length or not length:
        raise ValueError('one group is required for every observation')
    if any(not isinstance(group, str) or not group.strip() for group in groups):
        raise ValueError('groups must be nonempty strings')
    return groups


def _weights(weights, length):
    if weights is None:
        return np.full(length, 1 / length)
    weights = np.asarray(weights, dtype=float)
    if (weights.shape != (length,) or not np.isfinite(weights).all()
            or (weights < 0).any() or weights.sum() <= 0):
        raise ValueError('weights must be finite nonnegative values with positive total')
    return weights / weights.sum()


def _classification_arrays(logits, targets):
    logits = np.asarray(logits, dtype=float)
    targets = np.asarray(targets)
    if logits.ndim != 2 or logits.shape[0] == 0 or logits.shape[1] != 4:
        raise ValueError('one four-label logit vector is required per observation')
    if not np.isfinite(logits).all():
        raise ValueError('logits must be finite')
    if (targets.shape != (len(logits),) or targets.dtype.kind not in 'iu'
            or (targets < 0).any() or (targets >= 4).any()):
        raise ValueError('targets must be integer label indices from zero through three')
    return logits, targets.astype(int)


def classification_metrics(logits, targets, *, temperature=1., bins=10, weights=None):
    """Four-label agreement/calibration metrics, not executable task success."""
    logits, targets = _classification_arrays(logits, targets)
    if (isinstance(temperature, bool) or not math.isfinite(temperature)
            or temperature <= 0):
        raise ValueError('temperature must be finite and positive')
    if isinstance(bins, bool) or not isinstance(bins, int) or bins < 1:
        raise ValueError('bins must be a positive integer')
    weights = _weights(weights, len(logits))
    scaled = logits / temperature
    log_probabilities = scaled - logsumexp(scaled, axis=1, keepdims=True)
    probabilities = np.exp(log_probabilities)
    correct = probabilities.argmax(axis=1) == targets
    confidence = probabilities.max(axis=1)
    bucket = np.minimum((confidence * bins).astype(int), bins - 1)
    ece = 0.
    for index in range(bins):
        selected = bucket == index
        if selected.any():
            # Bin mass times the weighted absolute calibration gap.
            ece += abs(np.dot(weights[selected], correct[selected] - confidence[selected]))
    one_hot = np.eye(4)[targets]
    return {
        'rows': len(logits),
        'accuracy': float(np.dot(weights, correct)),
        'nll': float(-np.dot(weights, log_probabilities[np.arange(len(targets)), targets])),
        'brier': float(np.dot(weights, ((probabilities - one_hot) ** 2).sum(axis=1))),
        'ece': float(ece),
        'eceBins': bins,
    }


def _row_ids(rows):
    if not rows:
        raise ValueError('evaluation rows cannot be empty')
    ids = [row.get('id') for row in rows]
    if any(not isinstance(key, str) or not key.strip() for key in ids):
        raise ValueError('rows require nonempty IDs')
    if len(set(ids)) != len(ids):
        raise ValueError('duplicate row IDs are not allowed')
    return ids


def fit_temperature(rows, predictions, *, bounds=(.05, 20.), bins=10):
    """Fit a scalar temperature exclusively to effort C, with equal group weights."""
    rows, predictions = list(rows), list(predictions)
    ids = _row_ids(rows)
    if any(row.get('split') != 'calibration' or row.get('task') != 'effort' for row in rows):
        raise ValueError('temperature fitting accepts only effort calibration rows')
    groups = _groups([row.get('group') for row in rows], len(rows))
    prediction_ids = _row_ids(predictions)
    if set(prediction_ids) != set(ids):
        raise ValueError('prediction IDs must match calibration rows exactly')
    lookup = {prediction['id']: prediction for prediction in predictions}
    try:
        targets = [LEVELS.index(row['target']['level']) for row in rows]
        logits = [lookup[key]['logits'] for key in ids]
    except (KeyError, ValueError, TypeError) as error:
        raise ValueError('calibration rows need known labels and raw four-label logits') from error
    logits, targets = _classification_arrays(logits, targets)
    if (len(bounds) != 2 or not all(math.isfinite(value) for value in bounds)
            or not 0 < bounds[0] < 1 < bounds[1]):
        raise ValueError('temperature bounds must be finite, positive, and contain one')
    counts = Counter(groups)
    weights = np.array([1 / counts[group] / len(counts) for group in groups])

    def objective(log_temperature):
        scaled = logits / math.exp(log_temperature)
        loss = logsumexp(scaled, axis=1) - scaled[np.arange(len(targets)), targets]
        return float(np.dot(weights, loss))

    fit = minimize_scalar(
        objective, bounds=tuple(math.log(value) for value in bounds), method='bounded',
        options={'xatol': 1e-8},
    )
    if not fit.success or not math.isfinite(fit.fun):
        raise ValueError('temperature optimizer did not converge')
    candidates = [1., *bounds, math.exp(fit.x)]
    best = min(candidates, key=lambda value: objective(math.log(value)))
    temperature = best if objective(math.log(best)) < objective(0.) - 1e-12 else 1.
    return {
        'temperature': temperature,
        'bounds': list(bounds),
        'rows': len(rows),
        'groups': len(counts),
        'weighting': 'equal-group',
        'fitSplit': 'calibration',
        'before': classification_metrics(logits, targets, bins=bins, weights=weights),
        'after': classification_metrics(
            logits, targets, temperature=temperature, bins=bins, weights=weights,
        ),
    }


def _group_means(groups, candidate, reference):
    candidate, reference = np.asarray(candidate, dtype=float), np.asarray(reference, dtype=float)
    if candidate.ndim != 1 or reference.shape != candidate.shape:
        raise ValueError('paired observations must have matching one-dimensional shapes')
    groups = _groups(groups, len(candidate))
    if not np.isfinite(candidate).all() or not np.isfinite(reference).all():
        raise ValueError('paired observations must be finite')
    members = defaultdict(list)
    for index, group in enumerate(groups):
        members[group].append(index)
    keys = sorted(members)
    means = np.array([
        [candidate[members[key]].mean(), reference[members[key]].mean()] for key in keys
    ])
    return keys, means


def paired_group_bootstrap(groups, candidate, reference, *, statistic='difference',
                           confidence=.95, resamples=10000, seed=41):
    """Whole-group paired percentile interval with equal original-group weights."""
    confidence = _confidence(confidence)
    candidate, reference = list(candidate), list(reference)
    keys, means = _group_means(groups, candidate, reference)
    if len(keys) < 2:
        raise ValueError('a group bootstrap requires at least two independent groups')
    if isinstance(resamples, bool) or not isinstance(resamples, int) or resamples < 100:
        raise ValueError('at least 100 bootstrap resamples are required')
    if statistic not in ['difference', 'reduction']:
        raise ValueError('unknown paired statistic')
    if statistic == 'reduction' and (np.any(np.asarray(candidate) <= 0)
                                     or np.any(np.asarray(reference) <= 0)):
        raise ValueError('token reduction requires positive reported token totals')

    def calculate(values):
        if statistic == 'difference':
            return values[..., 0] - values[..., 1]
        return 1 - values[..., 0] / values[..., 1]

    rng = np.random.default_rng(seed)
    draws = np.empty(resamples)
    # Bounded batches avoid allocating resamples × all groups at once.
    for offset in range(0, resamples, 256):
        size = min(256, resamples - offset)
        sampled = rng.integers(0, len(keys), size=(size, len(keys)))
        draws[offset:offset + size] = calculate(means[sampled].mean(axis=1))
    alpha = 1 - confidence
    return {
        'estimate': float(calculate(means.mean(axis=0))),
        'interval': np.quantile(draws, [alpha / 2, 1 - alpha / 2]).tolist(),
        'confidence': confidence,
        'groups': len(keys),
        'rows': len(candidate),
        'weighting': 'equal-group',
        'method': 'paired whole-group percentile bootstrap',
        'statistic': statistic,
        'resamples': resamples,
        'seed': seed,
    }


def meeting_comparison(rows, candidate, reference, **bootstrap_options):
    """Compare applied recipient maps. None/malformed outputs count as failures.

    A model's null result must first be resolved through its actual runtime fallback;
    this helper does not turn null into an implicit all-participants decision.
    """
    rows = list(rows)
    ids = _row_ids(rows)
    if set(candidate) != set(ids) or set(reference) != set(ids):
        raise ValueError('recipient prediction IDs must match rows exactly')
    groups = _groups([row.get('group') for row in rows], len(rows))
    if any(row.get('task') != 'meeting' for row in rows):
        raise ValueError('meeting comparison accepts only meeting rows')

    def scores(predictions):
        correct, forbidden = [], []
        for row in rows:
            selected = predictions[row['id']]
            roster = {person['id'] for person in row['input']['participants']}
            is_ids = isinstance(selected, list) and all(isinstance(x, str) for x in selected)
            selected_set = set(selected) if is_ids else set()
            well_formed = is_ids and len(selected_set) == len(selected) and selected_set <= roster
            correct.append(bool(well_formed and valid_dispatch(selected, row['target'])))
            forbidden.append(bool(selected_set & set(row['target']['excludedIds'])))
        return correct, forbidden

    candidate_scores, candidate_forbidden = scores(candidate)
    reference_scores, reference_forbidden = scores(reference)
    _, means = _group_means(groups, candidate_scores, reference_scores)
    return {
        'delta': paired_group_bootstrap(
            groups, candidate_scores, reference_scores, **bootstrap_options,
        ),
        'candidateRate': float(means[:, 0].mean()),
        'referenceRate': float(means[:, 1].mean()),
        'candidateForbidden': sum(candidate_forbidden),
        'referenceForbidden': sum(reference_forbidden),
    }


def _cp_lower(successes, trials, alpha):
    return 0. if successes == 0 else float(beta.ppf(alpha, successes, trials - successes + 1))


def _cp_upper(successes, trials, alpha):
    return 1. if successes == trials else float(beta.ppf(1 - alpha, successes + 1, trials - successes))


def paired_outcome_report(trials, *, expected_groups, confidence=.95,
                          resamples=10000, seed=41):
    """Two paired repeats per frozen family; statistical gates only, not promotion."""
    confidence = _confidence(confidence)
    trials, expected_groups = list(trials), list(expected_groups)
    _groups(expected_groups, len(expected_groups))
    if len(set(expected_groups)) != len(expected_groups):
        raise ValueError('the expected family manifest must not contain duplicates')
    by_group = defaultdict(dict)
    for trial in trials:
        group, repeat = trial.get('group'), trial.get('repeat')
        if group not in expected_groups:
            raise ValueError('trial family is not in the frozen expected family manifest')
        if isinstance(repeat, bool) or not isinstance(repeat, int) or repeat not in [0, 1]:
            raise ValueError('exactly repeat zero and one are supported')
        if repeat in by_group[group]:
            raise ValueError('duplicate family/repeat pair')
        for field in ['candidatePassed', 'referencePassed']:
            if not isinstance(trial.get(field), (bool, np.bool_)):
                raise ValueError('paired success must be explicitly Boolean')
        for field in ['candidateTotalTokens', 'referenceTotalTokens']:
            value = trial.get(field)
            if (isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer))
                    or value <= 0):
                raise ValueError('each trial requires positive integer reported total tokens')
        by_group[group][repeat] = trial
    if set(by_group) != set(expected_groups):
        raise ValueError('one or more expected families has no paired outcomes')
    if any(set(repeats) != {0, 1} for repeats in by_group.values()):
        raise ValueError('every family requires both paired repeats')
    ordered = [by_group[group][repeat] for group in sorted(by_group) for repeat in [0, 1]]
    candidate = np.array([trial['candidatePassed'] for trial in ordered], dtype=float).reshape(-1, 2)
    reference = np.array([trial['referencePassed'] for trial in ordered], dtype=float).reshape(-1, 2)
    difference = candidate - reference
    family_delta = difference.mean(axis=1)
    count = len(by_group)
    positive, negative = int((family_delta > 0).sum()), int((family_delta < 0).sum())
    alpha = 1 - confidence
    bound_a = -_cp_upper(negative, count, alpha / 2)
    bound_b = .5 * _cp_lower(positive, count, alpha / 4) - _cp_upper(negative, count, alpha / 4)
    lower = max(bound_a, bound_b)
    tokens = paired_group_bootstrap(
        [trial['group'] for trial in ordered],
        [trial['candidateTotalTokens'] for trial in ordered],
        [trial['referenceTotalTokens'] for trial in ordered], statistic='reduction',
        confidence=confidence, resamples=resamples, seed=seed,
    )
    enough = count >= 200
    confidence_sufficient = confidence >= .95
    noninferior = lower >= -.02
    # A tiny numerical tolerance only covers binary floating point for 10% exactly.
    saves_tokens = tokens['estimate'] >= .10 - 1e-12 and tokens['interval'][0] > 0
    return {
        'families': count,
        'pairedTrials': len(ordered),
        'repeatsPerFamily': 2,
        'candidateSuccess': float(candidate.mean()),
        'referenceSuccess': float(reference.mean()),
        'successDelta': float(family_delta.mean()),
        'successLower': lower,
        'oneSidedConfidence': confidence,
        'positiveFamilies': positive,
        'negativeFamilies': negative,
        'zeroDifferenceFamilies': count - positive - negative,
        'anyLossFamilies': int((difference < 0).any(axis=1).sum()),
        'boundA': bound_a,
        'boundB': bound_b,
        'successMethod': 'simultaneous conservative Clopper-Pearson family bounds',
        'tokenReduction': tokens,
        'enoughFamilies': enough,
        'confidenceSufficient': confidence_sufficient,
        'successNoninferiority': noninferior,
        'tokenGate': bool(saves_tokens),
        'passesStatisticalGate': bool(
            enough and confidence_sufficient and noninferior and saves_tokens
        ),
    }
