#!/usr/bin/env python3
"""Score frozen meeting H populations without fitting or selecting anything on H."""
import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

from evaluation import paired_group_bootstrap

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
spec = importlib.util.spec_from_file_location('candidate_evaluation', HERE / 'candidate-evaluation.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def file_sha(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def validate_target(row, target):
    roster = {person['id'] for person in row['input']['participants']}
    if target.get('mode') not in ('one', 'set', 'all', 'none'):
        raise ValueError('unknown meeting target mode')
    for field in ('eligibleIds', 'excludedIds'):
        ids = target.get(field)
        if (not isinstance(ids, list) or any(not isinstance(key, str) for key in ids)
                or len(set(ids)) != len(ids) or not set(ids) <= roster):
            raise ValueError('meeting target IDs must belong to its roster')
    eligible, excluded = set(target['eligibleIds']), set(target['excludedIds'])
    if eligible & excluded or bool(eligible) != (target['mode'] != 'none'):
        raise ValueError('meeting target eligibility contradicts mode or exclusions')
    if target['mode'] == 'all' and eligible != roster - excluded:
        raise ValueError('all target must include every non-excluded participant')


def validate_reports(rows, native, baseline, freeze, source_hash, baseline_identity, tokenizer_hash):
    ids = [row.get('id') for row in rows]
    if (not rows or any(not isinstance(key, str) or not key for key in ids)
            or len(ids) != len(set(ids))
            or any(row.get('task') != 'meeting' or row.get('split') != 'final' for row in rows)):
        raise ValueError('final scorer accepts unique meeting H rows only')
    for row in rows:
        validate_target(row, row['target'])
    native_lookup = candidate.check_report(rows, native, source_hash)
    baseline_lookup = candidate.check_report(rows, baseline, source_hash, native=False)
    expected = {'modelSha256': freeze['modelSha256'], 'helperSha256': freeze['nativeHelperSha256'],
                'inputBudget': freeze['inputBudget'], 'contextTokens': freeze['contextTokens'],
                'backend': freeze['backend'], 'normalizer': 'NFC()', 'tokenizerSha256': tokenizer_hash}
    for field, value in expected.items():
        if native.get(field) != value:
            raise ValueError(f'native {field} differs from the frozen runtime')
    for field, value in baseline_identity.items():
        if baseline.get(field) != value:
            raise ValueError(f'baseline {field} differs from the frozen P reference')
    for row in rows:
        result = native_lookup[row['id']]['result']
        view = row.get('runtimeView')
        if view and result.get('type') == 'result':
            mapping = view['modelToOriginalIds']
            model_ids = result.get('modelParticipantIds')
            if (not isinstance(model_ids, list) or any(key not in mapping for key in model_ids)
                    or [mapping[key] for key in model_ids] != result.get('participantIds')):
                raise ValueError('native recipient restoration differs from its runtime input')
        if row['id'] not in baseline_lookup:
            raise ValueError('missing baseline ID')
    return native_lookup, baseline_lookup


def interval(groups, values):
    if len(set(groups)) < 2:
        return None
    return paired_group_bootstrap(groups, values, [0] * len(values))


def summarize_dispatch(rows, selections):
    result = candidate.dispatch_metrics(rows, selections)
    result['rowValidRate'] = result['validCount'] / len(rows)
    result['validDispatch95CI'] = interval([row['group'] for row in rows], result['validByRow'])
    result['byMode'] = {}
    for mode in ('one', 'set', 'all', 'none'):
        indexes = [index for index, row in enumerate(rows) if row['target']['mode'] == mode]
        if not indexes:
            continue
        subset = [rows[index] for index in indexes]
        part = candidate.dispatch_metrics(subset, [selections[index] for index in indexes])
        result['byMode'][mode] = {key: part[key] for key in (
            'count', 'groups', 'validCount', 'validDispatch', 'forbiddenDispatch', 'forbiddenRate', 'none')}
        result['byMode'][mode]['validDispatch95CI'] = interval(
            [row['group'] for row in subset], part['validByRow'])
    return result


def clean_metrics(metrics):
    return {key: value for key, value in metrics.items() if key not in ('validByRow', 'forbiddenByRow')}


def native_stats(rows, native, decisions):
    lookup = {item['id']: item for item in native['predictions']}
    predictions = [lookup[row['id']] for row in rows]
    latency = np.array([item['seconds'] * 1000 for item in predictions], dtype=float)
    if not np.isfinite(latency).all() or np.any(latency < 0):
        raise ValueError('native latency must be present, finite and nonnegative')
    results = [item['result'] for item in predictions]
    original = [item['originalPromptTokens'] for item in results if 'originalPromptTokens' in item]
    used = [item['usedPromptTokens'] for item in results if 'usedPromptTokens' in item]
    return {'count': len(rows), 'fallbacks': sum(item['fallback'] for item in decisions),
            'assumedRoundZeroFallbacks': sum(item['assumedRoundZero'] for item in decisions),
            'nativeErrors': sum(item.get('type') != 'result' for item in results),
            'deadlineMisses': sum(bool(item.get('deadlineMiss')) or item['seconds'] >= 1.5 for item in predictions),
            'truncatedRows': sum(bool(item.get('inputTruncated')) for item in results),
            'tokenCountsAvailable': len(original),
            'maxOriginalTokens': max(original) if original else None,
            'maxUsedTokens': max(used) if used else None,
            'latencyMs': {name: float(np.quantile(latency, quantile)) for name, quantile in
                          [('p50', .5), ('p95', .95), ('p99', .99), ('max', 1.)]},
            'loadSeconds': native.get('loadSeconds'),
            'warmupSeconds': sum(item.get('seconds', 0) for item in native.get('warmup', [])),
            'scope': 'recorded GPU subprocess round trip after warmup on a shared host; not an isolated timing benchmark'}


def score_population(rows, native, baseline, primary_reference, gate):
    if any(row.get('task') != 'meeting' or row.get('split') != 'final' for row in rows):
        raise ValueError('meeting H rows required')
    n = {item['id']: item for item in native['predictions']}
    b = {item['id']: item for item in baseline['predictions']}
    decisions = [candidate.meeting_decision(row, n[row['id']]) for row in rows]
    raw = summarize_dispatch(rows, [item['raw'] for item in decisions])
    applied = summarize_dispatch(rows, [item['applied'] for item in decisions])
    names = set(b[rows[0]['id']]['references'])
    if primary_reference not in names or any(set(b[row['id']]['references']) != names for row in rows):
        raise ValueError('frozen primary reference or complete diagnostics are missing')
    selections = {name: [b[row['id']]['references'][name] for row in rows] for name in sorted(names)}
    selections.update({'shippedRaw': [b[row['id']]['selected'] for row in rows],
                       'shippedApplied': [b[row['id']]['applied'] for row in rows]})
    diagnostics = {name: summarize_dispatch(rows, values) for name, values in selections.items()}
    reference = diagnostics[primary_reference]
    groups = [row['group'] for row in rows]
    delta = paired_group_bootstrap(groups, applied['validByRow'], reference['validByRow'], confidence=gate['groupConfidence'])
    forbidden_delta = paired_group_bootstrap(groups, applied['forbiddenByRow'], reference['forbiddenByRow'], confidence=gate['groupConfidence'])
    exclusion_rows = sum(bool(row['target']['excludedIds']) for row in rows)
    nonincrease = (applied['forbiddenDispatch'] <= reference['forbiddenDispatch']
                   and applied['forbiddenRate'] <= reference['forbiddenRate'] + 1e-12)
    exclusion_gate = nonincrease if exclusion_rows else None
    minimum = delta['estimate'] >= gate['minimumDelta'] - 1e-12
    positive = delta['interval'][0] > 0
    return {
        'count': len(rows), 'groups': len(set(groups)), 'weighting': 'equal-group',
        'languages': dict(Counter(row.get('language', 'unknown') for row in rows)),
        'candidateRaw': clean_metrics(raw), 'candidateApplied': clean_metrics(applied),
        'primaryComparison': {'reference': primary_reference, 'delta': delta,
                              'forbiddenRateDelta': forbidden_delta,
                              'newForbiddenRows': sum(c and not r for c, r in zip(applied['forbiddenByRow'], reference['forbiddenByRow']))},
        'diagnostics': {name: clean_metrics(value) for name, value in diagnostics.items()},
        'runtime': native_stats(rows, native, decisions),
        'baselineTiming': {'scope': baseline.get('timing', {}).get('scope', 'recorded CPU replay'),
                           'totalReplayMilliseconds': baseline.get('timing', {}).get('totalReplayMilliseconds'),
                           'additionalOfflineReferenceMilliseconds': sum(b[row['id']].get('offlineReferenceTiming', {}).get('totalMilliseconds', 0) for row in rows)},
        'gates': {'minimumDelta': gate['minimumDelta'], 'minimumDeltaMet': minimum,
                  'positiveLower95CIBound': positive, 'explicitExclusionTargetRows': exclusion_rows,
                  'numericExclusionNonIncrease': nonincrease, 'noExclusionRegression': exclusion_gate,
                  'exclusionDefinition': 'no increase in either equal-group forbidden rate or raw forbidden-row count; absence of exclusion labels is not evidence',
                  'observedMetricRequirementsMet': bool(minimum and positive and exclusion_gate is True),
                  'explicitConstraintTestsRequired': True, 'explicitConstraintTestsPassed': None,
                  'promotionEstablished': False,
                  'interpretation': 'population-scoped measurements only; explicit constraints and runtime/resource/platform gates are verified separately'},
        'privateRows': [{'id': row['id'], 'group': row['group'], 'target': {key: row['target'][key] for key in ('mode', 'eligibleIds', 'excludedIds')},
                         'candidate': decision, 'candidateValid': applied['validByRow'][index],
                         'referenceValid': reference['validByRow'][index],
                         'references': {name: values[index] for name, values in selections.items()}}
                        for index, (row, decision) in enumerate(zip(rows, decisions))],
    }


def label_agreement(first, second):
    def accepted(target):
        eligible = frozenset(target['eligibleIds'])
        if target['mode'] == 'none': return frozenset([frozenset()])
        if target['mode'] == 'one': return frozenset(frozenset([key]) for key in eligible)
        return frozenset([eligible])
    recipients = accepted(first) == accepted(second)
    excluded = set(first['excludedIds']) == set(second['excludedIds'])
    return {'mode': first['mode'] == second['mode'], 'acceptedRecipients': recipients,
            'exclusions': excluded, 'semantic': recipients and excluded}


def verify_review_binding(folder, aggregate, labels, sources):
    if aggregate.get('effort') != 'high' or not isinstance(aggregate.get('model'), str) or not aggregate['model']:
        raise ValueError('independent review requires an explicit high receipt')
    requested = set(aggregate.get('requestHashes', []))
    if not requested:
        raise ValueError('review receipt has no request identity')
    visible = {}; found = set()
    for path in sorted(Path(folder).glob('*/*.json.receipt.json')):
        receipt_raw = path.read_bytes(); receipt = json.loads(receipt_raw)
        if receipt.get('requestHash') not in requested:
            continue
        if receipt.get('effort') != 'high' or receipt.get('model') != aggregate['model']:
            raise ValueError('review transport differs from high aggregate receipt')
        answer_path = Path(str(path).removesuffix('.receipt.json'))
        raw = answer_path.read_bytes()
        if sha(raw) != receipt.get('responseHash'):
            raise ValueError('review visible response hash differs from receipt')
        answer = json.loads(raw)
        for label in answer.get('labels', []):
            normalized = deepcopy(label)
            if isinstance(normalized.get('target'), dict) and 'meeting' in normalized['target']:
                normalized['target'] = normalized['target']['meeting']
            visible.setdefault(normalized.get('id'), []).append(normalized)
        found.add(receipt['requestHash'])
        sources[str(path.relative_to(folder))] = sha(receipt_raw)
        sources[str(answer_path.relative_to(folder))] = sha(raw)
    if found != requested:
        raise ValueError('review request identities lack completed high responses')
    for label in labels:
        if label not in visible.get(label['id'], []):
            raise ValueError('aggregate review label differs from its high response')


def reviewer_population(root, rows, native, baseline, reference, gate, frozen_at, sources):
    lookup = {}; models = set(); missing_jobs = []
    jobs = sorted({row['group'].replace('meeting-scene-family-', 'meeting-') for row in rows})
    for job in jobs:
        folder = root / 'verifier' / job
        if not (folder / 'receipt.json').exists() or not (folder / 'labels.jsonl').exists():
            missing_jobs.append(job); continue
        receipt_raw = (folder / 'receipt.json').read_bytes(); labels_raw = (folder / 'labels.jsonl').read_bytes()
        receipt = json.loads(receipt_raw); labels = [json.loads(line) for line in labels_raw.splitlines() if line.strip()]
        if (receipt.get('count') != len(labels) or len({item['id'] for item in labels}) != len(labels)
                or receipt.get('completedAt', float('inf')) > frozen_at):
            raise ValueError('review count, unique IDs, or pre-freeze completion is invalid')
        binding = {}; verify_review_binding(folder, receipt, labels, binding)
        sources[f'verifier/{job}/receipt.json'] = sha(receipt_raw)
        sources[f'verifier/{job}/labels.jsonl'] = sha(labels_raw)
        sources.update({f'verifier/{job}/{name}': digest for name, digest in binding.items()})
        models.add(receipt['model'])
        for label in labels:
            if type(label.get('clear')) is not bool or label['id'] in lookup:
                raise ValueError('review clear flag or duplicate global ID is invalid')
            lookup[label['id']] = label
    covered = []; agreement = []; snapshot_differences = 0
    for row in rows:
        review = lookup.get(row['id'])
        if review is None: continue
        validate_target(row, review['target'])
        agreement.append({'id': row['id'], 'clear': review['clear'], **label_agreement(row['target'], review['target'])})
        if row.get('verifier') is not None and not label_agreement(row['verifier'], review['target'])['semantic']:
            snapshot_differences += 1
        covered.append({**row, 'target': review['target'], 'reviewClear': review['clear']})
    result = {'scope': 'independent high-effort model labels, not human ground truth',
              'requestedRows': len(rows), 'coveredRows': len(covered), 'missingRows': len(rows) - len(covered),
              'coveredGroups': len({row['group'] for row in covered}), 'clearRows': sum(row['reviewClear'] for row in covered),
              'models': sorted(models), 'effort': 'high', 'missingJobs': missing_jobs,
              'frozenSnapshotSemanticDifferences': snapshot_differences,
              'agreementWithTeacher': {key: sum(item[key] for item in agreement) for key in ('mode', 'acceptedRecipients', 'exclusions', 'semantic')},
              'clearDisagreements': sum(item['clear'] and not item['semantic'] for item in agreement),
              'privateAgreementRows': agreement}
    for name, subset in [('allCovered', covered), ('clearOnly', [row for row in covered if row['reviewClear']])]:
        result[name] = score_population(subset, native, baseline, reference, gate) if len({row['group'] for row in subset}) >= 2 else None
    return result


def sanitized_report(full):
    def clean(value):
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items() if key not in ('privateRows', 'privateAgreementRows', 'missingJobs')}
        if isinstance(value, list): return [clean(item) for item in value]
        return value
    result = {key: deepcopy(full[key]) for key in ('version', 'createdAt', 'model', 'reference', 'populations')}
    return clean(result)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--root', required=True)
    parser.add_argument('--out', required=True); parser.add_argument('--aggregate', required=True)
    args = parser.parse_args(); root = Path(args.root); output = Path(args.out); aggregate_path = Path(args.aggregate)
    if output.exists() or aggregate_path.exists(): raise ValueError('final evaluation output already exists')
    run = root / 'runs/meeting-final-v1'; sources = {}

    def read(path, expected=None):
        raw = path.read_bytes(); digest = sha(raw)
        if expected is not None and digest != expected: raise ValueError(f'frozen source hash mismatch: {path.name}')
        sources[str(path.relative_to(root))] = digest
        return json.loads(raw)

    freeze = read(run / 'freeze.json'); candidate._phase('final', True, freeze)
    frozen_at = datetime.fromisoformat(freeze['frozenAt'].replace('Z', '+00:00')).timestamp()
    if freeze['role'] != 'meeting' or freeze['precision'] != 'Q8_0' or freeze['reference']['selectedOn'] != 'policy':
        raise ValueError('meeting Q8 and policy-selected reference must be frozen')
    for name, digest in freeze['renderers'].items():
        if file_sha(REPO / name) != digest: raise ValueError('frozen renderer changed')
        sources[f'repo/{name}'] = digest
    manifest_path = root / 'models/final-candidate/manifest.json'
    manifest = read(manifest_path, freeze['runtimeManifestSha256'])
    runtime = root / 'runs/native-agent/portable/ubuntu24-v1/output/package'
    for name, identity in manifest['runtime'].items():
        path = runtime / name
        if path.stat().st_size != identity['size'] or file_sha(path) != identity['sha256']:
            raise ValueError('native runtime artifact changed')
        sources[f'runtime/{name}'] = identity['sha256']
    if manifest['runtime']['corral-local-decision-helper']['sha256'] != freeze['nativeHelperSha256']:
        raise ValueError('manifest helper differs from freeze')
    model = root / 'models/final-candidate/model-q8.gguf'; identity = manifest['artifacts'][model.name]
    if model.stat().st_size != identity['size'] or file_sha(model) != identity['sha256'] or identity['sha256'] != freeze['modelSha256']:
        raise ValueError('frozen Q8 model artifact changed')
    sources['model-q8.gguf'] = identity['sha256']
    tokenizer_hash = file_sha(root / 'models/final-candidate/merged/tokenizer.json')
    sources['tokenizer.json'] = tokenizer_hash
    policy = read(root / 'reports/baseline-policy-v2.json', freeze['reference']['sourceReportSha256'])
    if policy['inputSha256'] != freeze['reference']['sourceInputSha256']:
        raise ValueError('policy reference input changed')
    for filename, field in [('baseline.ts', 'sourceSha256'), ('baseline-inputs.ts', 'baselineInputsSha256')]:
        if file_sha(HERE / filename) != policy[field]: raise ValueError('baseline code differs from policy')
        sources[f'repo/tools/local-intelligence/research/{filename}'] = policy[field]
    baseline_identity = {key: policy[key] for key in ('baseModelSha256', 'weightsSha256', 'meetingWeightsSha256',
                         'sourceSha256', 'baselineInputsSha256', 'referenceVersion', 'roleHistoryWeights')}
    expected_names = set(next(item for item in policy['predictions'] if item['task'] == 'meeting')['references'])
    populations = {}; loaded = {}
    for name, declared in freeze['inputs'].items():
        path = root / declared['path']; raw = path.read_bytes()
        if sha(raw) != declared['sha256']: raise ValueError('final dataset differs from freeze')
        sources[declared['path']] = sha(raw)
        rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if len(rows) != declared['rows']: raise ValueError('final dataset row count changed')
        native = read(run / f'{name}.native.json'); baseline = read(run / f'{name}.baseline.json')
        validate_reports(rows, native, baseline, freeze, declared['sha256'], baseline_identity, tokenizer_hash)
        if any(set(item['references']) != expected_names for item in baseline['predictions']):
            raise ValueError('H baseline references differ from P')
        exposure = read(run / f'{name}.native.json.exposure.json')
        baseline_exposure = read(run / f'{name}.baseline.json.exposure.json')
        if (exposure['at'] < frozen_at or exposure['modelSha256'] != freeze['modelSha256']
                or exposure['sourceSha256'] != declared['sha256']
                or baseline_exposure['at'] / 1000 < frozen_at or baseline_exposure['inputSha256'] != declared['sha256']):
            raise ValueError('final exposure does not follow the matching freeze')
        loaded[name] = rows, native, baseline
    # Every source and artifact is checked before any population is scored.
    for name, (rows, native, baseline) in loaded.items():
        populations[name] = {'interpretation': freeze['interpretation'][name],
                            **score_population(rows, native, baseline, freeze['reference']['name'], freeze['gate'])}
    rows, native, baseline = loaded['teacher']
    populations['teacher']['independentVerifier'] = reviewer_population(
        root, rows, native, baseline, freeze['reference']['name'], freeze['gate'], frozen_at, sources)
    full = {'version': 'final-meeting-evaluation-v1', 'createdAt': datetime.now(timezone.utc).isoformat(),
            'model': {key: freeze[key] for key in ('modelSha256', 'precision', 'inputBudget', 'contextTokens', 'backend')},
            'reference': {key: freeze['reference'][key] for key in ('name', 'selectedOn', 'frozenAt')},
            'sources': sources, 'evaluatorSha256': file_sha(Path(__file__)),
            'methodsSha256': {path.name: file_sha(path) for path in (HERE / 'candidate-evaluation.py', HERE / 'evaluation.py')},
            'populations': populations}
    aggregate = sanitized_report(full)
    serialized = json.dumps(aggregate, ensure_ascii=False, indent=2)
    if str(root) in serialized or str(REPO) in serialized: raise ValueError('aggregate contains a private path')
    for path, value in [(output, full), (aggregate_path, aggregate)]:
        with path.open('x') as handle: json.dump(value, handle, ensure_ascii=False, indent=2)
        path.chmod(0o600)
    print(json.dumps({name: {'rows': value['count'], 'groups': value['groups'],
        'candidate': value['candidateApplied']['validDispatch'],
        'reference': value['diagnostics'][freeze['reference']['name']]['validDispatch'],
        'delta': value['primaryComparison']['delta'], 'gates': value['gates']}
        for name, value in populations.items()}))


if __name__ == '__main__': main()
