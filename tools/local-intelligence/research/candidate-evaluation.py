#!/usr/bin/env python3
"""Native C/P comparison. Default CLI never opens H or executable worker outcomes.

Final reuse requires explicit unseal plus a pre-existing model/temperature freeze;
temperature fitting itself always remains C-only. No model inference occurs here.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess

import numpy as np

from evaluation import classification_metrics, fit_temperature, paired_group_bootstrap
from metrics import LEVELS, valid_dispatch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _phase(split, unseal_final=False, freeze=None):
    if split not in ('calibration', 'policy', 'final'):
        raise ValueError('only declared evaluation partitions are accepted')
    if split == 'final':
        if not unseal_final or not isinstance(freeze, dict):
            raise ValueError('final remains sealed without explicit unseal and frozen model/calibration')
        if (not isinstance(freeze.get('modelSha256'), str) or len(freeze['modelSha256']) != 64
                or not isinstance(freeze.get('temperature'), (int, float)) or freeze['temperature'] <= 0
                or not isinstance(freeze.get('frozenAt'), str)):
            raise ValueError('final evaluation requires a concrete model and temperature freeze')
        frozen = datetime.fromisoformat(freeze['frozenAt'].replace('Z', '+00:00'))
        if frozen.tzinfo is None or frozen >= datetime.now(timezone.utc):
            raise ValueError('final model/calibration must already be frozen')


def read_dataset(path, split, *, unseal_final=False, freeze=None):
    _phase(split, unseal_final, freeze)
    path = Path(path)
    if path.name != f'{split}.jsonl':
        raise ValueError('dataset filename must match its declared partition')
    raw = path.read_bytes()
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if not rows or any(row.get('split') != split for row in rows):
        raise ValueError('mixed or mislabeled evaluation partitions')
    ids = [row.get('id') for row in rows]
    if any(not isinstance(key, str) or not key for key in ids) or len(set(ids)) != len(ids):
        raise ValueError('evaluation IDs must be present and unique')
    return rows, sha(raw)


def check_report(rows, report, source_hash, *, native=True):
    if report.get('inputSha256') != source_hash:
        raise ValueError('prediction source hash differs from the exact evaluation dataset')
    if native and report.get('complete') is not True:
        raise ValueError('native prediction report is incomplete')
    predictions = report.get('predictions', [])
    ids = [prediction.get('id') for prediction in predictions]
    if len(ids) != len(set(ids)) or set(ids) != {row['id'] for row in rows}:
        raise ValueError('prediction IDs must match evaluation IDs exactly once')
    lookup = {prediction['id']: prediction for prediction in predictions}
    for row in rows:
        prediction = lookup[row['id']]
        if prediction.get('task') != row['task'] or (native and prediction.get('group') != row['group']):
            raise ValueError('prediction task/group differs from the evaluated row')
    return lookup


def check_native_pair(first, second):
    for key in ('helperSha256', 'tokenizerSha256', 'backend', 'normalizer', 'contextTokens', 'inputBudget'):
        if first.get(key) != second.get(key):
            raise ValueError('quantized candidates used different native input/runtime configurations')
    lookup = {prediction['id']: prediction for prediction in second['predictions']}
    for prediction in first['predictions']:
        other = lookup[prediction['id']]
        if prediction['result'].get('type') == other['result'].get('type') == 'result':
            for key in ('inputTokenFingerprint', 'originalPromptTokens', 'usedPromptTokens'):
                if prediction['result'].get(key) is None or prediction['result'].get(key) != other['result'].get(key):
                    raise ValueError('quantized candidates did not receive identical tokenized inputs')


def _weights(rows):
    counts = Counter(row['group'] for row in rows)
    return np.array([1 / counts[row['group']] / len(counts) for row in rows])


def _deadline(prediction, task):
    seconds = prediction.get('seconds')
    if not isinstance(seconds, (int, float)) or not np.isfinite(seconds) or seconds < 0:
        raise ValueError('native latency is missing or invalid')
    return bool(prediction.get('deadlineMiss')) or seconds >= (3. if task == 'effort' else 1.5)


def _effort_logits(prediction):
    result = prediction.get('result', {})
    if result.get('type') != 'result' or _deadline(prediction, 'effort'):
        return None
    values = result.get('logits')
    if not isinstance(values, list) or len(values) != 4 or not np.isfinite(np.asarray(values, dtype=float)).all():
        return None
    return np.asarray(values, dtype=float)


def _probabilities(logits, temperature):
    if not np.isfinite(temperature) or temperature <= 0:
        raise ValueError('temperature must be positive and finite')
    values = np.exp((logits - logits.max()) / temperature)
    return values / values.sum()


def core_decisions(probabilities, kind='identity'):
    if not probabilities:
        return []
    module = (HERE / 'effort-policies.ts').as_uri()
    script = f'''import {{readFileSync}} from 'node:fs';
import {{applyEffortPolicy}} from {json.dumps(module)};
const x=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify(x.probabilities.map(p=>applyEffortPolicy(p,{{kind:x.kind}}))));'''
    process = subprocess.run([os.environ.get('CORRAL_RESEARCH_NODE', 'node'), '--input-type=module', '-e', script],
                             input=json.dumps({'probabilities': probabilities, 'kind': kind}),
                             text=True, capture_output=True, check=True, timeout=60)
    return json.loads(process.stdout)


def effort_decisions(rows, predictions, temperature, *, effort_fallback=None):
    decisions = []; answered = []; probabilities = []
    for row, prediction in zip(rows, predictions):
        logits = _effort_logits(prediction)
        if logits is None:
            fallback = row.get('runtimeFallback', {}).get('effort', effort_fallback)
            if fallback not in LEVELS:
                raise ValueError('native effort failure needs an explicit actual base-effort fallback')
            decisions.append({'id': row['id'], 'raw': None, 'applied': fallback, 'probabilities': None,
                              'modelAbstention': False, 'coreReview': False, 'nativeFailureFallback': True})
        else:
            probability = _probabilities(logits, temperature).tolist()
            answered.append(len(decisions)); probabilities.append(probability)
            decisions.append({'id': row['id'], 'raw': LEVELS[int(logits.argmax())], 'probabilities': probability,
                              'modelAbstention': False, 'nativeFailureFallback': False})
    for index, applied in zip(answered, core_decisions(probabilities)):
        decisions[index].update({'applied': applied['appliedLevel'], 'coreReview': applied['abstention']})
    return decisions


def meeting_decision(row, prediction, context=None):
    context = context or row.get('runtimeFallback', {})
    roster = [person['id'] for person in row['input']['participants']]
    result = prediction.get('result', {}); selected = result.get('participantIds')
    well_formed = (result.get('type') == 'result' and isinstance(selected, list)
                   and all(isinstance(key, str) for key in selected)
                   and len(set(selected)) == len(selected) and set(selected) <= set(roster))
    if well_formed and not _deadline(prediction, 'meeting'):
        return {'raw': selected, 'applied': selected, 'fallback': False, 'assumedRoundZero': False}
    # Mirrors core Meeting.executeRound failure fallback. Gold target fields are
    # deliberately unavailable to this choice; no semantic oracle exclusions.
    allowed = [key for key in context.get('allowedParticipantIds', roster) if key in roster and key != 'secretary']
    reply = context.get('replyTargetId')
    recent = next((turn['speakerId'] for turn in reversed(row['input']['turns'])
                   if turn.get('speakerId') in allowed), None)
    assumed = False
    if reply in allowed:
        chosen = reply
    elif recent is not None:
        chosen = recent
    elif allowed:
        turn = context.get('allRoundCount', 0); assumed = 'allRoundCount' not in context
        if type(turn) is not int or turn < 0:
            raise ValueError('meeting fallback round counter is invalid')
        chosen = allowed[turn % len(allowed)]
    else:
        chosen = None
    return {'raw': None, 'applied': [chosen] if chosen else [], 'fallback': True, 'assumedRoundZero': assumed}


def level_metrics(rows, levels):
    targets = np.array([LEVELS.index(row['target']['level']) for row in rows])
    predicted = np.array([LEVELS.index(level) if level in LEVELS else -1 for level in levels])
    answered = predicted >= 0; weights = _weights(rows)
    strict = predicted == targets
    acceptable = np.array([level in row['target']['acceptableLevels'] for row, level in zip(rows, levels)])
    return {'count': len(rows), 'groups': len({row['group'] for row in rows}),
            'strictCorrect': int(strict.sum()), 'strictAccuracy': float(np.dot(weights, strict)),
            'acceptableCorrect': int(acceptable.sum()), 'acceptableAccuracy': float(np.dot(weights, acceptable)),
            'noDecision': int((~answered).sum()),
            'ordinalMeanOnAnswered': float(np.average(np.abs(predicted[answered] - targets[answered]), weights=weights[answered])) if answered.any() else None,
            'signedLevelErrorOnAnswered': float(np.average(predicted[answered] - targets[answered], weights=weights[answered])) if answered.any() else None,
            'severeUnder': int(((predicted == 0) & (targets >= 2)).sum()),
            'severeOver': int(((predicted >= 2) & (targets == 0)).sum()),
            'strictByRow': strict.tolist(), 'acceptableByRow': acceptable.tolist()}


def dispatch_metrics(rows, selections):
    valid = []; forbidden = []; calls = []; by_mode = {}; predicted_none = []; target_none = []
    for row, selected in zip(rows, selections):
        roster = {person['id'] for person in row['input']['participants']}
        well_formed = (isinstance(selected, list) and all(isinstance(key, str) for key in selected)
                       and len(set(selected)) == len(selected) and set(selected) <= roster)
        keys = set(selected) if well_formed else set()
        correct = bool(well_formed and valid_dispatch(selected, row['target']))
        excluded = bool(keys & set(row['target']['excludedIds']))
        valid.append(correct); forbidden.append(excluded); calls.append(len(keys))
        predicted_none.append(well_formed and not keys); target_none.append(row['target']['mode'] == 'none')
        mode = by_mode.setdefault(row['target']['mode'], {'count': 0, 'correct': 0, 'forbidden': 0})
        mode['count'] += 1; mode['correct'] += int(correct); mode['forbidden'] += int(excluded)
    weights = _weights(rows); none_true = np.array(target_none); none_pred = np.array(predicted_none)
    return {'count': len(rows), 'groups': len({row['group'] for row in rows}),
            'validCount': sum(valid), 'validDispatch': float(np.dot(weights, valid)),
            'forbiddenDispatch': sum(forbidden), 'forbiddenRate': float(np.dot(weights, forbidden)),
            'meanCalls': float(np.dot(weights, calls)), 'byMode': by_mode,
            'none': {'target': int(none_true.sum()), 'predicted': int(none_pred.sum()),
                     'correct': int((none_true & none_pred).sum()),
                     'falseSilence': int((~none_true & none_pred).sum()),
                     'missedSilence': int((none_true & ~none_pred).sum())},
            'validByRow': valid, 'forbiddenByRow': forbidden}


def calibrate(rows, report):
    if any(row.get('split') != 'calibration' for row in rows):
        raise ValueError('only C can fit temperatures')
    effort = [row for row in rows if row['task'] == 'effort']
    lookup = {prediction['id']: prediction for prediction in report['predictions']}
    predictions = []
    for row in effort:
        logits = _effort_logits(lookup[row['id']])
        if logits is None:
            raise ValueError('calibration prediction failed; do not silently fit a complete-case subset')
        predictions.append({'id': row['id'], 'logits': logits.tolist()})
    return fit_temperature(effort, predictions)


def native_metrics(rows, report, temperature, *, split='policy', unseal_final=False, freeze=None, effort_fallback=None):
    _phase(split, unseal_final, freeze)
    if any(row.get('split') != split for row in rows):
        raise ValueError('metrics received another partition')
    if split == 'final' and (freeze['modelSha256'] != report['modelSha256'] or freeze['temperature'] != temperature):
        raise ValueError('final predictions/calibration differ from the frozen winner')
    lookup = {prediction['id']: prediction for prediction in report['predictions']}
    effort = [row for row in rows if row['task'] == 'effort']; meeting = [row for row in rows if row['task'] == 'meeting']
    ed = effort_decisions(effort, [lookup[row['id']] for row in effort], temperature, effort_fallback=effort_fallback)
    md = [meeting_decision(row, lookup[row['id']]) for row in meeting]
    answered_rows = [row for row, decision in zip(effort, ed) if decision['probabilities'] is not None]
    answered_logits = [_effort_logits(lookup[row['id']]) for row in answered_rows]
    probability_metrics = classification_metrics(
        answered_logits, [LEVELS.index(row['target']['level']) for row in answered_rows],
        temperature=temperature, weights=_weights(answered_rows),
    ) if answered_rows else None
    return {'effort': {'raw': level_metrics(effort, [decision['raw'] for decision in ed]),
                       'appliedCoreGuard': level_metrics(effort, [decision['applied'] for decision in ed]),
                       'calibration': probability_metrics, 'modelAbstentions': 0,
                       'coreReviews': sum(decision['coreReview'] for decision in ed),
                       'failureFallbacks': sum(decision['nativeFailureFallback'] for decision in ed), 'predictions': ed},
            'meeting': {**dispatch_metrics(meeting, [decision['applied'] for decision in md]),
                        'fallbacks': sum(decision['fallback'] for decision in md),
                        'assumedRoundZeroFallbacks': sum(decision['assumedRoundZero'] for decision in md),
                        'predictions': [{'id': row['id'], **decision} for row, decision in zip(meeting, md)]}}


def runtime_stats(rows, report):
    lookup = {prediction['id']: prediction for prediction in report['predictions']}; tasks = {}
    for task in ('effort', 'meeting'):
        selected = [lookup[row['id']] for row in rows if row['task'] == task]
        latency = np.array([prediction['seconds'] * 1000 for prediction in selected])
        originals = [prediction['result']['originalPromptTokens'] for prediction in selected if 'originalPromptTokens' in prediction['result']]
        tasks[task] = {'count': len(selected), 'nativeErrors': sum(prediction['result'].get('type') != 'result' for prediction in selected),
                       'deadlineMisses': sum(_deadline(prediction, task) for prediction in selected),
                       'truncated': sum(bool(prediction['result'].get('inputTruncated')) for prediction in selected),
                       'tokenCountsAvailable': len(originals), 'maxOriginalTokens': max(originals) if originals else None,
                       'latencyMs': {'p50': float(np.quantile(latency, .5)), 'p95': float(np.quantile(latency, .95)),
                                     'p99': float(np.quantile(latency, .99)), 'max': float(latency.max())}}
    return {'tasks': tasks, 'loadSeconds': report.get('loadSeconds'), 'warmup': report.get('warmup'),
            'scope': 'recorded native subprocess round trip after warmup; contention was not isolated or controlled'}


def quantization_rule(effort_delta, meeting_delta):
    point = all(value['estimate'] >= -.01 - 1e-12 for value in (effort_delta, meeting_delta))
    interval = all(value['interval'][0] >= -.01 - 1e-12 for value in (effort_delta, meeting_delta))
    return {'rule': 'prefer smaller Q4 only when loss is no more than 1pp on BOTH roles',
            'effortMetric': 'raw strict difficulty agreement', 'meetingMetric': 'applied valid dispatch',
            'pointRuleSatisfied': point, 'bootstrapIntervalsWithinMargin': interval,
            'status': 'point-rule-fails' if not point else 'point-rule-passes-bootstrap-support' if interval else 'point-rule-passes-uncertain',
            'selectedQuantization': None,
            'limitation': 'P effort has few original groups; a zero-width no-discordance bootstrap does not prove population equivalence'}


def select_strongest_reference(references, split):
    if split != 'policy':
        raise ValueError('strongest reference must be selected on P, never H')
    return min(references, key=lambda name: (-references[name]['validDispatch'], references[name]['forbiddenRate'], name))


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--root', required=True); parser.add_argument('--out', required=True)
    args = parser.parse_args(); root = Path(args.root); output = Path(args.out)
    if output.exists():
        raise ValueError('immutable C/P evaluation output already exists')
    sources = {}; rows = {}; input_hashes = {}; native = {}; temperatures = {}; results = {}

    def read(path):
        raw = path.read_bytes(); sources[str(path.relative_to(root))] = sha(raw)
        return json.loads(raw)

    selection = read(root / 'runs/final-export/f-selection.json')
    views = read(root / 'reports/native-agent/runtime-views-receipts.json')
    for split in ('calibration', 'policy'):
        path = root / f'data/cohort-002-audited/{split}.jsonl'
        rows[split], input_hashes[split] = read_dataset(path, split)
        sources[str(path.relative_to(root))] = input_hashes[split]
        view = views[split]
        if (view['sourceSha256'] != input_hashes[split] or view['rowCount'] != len(rows[split])
                or view['exactPromptMatchCount'] != len(rows[split]) or view['modelToOriginalIdsIdentity'] is not True):
            raise ValueError('candidate runtime input is not exactly equivalent to evaluated C/P input')
    for quant in ('q8', 'q4'):
        native[quant] = {}
        for split in ('calibration', 'policy'):
            report = read(root / f'reports/final-{quant}-{split}.json')
            check_report(rows[split], report, input_hashes[split]); native[quant][split] = report
        for key in ('modelSha256', 'helperSha256', 'tokenizerSha256', 'normalizer', 'backend', 'contextTokens', 'inputBudget'):
            if native[quant]['calibration'].get(key) != native[quant]['policy'].get(key):
                raise ValueError('C and P used different native candidate configurations')
        temperatures[quant] = calibrate(rows['calibration'], native[quant]['calibration'])
        results[quant] = {split: native_metrics(rows[split], native[quant][split], temperatures[quant]['temperature'], split=split)
                          for split in ('calibration', 'policy')}
    for split in ('calibration', 'policy'):
        check_native_pair(native['q8'][split], native['q4'][split])
    policy_rows = rows['policy']; effort_rows = [row for row in policy_rows if row['task'] == 'effort']; meeting_rows = [row for row in policy_rows if row['task'] == 'meeting']
    paired = {}
    for task, field, selected in [('effort', 'strictByRow', effort_rows), ('meeting', 'validByRow', meeting_rows)]:
        left = results['q4']['policy'][task]; right = results['q8']['policy'][task]
        if task == 'effort':
            left, right = left['raw'], right['raw']
        a, b = np.array(left[field]), np.array(right[field])
        paired[task] = {**paired_group_bootstrap([row['group'] for row in selected], a, b),
                        'q4OnlyCorrect': int((a & ~b).sum()), 'q8OnlyCorrect': int((~a & b).sum()),
                        'bothCorrect': int((a & b).sum()), 'bothWrong': int((~a & ~b).sum())}
    old_baseline = read(root / 'reports/baseline-policy.json')
    check_report(policy_rows, old_baseline, input_hashes['policy'], native=False)
    baseline = read(root / 'reports/baseline-policy-v2.json')
    lookup = check_report(policy_rows, baseline, input_hashes['policy'], native=False)
    reference_names = sorted(lookup[meeting_rows[0]['id']]['references'])
    references = {'legacyShipped': dispatch_metrics(meeting_rows, [lookup[row['id']]['applied'] for row in meeting_rows])}
    for name in reference_names:
        references[name] = dispatch_metrics(meeting_rows, [lookup[row['id']]['references'][name] for row in meeting_rows])
    strongest = select_strongest_reference(references, 'policy')
    baseline_comparisons = {
        quant: {name: paired_group_bootstrap([row['group'] for row in meeting_rows],
                                            results[quant]['policy']['meeting']['validByRow'], metrics['validByRow'])
                for name, metrics in references.items()} for quant in ('q8', 'q4')}
    baseline_effort = {'raw': level_metrics(effort_rows, [lookup[row['id']]['raw'] for row in effort_rows]),
                       'applied': level_metrics(effort_rows, [lookup[row['id']]['applied'] for row in effort_rows])}
    supplied = read(root / 'runs/reference-upstream-v1/policy.predictions.json')
    supplied_predictions = supplied['predictions']; supplied_ids = [prediction['id'] for prediction in supplied_predictions]
    if (supplied['metadata']['sourceInputSha256'] != input_hashes['policy'] or len(set(supplied_ids)) != len(supplied_ids)
            or set(supplied_ids) != {row['id'] for row in effort_rows}):
        raise ValueError('supplied reference must match exact P effort inputs and IDs')
    supplied_lookup = {prediction['id']: prediction for prediction in supplied_predictions}
    probabilities = [supplied_lookup[row['id']]['probabilities'] for row in effort_rows]
    for row, probability in zip(effort_rows, probabilities):
        prediction = supplied_lookup[row['id']]
        if prediction['group'] != row['group'] or not np.allclose(_probabilities(np.asarray(prediction['logits']), supplied['runtime']['temperature']), probability, atol=1e-7):
            raise ValueError('supplied reference probabilities/group do not match its fixed calibration')
    asymmetric = core_decisions(probabilities, 'asymmetric')
    reference_effort = {'raw': level_metrics(effort_rows, [LEVELS[int(np.argmax(p))] for p in probabilities]),
                        'suppliedAsymmetric': level_metrics(effort_rows, [decision['appliedLevel'] for decision in asymmetric]),
                        'temperature': supplied['runtime']['temperature'], 'temperatureFitOnP': False,
                        'runtime': supplied['runtime'], 'metadata': supplied['metadata'], 'preparedSha256': supplied['preparedSha256']}
    reference_freeze = {'selectedOn': 'policy', 'name': strongest, 'frozenAt': datetime.now(timezone.utc).isoformat(),
                        'sourceInputSha256': input_hashes['policy'],
                        'sourceReportSha256': sources['reports/baseline-policy-v2.json'],
                        'selectionRule': 'highest group-weighted valid dispatch; then fewer exclusions; then stable name',
                        'scope': 'strong accuracy reference; additional history embedding cost is not treated as identical'}
    report = {'scope': 'C/P synthetic teacher-label and valid-dispatch comparison; no H or worker outcomes opened',
              'selection': selection, 'provenanceHashes': sources,
              'sourceCodeHashes': {str(path.relative_to(REPO)): sha(path.read_bytes()) for path in
                                   [Path(__file__), HERE / 'evaluation.py', HERE / 'effort-policies.ts',
                                    REPO / 'packages/core/src/meeting.ts', REPO / 'packages/core/src/reasoning-risk.ts']},
              'runtimeViewEvidence': {split: views[split] for split in ('calibration', 'policy')},
              'nativeConfigurations': {quant: {key: value for key, value in native[quant]['policy'].items()
                                               if key not in ('predictions', 'warmup')} for quant in ('q8', 'q4')},
              'calibration': temperatures, 'metrics': results, 'pairedQ4MinusQ8': paired,
              'quantizationRule': quantization_rule(paired['effort'], paired['meeting']),
              'runtime': {quant: {split: runtime_stats(rows[split], native[quant][split]) for split in ('calibration', 'policy')}
                          for quant in ('q8', 'q4')},
              'baselineEffort': baseline_effort, 'suppliedReferenceEffort': reference_effort,
              'meetingReferences': references, 'meetingBaselineFreeze': reference_freeze,
              'meetingComparisons': baseline_comparisons, 'complete': True}
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n'); output.chmod(0o600)
    freeze_path = output.with_suffix('.meeting-reference.json')
    with freeze_path.open('x') as handle:
        json.dump(reference_freeze, handle, indent=2)
    freeze_path.chmod(0o600)
    print(json.dumps({'temperatures': {quant: value['temperature'] for quant, value in temperatures.items()},
                      'pairedQ4MinusQ8': paired, 'quantization': report['quantizationRule'], 'strongestMeetingReference': strongest}, indent=2))


if __name__ == '__main__':
    main()
