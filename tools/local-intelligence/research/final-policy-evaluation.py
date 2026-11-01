#!/usr/bin/env python3
"""Frozen final executable comparison. No fitting, exclusions, substitutions, or model calls."""
import argparse
import ast
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

import numpy as np

from evaluation import paired_group_bootstrap, paired_outcome_report
from outcome_inputs import judge_input
from repair_fixtures import canonical, fixture_fields, input_hash

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
LEVELS = ['low', 'medium', 'high', 'xhigh']


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def require_unseal(value):
    if value is not True:
        raise ValueError('final executable outcomes require explicit unseal authorization')


def validate_cohort(root, manifest, mapping, manifest_hash):
    root = Path(root).resolve()
    rows = mapping.get('rows', [])
    chosen = manifest.get('final', [])
    if (manifest.get('frozen') is not True or manifest.get('targetFamilies') != 200 or len(chosen) != 200
            or mapping.get('phase') != 'final' or mapping.get('frozen') is not True
            or mapping.get('manifestHash') != manifest_hash or len(rows) != 200):
        raise ValueError('exact frozen final200 source mapping is required')
    ids = [row['id'] for row in rows]; groups = [row['group'] for row in rows]
    if len(set(ids)) != 200 or len(set(groups)) != 200 or set(ids) != {row['id'] for row in chosen}:
        raise ValueError('final families cannot be removed, duplicated, or replaced')
    by_id = {row['id']: row for row in chosen}
    for row in rows:
        original = by_id[row['id']]
        if (not re.fullmatch(r'outcome-\d{4}-\d{2}', row['id']) or int(row['id'].split('-')[1]) < 20
                or original.get('phase') != 'final' or row['group'] != original['group']
                or row['workerRoot'] != original['workerRoot'] or row['receipts'] != original['receipts']
                or row['visibleFixturePath'] != original['visibleFixturePath']):
            raise ValueError('input/worker lineage differs from the frozen final family')
        if not (root / row['workerRoot']).resolve().is_relative_to(root):
            raise ValueError('worker root escaped the frozen research root')
        slots = set()
        for slot in row['receipts']:
            key = (slot['effort'], slot['repeat'])
            if slot['effort'] not in LEVELS or type(slot['repeat']) is not int or slot['repeat'] not in (0, 1) or key in slots:
                raise ValueError('duplicate or invalid final receipt slot')
            expected = root / row['workerRoot'] / 'outcomes/trials-corral' / row['id'] / slot['effort'] / str(slot['repeat']) / 'receipt.json'
            if Path(slot['path']).absolute() != expected.absolute():
                raise ValueError('final receipt path differs from the selected cohort, including recollections')
            slots.add(key)
        if len(slots) != 8:
            raise ValueError('every final family must retain all eight planned receipts')
    return rows


def validate_receipt(receipt, row, slot, fixture_hash, prompt_hash):
    if (receipt.get('id') != row['id'] or receipt.get('group') != row['sourceGroup']
            or receipt.get('model') != 'gpt-6.1-sol' or receipt.get('role') != 'evaluated-worker'
            or receipt.get('transport') != 'corral' or receipt.get('effort') != slot['effort']
            or receipt.get('repeat') != slot['repeat'] or receipt.get('fixtureHash') != fixture_hash
            or receipt.get('promptHash') != prompt_hash
            or receipt.get('wire') != {'kind': 'effort', 'value': slot['effort']}):
        raise ValueError('final worker identity, fixture, prompt, model, or effort wire changed')
    tokens = receipt.get('usage', {}).get('totalTokens')
    passed = receipt.get('grade', {}).get('passed'); seconds = receipt.get('responseSeconds')
    if type(tokens) is not int or tokens <= 0 or type(passed) is not bool:
        raise ValueError('missing final success/usage blocks the gate; no exclusion or imputation')
    if type(seconds) not in (int, float) or not np.isfinite(seconds) or seconds < 0:
        raise ValueError('missing final measured worker timing')
    return {'passed': passed, 'tokens': tokens, 'seconds': seconds}


def checked_ids(predictions, ids):
    found = [prediction.get('id') for prediction in predictions]
    if len(found) != len(set(found)) or set(found) != set(ids):
        raise ValueError('prediction coverage differs from exact frozen final200 IDs')
    return {prediction['id']: prediction for prediction in predictions}


def derive_actions(inputs, native, reference, current, freeze):
    payload = {'inputs': inputs, 'native': native, 'reference': reference, 'current': current, 'candidate': freeze['candidate']}
    policy_module = (HERE / 'effort-policies.ts').as_uri()
    view_module = (HERE / 'outcome-runtime.ts').as_uri()
    script = f'''import assert from 'node:assert/strict';
import {{readFileSync}} from 'node:fs';
import {{applyEffortPolicy}} from {json.dumps(policy_module)};
import {{deriveOutcomeRuntime}} from {json.dumps(view_module)};
const x=JSON.parse(readFileSync(0,'utf8'));
const n=new Map(x.native.predictions.map(p=>[p.id,p]));
const r=new Map((x.reference?.predictions??[]).map(p=>[p.id,p]));
const b=new Map((x.current?.predictions??[]).map(p=>[p.id,p]));
const out=[];
for(const row of x.inputs){{
 const derived=deriveOutcomeRuntime({{task:'effort',input:row.input}});
 assert.deepEqual(derived.coreReasoningInput,row.coreReasoningInput);
 assert.deepEqual(derived.runtimeView,row.runtimeView);
 const p=n.get(row.id);assert.ok(p);
 const valid=p.result?.type==='result' && !p.deadlineMiss && p.seconds<3 && Array.isArray(p.result.logits) && p.result.logits.length===4 && p.result.logits.every(Number.isFinite);
 let learned,identity;
 if(valid){{const peak=Math.max(...p.result.logits), ex=p.result.logits.map(z=>Math.exp((z-peak)/x.candidate.temperature)),sum=ex.reduce((a,b)=>a+b,0),prob=ex.map(z=>z/sum);
 learned=applyEffortPolicy(prob,x.candidate.policy);identity=applyEffortPolicy(prob,{{kind:'identity'}});
 }} else {{learned={{appliedLevel:x.candidate.nativeFailureFallback,abstention:false}};identity=learned;}}
 const policies={{'qwen-adaptive':learned.appliedLevel,'qwen-identity':identity.appliedLevel,'constant-low':'low','constant-medium':'medium','constant-high':'high'}};
 const judgeSeconds={{'qwen-adaptive':p.seconds,'qwen-identity':p.seconds,'constant-low':0,'constant-medium':0,'constant-high':0}};
 if(x.reference){{const a=r.get(row.id);assert.ok(a);policies['supplied-asymmetric-relative-low']=applyEffortPolicy(a.probabilities,{{kind:'asymmetric-relative-low'}}).appliedLevel;judgeSeconds['supplied-asymmetric-relative-low']=a.milliseconds/1000;}}
 if(x.current){{const a=b.get(row.id);assert.ok(a);policies.current=a.applied;judgeSeconds.current=a.milliseconds/1000;}}
 out.push({{id:row.id,group:row.group,policies,judgeSeconds,nativeFailure:!valid,coreReview:Boolean(learned.abstention),inputTruncated:Boolean(p.result?.inputTruncated)}});
}}
console.log(JSON.stringify(out));'''
    result = subprocess.run([os.environ.get('CORRAL_RESEARCH_NODE', 'node'), '--input-type=module', '-e', script],
                            input=json.dumps(payload, ensure_ascii=False), text=True, capture_output=True, check=True, timeout=60)
    return json.loads(result.stdout)


def aggregate(rows, actions, outcomes, name, reference='constant-high'):
    pairs = []; own_seconds = []; reference_seconds = []; own_worker = []; judges = []; own_tokens = []; successes = 0
    for row in rows:
        action = actions[row['id']]; chosen = action['policies'][name]; reference_level = action['policies'][reference]
        judge = action['judgeSeconds'][name]; reference_judge = action['judgeSeconds'][reference]
        for repeat in range(2):
            own = outcomes[(row['id'], chosen, repeat)]; baseline = outcomes[(row['id'], reference_level, repeat)]
            pairs.append({'group': row['group'], 'repeat': repeat, 'candidatePassed': own['passed'],
                          'referencePassed': baseline['passed'], 'candidateTotalTokens': own['tokens'],
                          'referenceTotalTokens': baseline['tokens']})
            own_seconds.append(own['seconds'] + judge); reference_seconds.append(baseline['seconds'] + reference_judge)
            own_worker.append(own['seconds']); judges.append(judge); own_tokens.append(own['tokens']); successes += own['passed']
    paired = paired_outcome_report(pairs, expected_groups=[row['group'] for row in rows])
    groups = [pair['group'] for pair in pairs]
    return {'successes': successes, 'trials': len(pairs), 'totalProviderTokens': sum(own_tokens),
            'meanProviderTokens': float(np.mean(own_tokens)), 'meanWorkerSeconds': float(np.mean(own_worker)),
            'meanJudgeSeconds': float(np.mean(judges)), 'meanWorkerPlusJudgeSeconds': float(np.mean(own_seconds)),
            'pairedVersus': reference, 'paired': paired,
            'latencyDeltaSeconds': paired_group_bootstrap(groups, own_seconds, reference_seconds),
            'latencyReduction': paired_group_bootstrap(groups, own_seconds, reference_seconds, statistic='reduction'),
            'appliedCounts': dict(Counter(actions[row['id']]['policies'][name] for row in rows))}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--root', required=True); parser.add_argument('--out', required=True)
    parser.add_argument('--unseal-final', action='store_true'); parser.add_argument('--primary-only', action='store_true')
    parser.add_argument('--approved-amendment-sha')
    args = parser.parse_args(); require_unseal(args.unseal_final)
    root = Path(args.root).resolve(); output = Path(args.out)
    if output.exists() or output.with_suffix('.aggregate.json').exists():
        raise ValueError('immutable final evaluation output already exists')
    provenance = {}

    def read(path, expected=None):
        path = Path(path).absolute()
        if path.resolve() != path or not path.is_relative_to(root):
            raise ValueError('final artifact escaped its declared research root')
        raw = path.read_bytes(); digest = sha(raw)
        if expected is not None and expected != digest:
            raise ValueError('frozen final artifact hash changed')
        provenance[str(path.relative_to(root))] = digest
        return raw

    freeze_path = root / 'runs/effort-policy-v1/final-experiment-freeze.json'
    freeze_raw = read(freeze_path); freeze = json.loads(freeze_raw); candidate = freeze['candidate']
    if (freeze['algorithm'] != 'effort-development-monotone-v1' or candidate['policy'] != {'kind': 'monotone', 'map': [0, 0, 0, 2]}
            or candidate['inputBudget'] != 1024 or candidate['contextTokens'] != 2048
            or candidate['nativeFailureFallback'] != 'high' or freeze['failureConfiguration']['externalJudgesEnabled'] is not False):
        raise ValueError('final experiment policy or failure configuration differs from frozen V3')
    amendment = None
    for path, digest in freeze['sourceHashes'].items():
        current_hash = sha((REPO / path).read_bytes())
        if current_hash == digest:
            continue
        if not args.approved_amendment_sha:
            raise ValueError('frozen execution source changed without its specifically approved amendment')
        if amendment is None:
            amendment = json.loads(read(root / 'runs/effort-final-v1/reference-execution-amendment/amendment.json', args.approved_amendment_sha))
            if amendment['originalFreezeHash'] != sha(freeze_raw) or amendment['kind'] != 'explicit-final-unseal-execution-only-amendment':
                raise ValueError('execution amendment belongs to another freeze or purpose')
        record = amendment['sources'].get(Path(path).name)
        if Path(path).name != 'reference-upstream.ts' or not record or record['oldSha256'] != digest or record['newSha256'] != current_hash:
            raise ValueError('source change exceeds the approved final-exposure-only amendment')
        read(record['oldSourceCopy'], record['oldSha256']); read(amendment['diffPath'], amendment['diffSha256'])
    # Statistical method was already recorded before final access by the C/P report.
    cp = json.loads(read(root / 'reports/candidate-cp-evaluation-v1.json'))
    if sha((HERE / 'evaluation.py').read_bytes()) != cp['sourceCodeHashes']['tools/local-intelligence/research/evaluation.py']:
        raise ValueError('paired statistical method changed after its pre-final record')
    pins = freeze['finalCohort']['files']
    manifest_raw = read(root / pins['manifest.json']['path'], pins['manifest.json']['sha256'])
    manifest = json.loads(manifest_raw)
    mapping = json.loads(read(root / pins['inputs-source-map.json']['path'], pins['inputs-source-map.json']['sha256']))
    rows = validate_cohort(root, manifest, mapping, sha(manifest_raw))
    input_raw = read(root / pins['final-core-v3-inputs.jsonl']['path'], pins['final-core-v3-inputs.jsonl']['sha256'])
    inputs = [json.loads(line) for line in input_raw.splitlines() if line.strip()]
    inputs_by_id = checked_ids(inputs, [row['id'] for row in rows])
    for row in rows:
        source = inputs_by_id[row['id']]
        if source['split'] != 'final' or source['target'] is not None or source['task'] != 'effort' or source['group'] != row['group']:
            raise ValueError('final input is not the frozen executable source view')
    native = json.loads(read(root / 'runs/effort-final-v1/q8-native.json'))
    native_lookup = checked_ids(native['predictions'], inputs_by_id)
    if native.get('complete') is not True or native['inputSha256'] != sha(input_raw):
        raise ValueError('native final input coverage/provenance is incomplete')
    for key in ('modelSha256', 'helperSha256', 'tokenizerSha256', 'inputBudget', 'contextTokens', 'normalizer'):
        if native[key] != candidate[key]:
            raise ValueError('final native model/runtime differs from the frozen candidate')
    for row in rows:
        prediction = native_lookup[row['id']]
        if prediction['group'] != row['group'] or prediction['task'] != 'effort' or not np.isfinite(prediction['seconds']) or prediction['seconds'] < 0:
            raise ValueError('native final prediction identity/timing is invalid')
    current = reference = None
    if not args.primary_only:
        current = json.loads(read(root / 'runs/effort-final-v1/baseline.json'))
        reference = json.loads(read(root / 'runs/effort-final-v1/reference.predictions.json'))
        checked_ids(current['predictions'], inputs_by_id); checked_ids(reference['predictions'], inputs_by_id)
        if current['inputSha256'] != sha(input_raw) or reference['metadata']['sourceInputSha256'] != sha(input_raw):
            raise ValueError('final comparators use another source input')
        for key in ('baseModelSha256', 'weightsSha256'):
            if current[key] != freeze['comparators']['current'][key]:
                raise ValueError('current-policy comparator weights changed')
        frozen_reference = freeze['comparators']['suppliedReference']
        if reference['runtime']['temperature'] != frozen_reference['fixedTemperature']:
            raise ValueError('supplied reference temperature changed')
        for key in ('upstreamCommit', 'calibration'):
            if reference['metadata'][key] != frozen_reference['metadata'][key]:
                raise ValueError('supplied reference model/tokenizer/formatter/calibration changed')
        assets = lambda metadata: {item['name']: (item['sha256'], item['bytes']) for item in metadata['assets']}
        if assets(reference['metadata']) != assets(frozen_reference['metadata']):
            raise ValueError('supplied reference artifact bytes changed')
        for prediction in reference['predictions']:
            logits = np.asarray(prediction['logits'], dtype=float)
            if logits.shape != (4,) or not np.isfinite(logits).all() or prediction['group'] != inputs_by_id[prediction['id']]['group']:
                raise ValueError('supplied reference prediction identity/logits are invalid')
            probability = np.exp((logits - logits.max()) / frozen_reference['fixedTemperature'])
            probability /= probability.sum()
            if not np.allclose(probability, prediction['probabilities'], atol=1e-7, rtol=0):
                raise ValueError('supplied reference probabilities differ from its frozen temperature')
        for prediction in [*current['predictions'], *reference['predictions']]:
            if not np.isfinite(prediction['milliseconds']) or prediction['milliseconds'] < 0:
                raise ValueError('comparator timing is missing')
    action_list = derive_actions(inputs, native, reference, current, freeze)
    actions = checked_ids(action_list, inputs_by_id)
    policy_names = list(action_list[0]['policies'])
    for action in action_list:
        if set(action['policies']) != set(policy_names) or any(level not in LEVELS for level in action['policies'].values()):
            raise ValueError('frozen policy decisions are incomplete')
    # Record exact model actions and exposure BEFORE the first worker receipt read.
    exposure = {'at': datetime.now(timezone.utc).isoformat(), 'explicitUnseal': True,
                'freezeSha256': sha(freeze_raw), 'manifestSha256': sha(manifest_raw),
                'inputSha256': sha(input_raw), 'policyActionsSha256': sha(canonical(action_list).encode()),
                'families': 200, 'receiptPaths': 1600, 'primaryOnly': args.primary_only,
                'noRefitNoSelectionChanges': True}
    exposure_path = output.with_suffix('.exposure.json')
    exposure_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with exposure_path.open('x') as handle:
        json.dump(exposure, handle, indent=2)
    exposure_path.chmod(0o600)
    tree = ast.parse((HERE / 'trials.py').read_text())
    prefix = [node.value.left.value for node in ast.walk(tree) if isinstance(node, ast.Assign)
              and any(isinstance(target, ast.Name) and target.id == 'prompt' for target in node.targets)
              and isinstance(node.value, ast.BinOp) and isinstance(node.value.left, ast.Constant)]
    if len(prefix) != 1:
        raise ValueError('worker prompt source cannot be verified')
    outcomes = {}; private_rows = []
    allowed_receipts = {slot['path'] for row in rows for slot in row['receipts']}
    if len(allowed_receipts) != 1600:
        raise ValueError('final receipt allowlist is not exactly1600 unique paths')
    for row in rows:
        fixture_raw = read(row['visibleFixturePath'], row['fixtureFileSha256'])
        fixture = json.loads(fixture_raw); source = inputs_by_id[row['id']]
        if fixture['id'] != row['id'] or fixture['group'] != row['sourceGroup'] or input_hash(fixture_raw) != row['visibleInputSha256']:
            raise ValueError('final fixture identity or visible input changed')
        if judge_input(fixture) != source['input']:
            raise ValueError('native input differs from exact worker-visible fixture')
        minimal = row['origin'] != 'original' or row.get('measurementVersion') is not None
        worker_case = fixture_fields(fixture_raw) if minimal else fixture
        fixture_hash = sha(json.dumps(worker_case, sort_keys=True).encode())
        visible = {key: fixture[key] for key in ('request', 'context', 'files')}
        prompt_hash = sha((prefix[0] + json.dumps(visible, ensure_ascii=False)).encode())
        one = {'id': row['id'], 'group': row['group'], 'origin': row['origin'], 'fixtureVersion': row['fixtureVersion'],
               'measurementVersion': row.get('measurementVersion'), 'actions': actions[row['id']], 'outcomes': []}
        for slot in row['receipts']:
            if slot['path'] not in allowed_receipts:
                raise ValueError('attempted undeclared final receipt read')
            receipt = json.loads(read(slot['path']))
            result = validate_receipt(receipt, row, slot, fixture_hash, prompt_hash)
            outcomes[(row['id'], slot['effort'], slot['repeat'])] = result
            one['outcomes'].append({'level': slot['effort'], 'repeat': slot['repeat'], **result})
        private_rows.append(one)
    summaries = {name: aggregate(rows, actions, outcomes, name) for name in policy_names}
    low = summaries['constant-low']
    for summary in summaries.values():
        equal = summary['successes'] == low['successes'] and summary['totalProviderTokens'] == low['totalProviderTokens']
        dominated = low['successes'] >= summary['successes'] and low['totalProviderTokens'] <= summary['totalProviderTokens']
        summary['empiricalConstantLowComparison'] = 'equivalent' if equal else 'dominated' if dominated else 'not-dominated'
    comparisons = {}
    for name in ('constant-low', 'constant-medium', 'current', 'supplied-asymmetric-relative-low'):
        if name in policy_names:
            compared = aggregate(rows, actions, outcomes, 'qwen-adaptive', name)
            comparisons[name] = {key: compared[key] for key in ('pairedVersus', 'paired', 'latencyDeltaSeconds', 'latencyReduction')}
    aggregate_report = {'phase': 'final', 'families': 200, 'workerReceipts': len(outcomes), 'repeatsPerLevel': 2,
        'primary': 'qwen-adaptive', 'gateReference': 'constant-high', 'summaries': summaries,
        'primaryDiagnosticComparisons': comparisons, 'primaryGatePassed': summaries['qwen-adaptive']['paired']['passesStatisticalGate'],
        'native': {'backend': native['backend'], 'errorsOrDeadlines': sum(action['nativeFailure'] for action in action_list),
                   'coreReviews': sum(action['coreReview'] for action in action_list),
                   'inputTruncated': sum(action['inputTruncated'] for action in action_list),
                   'loadSeconds': native.get('loadSeconds')},
        'scope': freeze['applicationScope'], 'missingFamilies': 0, 'excludedFamilies': 0,
        'comparatorsPending': ['current', 'supplied-asymmetric-relative-low'] if args.primary_only else [],
        'freezeSha256': sha(freeze_raw), 'exposure': exposure, 'executionAmendmentSha256': args.approved_amendment_sha,
        'limitations': ['Synthetic supplied-source next-response tasks, not full autonomous repository tasks.',
            'Policy evidence is specific to GPT-6.1-sol through Corral subscription and the frozen input representation.',
            'Reported totalTokens only; reasoning/cache tokens are not added a second time.',
            'Each warm judge time is reused across two worker repeats; combined timing is not a synchronized full-pipeline trial or isolated contention benchmark.',
            'Current/reference/constant policies are frozen diagnostics; their gate flags do not select a new policy after H.',
            'Constant-low domination is an empirical comparison, not proof that low is universally sufficient.']}
    private = {**aggregate_report, 'provenanceHashes': provenance, 'sourceSha256': sha(Path(__file__).read_bytes()),
               'statisticalMethodsSha256': sha((HERE / 'evaluation.py').read_bytes()), 'perFamily': private_rows}
    for path, value in [(output, private), (output.with_suffix('.aggregate.json'), aggregate_report)]:
        with path.open('x') as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
        path.chmod(0o600)
    print(json.dumps({'families': 200, 'receipts': len(outcomes), 'primaryGatePassed': aggregate_report['primaryGatePassed'],
                      'primary': summaries['qwen-adaptive'], 'fixedLow': low}, indent=2))


if __name__ == '__main__':
    main()
