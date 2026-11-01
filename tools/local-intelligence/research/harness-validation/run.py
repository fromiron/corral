#!/usr/bin/env python3
"""Development-only, bounded real Corral Coordinator trials. No final-set reads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import re
import signal
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from grader import grade

CASES = ('outcome-0000-00', 'outcome-0001-01', 'outcome-0002-02',
         'outcome-0003-01', 'outcome-0004-02')
EFFORTS = ('medium', 'high')
HERE = Path(__file__).resolve().parent


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    path.chmod(0o600)


def load_case(root, case_id):
    match = re.fullmatch(r'outcome-(\d{4})-\d{2}', case_id)
    if not match or int(match[1]) >= 20:
        raise ValueError('only development batches 0000 through 0019 may be read')
    case = json.loads((root / 'outcomes/validated' / case_id / 'case.json').read_text())
    if case['id'] != case_id:
        raise ValueError('fixture identity mismatch')
    return case


def preflight(root, case):
    out = root / 'outcomes/harness/preflight' / case['id']
    receipt_path = out / 'receipt.json'
    fixture_hash = digest(case)
    grader_hash = hashlib.sha256((HERE.parent / 'grader.py').read_bytes()).hexdigest()
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if receipt['fixtureHash'] != fixture_hash or receipt['graderHash'] != grader_hash:
            raise ValueError('preflight source changed; preserve existing evidence and use a new root')
    else:
        reference = grade(case, case['referenceFiles'], out / 'reference')
        buggy = grade(case, case['files'], out / 'buggy')
        receipt = {'id': case['id'], 'fixtureHash': fixture_hash, 'graderHash': grader_hash,
                   'sourceHash': digest(case['files']), 'checkHash': digest(case['tests']),
                   'reference': reference, 'buggy': buggy,
                   'valid': reference['passed'] and not buggy['passed']}
        save(receipt_path, receipt)
    if not receipt['valid']:
        raise ValueError('fixture reference/source preflight failed')
    return receipt


def trial(root, case, effort, preflight_receipt):
    out = root / 'outcomes/harness/trials' / case['id'] / effort
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt_path = out / 'receipt.json'
    if receipt_path.exists():
        return json.loads(receipt_path.read_text())
    if (out / 'started.json').exists():
        return {'id': case['id'], 'effort': effort, 'state': 'unsettled', 'passed': False}
    # The host-only fixture reference is deliberately absent from the driver input.
    worker_input = {key: case[key] for key in ('id', 'request', 'context', 'files', 'tests', 'language')}
    save(out / 'worker-input.json', worker_input)
    request = {'id': case['id'], 'effort': effort, 'role': 'evaluated-worker',
               'model': 'gpt-6.1-sol', 'provider': 'openai-codex',
               'startedAt': time.time(), 'fixtureHash': preflight_receipt['fixtureHash'],
               'sourceHash': preflight_receipt['sourceHash'], 'checkHash': preflight_receipt['checkHash'],
               'driverHash': hashlib.sha256((HERE / 'driver.ts').read_bytes()).hexdigest(),
               'graderHash': preflight_receipt['graderHash'],
               'scope': 'real Corral Coordinator + SDK/broker + isolated managed copy; visible tests'}
    save(out / 'started.json', request)
    run = root / 'runs/harness-agent' / case['id'] / effort
    command = [os.environ.get('CORRAL_RESEARCH_NODE', 'node'), str(HERE / 'driver.ts'),
               str(out / 'worker-input.json'), str(out), str(run), effort]
    started = time.monotonic()
    with (out / 'stdout.log').open('w') as stdout, (out / 'stderr.log').open('w') as stderr:
        process = subprocess.Popen(command, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            process.wait(timeout=330)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    result_path = out / 'harness.json'
    result = json.loads(result_path.read_text()) if result_path.exists() else {}
    final_grade = {'passed': False, 'reason': 'no-completed-worker-output'}
    if (out / 'patched-files.json').exists():
        final_grade = grade(case, json.loads((out / 'patched-files.json').read_text()), out / 'grade')
    passed = bool(result.get('status') == 'succeeded' and result.get('wireVerified')
                  and result.get('oauthVerified') and result.get('testsUnmodified')
                  and result.get('toolActions') and final_grade['passed'])
    receipt = {**request, 'completedAt': time.time(), 'elapsedSeconds': time.monotonic() - started,
               'exitCode': process.returncode, 'state': 'complete' if result else 'harness-error',
               'passed': passed, 'grade': final_grade, 'harness': result}
    save(receipt_path, receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--preflight-only', action='store_true')
    mode.add_argument('--live', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    root = args.root.resolve()
    cases = [load_case(root, case_id) for case_id in CASES]
    verified = {case['id']: preflight(root, case) for case in cases}
    manifest = {'version': 1, 'caseIds': list(CASES), 'efforts': list(EFFORTS), 'repeats': 1,
                'maxExecutions': 10, 'maxProviderRequestsPerExecution': 12,
                'visibleTests': True, 'sealedBatchesRead': False,
                'selection': 'five fixture families from development batches; no worker outcomes used',
                'preflight': verified}
    save(root / 'outcomes/harness/manifest.json', manifest)
    print(json.dumps({'preflight': 'passed', 'cases': len(cases), 'live': args.live}), flush=True)
    if args.preflight_only:
        return
    results = []
    for case in cases:
        efforts = list(EFFORTS)
        random.Random(case['id'] + ':harness-v1').shuffle(efforts)
        for effort in efforts:
            result = trial(root, case, effort, verified[case['id']])
            results.append(result)
            print(json.dumps({key: result[key] for key in ('id', 'effort', 'state', 'passed')}), flush=True)
            save(root / 'outcomes/harness/results.json', results)
            if result['state'] in ('harness-error', 'unsettled'):
                raise RuntimeError('execution did not settle; inspect preserved evidence before continuing')
    summary = {'scope': manifest['selection'], 'executions': len(results),
               'byEffort': {effort: {'passed': sum(row['passed'] for row in results if row['effort'] == effort),
                                    'total': sum(row['effort'] == effort for row in results)} for effort in EFFORTS},
               'physicalProviderRequests': sum(row.get('harness', {}).get('physicalProviderRequests', 0) for row in results),
               'notEvidenceFor': ['sealed final evaluation', 'hidden-test equivalence', 'adaptive per-step policy', 'meeting selection']}
    save(root / 'outcomes/harness/summary.json', summary)
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
