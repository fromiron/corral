#!/usr/bin/env python3
"""Coding effort gates. Constant medium is the reference; time per success is the primary metric.

`evaluation.py` stays as the frozen final evaluations pinned it; this module only reads its bounds.
"""
import argparse
from collections import defaultdict
import statistics

import numpy as np

from evaluation import _confidence, paired_outcome_report

SUCCESS_MARGIN = .05
REQUIRED_FAMILIES = 110
SCREEN_RATE = .05
SCREEN_EFFORTS = ('low', 'medium', 'high', 'xhigh')
TABLE_FAMILIES = (24, 48, 72, 110, 150, 200, 300, 400)


def loss_bound(families, losses, gains=0):
    """Success lower bound of the frozen report for this many net-loss and net-gain families."""
    trials = []
    names = [f'family-{index:04d}' for index in range(families)]
    for index, name in enumerate(names):
        candidate, reference = index >= losses, not losses <= index < losses + gains
        trials += [{'group': name, 'repeat': repeat, 'candidatePassed': candidate,
                    'referencePassed': reference, 'candidateTotalTokens': 1,
                    'referenceTotalTokens': 1} for repeat in [0, 1]]
    return paired_outcome_report(trials, expected_groups=names, resamples=100)['successLower']


def _seconds(value):
    return (not isinstance(value, (bool, np.bool_))
            and isinstance(value, (int, float, np.integer, np.floating))
            and bool(np.isfinite(value)) and value > 0)


def _time_reduction(trials, confidence, resamples, seed):
    """Whole-family paired interval of the cut in wall seconds per success, failed runs included."""
    members = defaultdict(lambda: np.zeros(4))
    for trial in trials:
        members[trial['group']] += [trial['candidateWallSeconds'], trial['candidatePassed'],
                                    trial['referenceWallSeconds'], trial['referencePassed']]
    totals = np.array([members[key] for key in sorted(members)])

    def calculate(values):
        with np.errstate(divide='ignore', invalid='ignore'):
            reduction = 1 - values[..., 0] * values[..., 3] / (values[..., 1] * values[..., 2])
        return np.nan_to_num(reduction, nan=-np.inf)

    rng = np.random.default_rng(seed)
    draws = np.empty(resamples)
    for offset in range(0, resamples, 256):
        size = min(256, resamples - offset)
        sampled = rng.integers(0, len(totals), size=(size, len(totals)))
        draws[offset:offset + size] = calculate(totals[sampled].sum(axis=1))
    alpha = 1 - confidence
    return {
        'estimate': float(calculate(totals.sum(axis=0))),
        'interval': np.quantile(draws, [alpha / 2, 1 - alpha / 2], method='inverted_cdf').tolist(),
        'confidence': confidence,
        'families': len(totals),
        'method': 'paired whole-family percentile bootstrap of seconds per success',
        'resamples': resamples,
        'seed': seed,
    }


def coding_gate_report(trials, *, expected_groups, confidence=.95, resamples=10000, seed=41):
    """A candidate against constant medium on frozen families, two paired repeats each."""
    confidence = _confidence(confidence)
    trials = list(trials)
    if not all(_seconds(trial.get(field)) for trial in trials
               for field in ['candidateWallSeconds', 'referenceWallSeconds']):
        raise ValueError('each trial requires positive wall seconds')
    paired = paired_outcome_report(trials, expected_groups=expected_groups, confidence=confidence,
                                   resamples=resamples, seed=seed)
    time = _time_reduction(trials, confidence, resamples, seed)
    enough = paired['families'] >= REQUIRED_FAMILIES
    noninferior = paired['successLower'] >= -SUCCESS_MARGIN
    faster = time['interval'][0] > 0
    kept = ['families', 'pairedTrials', 'repeatsPerFamily', 'candidateSuccess', 'referenceSuccess',
            'successDelta', 'successLower', 'oneSidedConfidence', 'positiveFamilies',
            'negativeFamilies', 'zeroDifferenceFamilies', 'anyLossFamilies', 'boundA', 'boundB',
            'successMethod', 'tokenReduction']
    return {
        **{key: paired[key] for key in kept},
        'reference': 'constant medium',
        'timeReduction': time,
        'enoughFamilies': enough,
        'confidenceSufficient': confidence >= .95,
        'successNoninferiority': noninferior,
        'timeGate': faster,
        'passesGate': bool(enough and confidence >= .95 and noninferior and faster),
    }


def screening_report(rows, *, tasks, model):
    """One model, one run per level per frozen task. Failed runs stay in the denominator."""
    tasks = list(tasks)
    runs = {}
    for row in rows:
        if row['task'] not in tasks or row['model'] != model or row['effort'] not in SCREEN_EFFORTS:
            raise ValueError('run is not in the frozen task list')
        key = row['task'], row['effort']
        if key in runs:
            raise ValueError('duplicate run; a started run is never replayed')
        runs[key] = row
    counts = dict.fromkeys(['all', 'highRaised', 'xhighOnly', 'mediumOnly', 'mixed', 'none', 'invalid',
                            'lowLost'], 0)
    for task in tasks:
        task_runs = [runs.get((task, effort)) for effort in SCREEN_EFFORTS]
        if None in task_runs:
            raise ValueError('every task needs every level')
        low, medium, high, xhigh = task_runs
        if any(row['state'] != 'complete' for row in task_runs):
            counts['invalid'] += 1
            continue
        if not low['passed'] and (medium['passed'] or high['passed'] or xhigh['passed']):
            counts['lowLost'] += 1
        if medium['passed'] and high['passed'] and xhigh['passed']:
            counts['all'] += 1
        elif high['passed'] and not medium['passed']:
            counts['highRaised'] += 1
        elif xhigh['passed'] and not medium['passed']:
            counts['xhighOnly'] += 1
        elif medium['passed'] and not high['passed'] and not xhigh['passed']:
            counts['mediumOnly'] += 1
        elif medium['passed']:
            counts['mixed'] += 1
        else:
            counts['none'] += 1
    by_effort = {}
    for effort in SCREEN_EFFORTS:
        selected = [runs[task, effort] for task in tasks]
        by_effort[effort] = {
            'passed': sum(bool(row['passed']) for row in selected),
            'medianWallSeconds': statistics.median(row['wallSeconds'] for row in selected),
            'totalWallSeconds': sum(row['wallSeconds'] for row in selected),
            'totalTokens': sum(row['totalTokens'] for row in selected),
        }
    high_rate = counts['highRaised'] / len(tasks)
    xhigh_rate = counts['xhighOnly'] / len(tasks)
    return {'model': model, 'tasks': len(tasks), **counts, 'highRaisedRate': high_rate,
            'xhighOnlyRate': xhigh_rate, 'highReachesThreshold': high_rate >= SCREEN_RATE,
            'xhighReachesThreshold': xhigh_rate >= SCREEN_RATE, 'byEffort': by_effort}


def screening_decision(sol, luna=None):
    """The fixed Phase 2 rule; an unsettled run stops it instead of counting as no difference."""
    models = [sol, luna] if luna else [sol]
    if any(model['invalid'] for model in models):
        return 'incomplete'
    if any(model['highReachesThreshold'] for model in models):
        return 'try-constant-high'
    if any(model['xhighReachesThreshold'] for model in models):
        return 'phase-3'
    return 'close-adaptive' if luna else 'run-stage-c'


def main():
    parser = argparse.ArgumentParser(description='Print the success lower bound per net-loss family.')
    parser.add_argument('--losses', type=int, default=5)
    args = parser.parse_args()
    print('| Families | ' + ' | '.join(f'{count} lost' for count in range(args.losses + 1)) + ' |')
    print('|---:|' + '---:|' * (args.losses + 1))
    for families in TABLE_FAMILIES:
        cells = [f'{100 * loss_bound(families, count):.1f}' for count in range(args.losses + 1)]
        print(f'| {families} | ' + ' | '.join(cells) + ' |')


if __name__ == '__main__':
    main()
