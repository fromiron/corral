#!/usr/bin/env python3
"""Exactly two declared new matched measurement blocks; all outcomes stay sealed."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import random
import re
from types import SimpleNamespace

import repair_fixtures as repair
from trials import trial

PROTOCOL = 'matched-measurement-recollection-v1'
LEVELS = ('low', 'medium', 'high', 'xhigh')
BLOCK = tuple((level, repeat) for level in LEVELS for repeat in (0, 1))
TARGETS = {'outcome-0037-01': ('xhigh', 1), 'outcome-0085-00': ('high', 0)}
HERE = Path(__file__).resolve().parent


def _fields(raw, keys):
    spans = repair.field_spans(raw); text = raw.decode('utf8')
    return {key: json.loads(text[spans[key][0]:spans[key][1]]) for key in keys}


def source_identity(path):
    raw = path.read_bytes()
    identity = _fields(raw, ('id', 'group'))
    return {'id': identity['id'], 'family': identity['group'], 'caseHash': repair.sha(raw),
            'inputHash': repair.sha(b'\0'.join(repair.field_bytes(raw, key) for key in ('request', 'context', 'files'))),
            'testHash': repair.sha(repair.field_bytes(raw, 'tests')),
            'referenceHash': repair.sha(repair.field_bytes(raw, 'referenceFiles'))}


def prepare(root, amendment_path):
    root = Path(root).resolve(); amendment_path = Path(amendment_path).resolve()
    if amendment_path.exists() or not amendment_path.is_relative_to(root / 'outcomes/measurement-recollections'):
        raise ValueError('use a new immutable measurement amendment path')
    measurement = amendment_path.parent.name
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', measurement):
        raise ValueError('invalid measurement identity')
    cases = []
    for case_id, missing in TARGETS.items():
        source = root / 'outcomes/validated' / case_id / 'case.json'
        identity = source_identity(source)
        quality_path = root / 'outcomes/quality' / case_id / 'receipt.json'
        quality_raw = quality_path.read_bytes()
        quality = _fields(quality_raw, ('id', 'valid', 'effort', 'model', 'transport'))
        if (quality['id'] != case_id or quality['valid'] is not True or quality['effort'] != 'high'
                or quality['transport'] != 'corral-credential-hive' or 'deepseek' not in quality['model'].lower()
                or repair.field_bytes(quality_raw, 'issues').strip() != b'[]'):
            raise ValueError('the original fixture needs independent high approval')
        old = []
        for level, repeat in BLOCK:
            directory = root / 'outcomes/trials-corral' / case_id / level / str(repeat)
            had_receipt = (directory / 'receipt.json').is_file()
            if not (directory / 'started.json').exists() or had_receipt == ((level, repeat) == missing):
                raise ValueError('the original missingness pattern differs from the authorized amendment')
            old.append({'effort': level, 'repeat': repeat, 'directory': str(directory.relative_to(root)), 'hadReceipt': had_receipt})
        worker_root = f'recollection-trials/{measurement}/{case_id}'
        if (root / worker_root).exists():
            raise ValueError('new measurements cannot reuse an existing output root')
        new = [{'effort': level, 'repeat': repeat,
                'directory': f'{worker_root}/outcomes/trials-corral/{case_id}/{level}/{repeat}'} for level, repeat in BLOCK]
        cases.append({**identity, 'casePath': str(source.relative_to(root)),
                      'independentReviewHash': repair.sha(quality_raw), 'priorWorkerRoot': '.',
                      'workerRoot': worker_root, 'oldBlock': old, 'newBlock': new})
    document = {
        'protocol': PROTOCOL, 'measurementId': measurement, 'frozenAt': repair.now(),
        'hashFormat': 'original-json-field-bytes-v1', 'model': repair.MODEL, 'provider': 'openai-codex',
        'auth': 'oauth', 'transport': 'corral', 'efforts': list(LEVELS), 'repeats': 2,
        'maxExecutions': 16, 'maxWorkers': 2, 'cases': cases,
        'workerOutcomesRead': False, 'newIndependentMeasurement': True,
        'recoveryOfPriorUnknownRequests': False, 'oldCohortsExcludedFromPrimary': True,
        'mixOldAndNew': False, 'automaticFurtherRecollection': False,
        'collectorHashes': {name: repair.sha((HERE / name).read_bytes()) for name in ('trials.py', 'subscription.ts')},
        'loadAtFreeze': list(os.getloadavg()),
        'cachePolicy': 'existing subscription transport defaults, unchanged; reported cache data remains sealed in new receipts',
        'limitations': ['Collection time, server load, and cache state may differ from the preserved original blocks.',
                        'Both families replace their entire four-level/two-repeat measurement block, regardless of results.',
                        'Any new unknown/missing receipt retains the family and blocks a complete paired gate; no automatic replay.'],
    }
    validate(root, document)
    repair.write_once(amendment_path, document)
    return document


def validate(root, document):
    root = Path(root).resolve()
    if (document.get('protocol') != PROTOCOL or document.get('maxExecutions') != 16
            or document.get('maxWorkers') != 2 or document.get('efforts') != list(LEVELS)
            or document.get('repeats') != 2 or document.get('workerOutcomesRead') is not False
            or document.get('newIndependentMeasurement') is not True
            or document.get('recoveryOfPriorUnknownRequests') is not False
            or document.get('oldCohortsExcludedFromPrimary') is not True or document.get('mixOldAndNew') is not False
            or document.get('automaticFurtherRecollection') is not False
            or document.get('model') != repair.MODEL or document.get('provider') != 'openai-codex'
            or document.get('auth') != 'oauth' or document.get('transport') != 'corral'):
        raise ValueError('invalid bounded measurement amendment')
    rows = document.get('cases', [])
    if len(rows) != 2 or {row.get('id') for row in rows} != set(TARGETS):
        raise ValueError('only the two authorized families may be recollected')
    for row in rows:
        source = root / 'outcomes/validated' / row['id'] / 'case.json'
        if row['casePath'] != str(source.relative_to(root)) or row['priorWorkerRoot'] != '.':
            raise ValueError('measurement source is not the original fixture')
        if any(row.get(key) != value for key, value in source_identity(source).items()):
            raise ValueError('input/test/reference identity changed')
        if repair.sha((root / 'outcomes/quality' / row['id'] / 'receipt.json').read_bytes()) != row['independentReviewHash']:
            raise ValueError('independent original qualification changed')
        expected_root = f"recollection-trials/{document['measurementId']}/{row['id']}"
        if row.get('workerRoot') != expected_root or not (root / expected_root).resolve().is_relative_to(root / 'recollection-trials'):
            raise ValueError('fresh measurement output root required')
        for block_name in ('oldBlock', 'newBlock'):
            block = row.get(block_name, [])
            if len(block) != 8 or {(item.get('effort'), item.get('repeat')) for item in block} != set(BLOCK):
                raise ValueError('each family requires the whole four-level/two-repeat block')
            for item in block:
                prefix = '' if block_name == 'oldBlock' else expected_root + '/'
                expected = f"{prefix}outcomes/trials-corral/{row['id']}/{item['effort']}/{item['repeat']}"
                if item.get('directory') != expected:
                    raise ValueError('a block path changed')
                if block_name == 'oldBlock' and item.get('hadReceipt') != ((item['effort'], item['repeat']) != TARGETS[row['id']]):
                    raise ValueError('original missingness differs from the declared basis')
    return document


def apply_manifest(root, candidates, manifest):
    root = Path(root).resolve(); path = Path(manifest).resolve()
    raw = path.read_bytes(); document = validate(root, json.loads(raw))
    replacements = {row['id']: row for row in document['cases']}; seen = set(); result = []
    for row in candidates:
        replacement = replacements.get(row['id'])
        if replacement is None:
            result.append(row); continue
        if (row['origin'] != 'original' or row['version'] != 0 or row['workerRoot'] != '.'
                or row['casePath'] != replacement['casePath'] or row['family'] != replacement['family']
                or row['independentReviewHash'] != replacement['independentReviewHash']):
            raise ValueError('recollection cannot replace another case, revision, or family')
        seen.add(row['id'])
        result.append({**row, 'priorWorkerRoot': '.', 'workerRoot': replacement['workerRoot'],
                       'workerCohort': 'declared-full-block-recollection', 'measurementVersion': document['measurementId'],
                       'recollectionManifestHash': repair.sha(raw), 'oldCohortExcluded': True})
    if seen != set(TARGETS):
        raise ValueError('both declared original families must remain in the qualified cohort')
    return result


def run_job(root, document, row, effort, repeat):
    validate(root, document)
    if row not in document['cases'] or (effort, repeat) not in BLOCK:
        raise ValueError('unplanned measurement')
    output = Path(root) / row['workerRoot']; status = output / 'job-status' / f'{effort}-{repeat}.json'
    started = status.with_name(f'{effort}-{repeat}.started.json')
    if status.exists():
        return json.loads(status.read_text())
    if started.exists():
        return {'id': row['id'], 'effort': effort, 'repeat': repeat, 'state': 'unsettled'}
    repair.write_once(started, {'startedAt': repair.now(), 'loadAverage': list(os.getloadavg()),
                               'measurementId': document['measurementId'], 'workerOutcomesRead': False})
    try:
        case = repair.fixture_fields((Path(root) / row['casePath']).read_bytes())
        outcome = trial(SimpleNamespace(root=str(output), transport='corral'), case, effort, repeat)
        state = outcome['state']
    except Exception as error:
        state = f'unsettled-{type(error).__name__}'
    result = {'id': row['id'], 'effort': effort, 'repeat': repeat, 'state': state,
              'settledAt': repair.now(), 'loadAverage': list(os.getloadavg()), 'workerOutcomesRead': False}
    repair.write_once(status, result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args(); os.umask(0o077)
    if args.prepare:
        document = prepare(args.root, args.manifest)
        print(json.dumps({'manifest': str(args.manifest), 'cases': list(TARGETS), 'maxExecutions': document['maxExecutions']}))
        return
    document = validate(args.root, json.loads(args.manifest.read_text()))
    for name, digest in document['collectorHashes'].items():
        if repair.sha((HERE / name).read_bytes()) != digest:
            raise ValueError('worker collector changed after the measurement amendment')
    jobs = []
    for row in document['cases']:
        for repeat in (0, 1):
            levels = list(LEVELS); random.Random(f"{row['id']}:{repeat}:41").shuffle(levels)
            jobs.extend((row, effort, repeat) for effort in levels)
    results = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for future in as_completed([pool.submit(run_job, args.root, document, *job) for job in jobs]):
            result = future.result(); results.append(result)
            print(json.dumps(result), flush=True)
    summary = {'measurementId': document['measurementId'], 'planned': 16,
               'complete': sum(row['state'] in ('complete', 'cached') for row in results),
               'incomplete': sum(row['state'] not in ('complete', 'cached') for row in results),
               'workerOutcomesRead': False, 'endedAt': repair.now(), 'results': results}
    repair.write_once(args.manifest.parent / 'status.json', summary)
    print(json.dumps({key: summary[key] for key in ('planned', 'complete', 'incomplete')}))


if __name__ == '__main__':
    main()
