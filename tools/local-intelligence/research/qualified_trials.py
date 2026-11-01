#!/usr/bin/env python3
"""Fresh workers for independently approved fixture revisions; outcomes stay sealed.

Only immutable qualification evidence and this runner's state are read here.
The existing trial transport handles its own new answers and grading. Its success
and usage values are deliberately discarded from orchestration logs/reports.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import random
import re
import time
from types import SimpleNamespace

import repair_fixtures as repair
from trials import LEVELS, trial

ORIGINAL_PROTOCOL = 'blind-approved-original-v0-new-worker-cohort'


def _fresh(value, protocol=repair.PROTOCOL):
    if (value.get('protocol') != protocol
            or value.get('requiresFreshWorkerCohort') is not True
            or value.get('mayRegradePriorWorkerAnswers') is not False
            or value.get('workerOutcomesRead') is not False):
        raise ValueError('only approved new-worker-cohort evidence is accepted')


def _checked_file(path, digest):
    content = path.read_bytes()
    if not isinstance(digest, str) or repair.sha(content) != digest:
        raise ValueError('immutable qualification artifact hash mismatch')
    return content


def admit(root, entry):
    """Validate immutable source, amended checks, and both high-effort receipts."""
    root = Path(root).resolve()
    _fresh(entry)
    case_id, version = entry.get('id'), entry.get('version')
    if (not isinstance(case_id, str) or not re.fullmatch(r'outcome-\d{4}-\d{2}', case_id)
            or type(version) is not int or version < 1):
        raise ValueError('invalid revised fixture identity')
    directory = root / 'outcomes/quality-revisions' / case_id / f'v{version}'
    case_path, amendment_path = directory / 'case.json', directory / 'amendment.json'
    if (entry.get('casePath') != str(case_path.relative_to(root))
            or entry.get('amendmentPath') != str(amendment_path.relative_to(root))
            or not directory.resolve().is_relative_to(root / 'outcomes/quality-revisions')):
        raise ValueError('qualification paths must address the declared revision')
    amended_raw = amendment_path.read_bytes()
    amended = json.loads(amended_raw)
    expected = {**amended, 'casePath': entry['casePath'], 'amendmentPath': entry['amendmentPath']}
    if entry != expected:
        raise ValueError('snapshot entry differs from immutable amendment')
    _fresh(amended)
    if (amended.get('originalReviewValid') is not False
            or amended.get('independentReviewValid') is not True
            or amended.get('mutableFields') != list(repair.MUTABLE_FIELDS)
            or amended.get('protectedFields') != list(repair.PROTECTED_FIELDS)):
        raise ValueError('fixture amendment is not independently approved')
    frozen = datetime.fromisoformat(amended['frozenAt'].replace('Z', '+00:00'))
    if frozen.tzinfo is None or frozen > datetime.now(timezone.utc):
        raise ValueError('revised tests must already be frozen')
    original = _checked_file(root / 'outcomes/validated' / case_id / 'case.json', entry['originalCaseHash'])
    revised = _checked_file(case_path, entry['revisedCaseHash'])
    if set(repair.field_spans(original)) != set(repair.field_spans(revised)):
        raise ValueError('revision changed fixture fields')
    for key in repair.field_spans(original):
        if key not in repair.MUTABLE_FIELDS and repair.field_bytes(original, key) != repair.field_bytes(revised, key):
            raise ValueError('protected fixture bytes changed')
    case = repair.fixture_fields(revised)
    if case['id'] != case_id or not isinstance(case['group'], str) or not case['group'].strip():
        raise ValueError('fixture identity or group is invalid')
    if (repair.input_hash(original) != entry['inputHash']
            or repair.input_hash(revised) != entry['inputHash']
            or repair.test_hash(revised) != entry['testHash']
            or repair.sha(repair.canonical(case['referenceFiles'])) != entry['referenceHash']):
        raise ValueError('visible input, test, or reference hash mismatch')
    original_review = json.loads(_checked_file(directory / 'original-review.json', entry['originalReviewHash']))
    if original_review.get('valid') is not False or original_review.get('effort') != 'high':
        raise ValueError('original independent rejection must be recorded at high effort')
    mechanical = json.loads(_checked_file(directory / 'mechanical.json', entry['mechanicalReceiptHash']))
    if mechanical.get('reference', {}).get('passed') is not True or mechanical.get('buggy', {}).get('passed') is not False:
        raise ValueError('reference-pass and buggy-fail evidence is required')
    status = json.loads((directory / 'status.json').read_text())
    if status.get('state') != 'eligible':
        raise ValueError('rejected or unsettled revisions cannot execute')
    artifacts = amended.get('artifacts')
    integrity_hash = None
    if artifacts is None:
        # Early v1 revisions have an additional immutable integrity snapshot.
        integrity_raw = (directory / 'artifact-integrity.json').read_bytes()
        integrity_hash = repair.sha(integrity_raw)
        artifacts = json.loads(integrity_raw)['artifacts']
    required = {
        f'{stage}/{name}' for stage in ('teacher', 'reviewer')
        for name in ('prompt.txt', 'answer.json', 'answer.json.receipt.json', 'answer.json.request.json')
    }
    if not isinstance(artifacts, dict) or not required <= set(artifacts):
        raise ValueError('teacher and independent reviewer artifact bindings are incomplete')
    for name, digest in artifacts.items():
        path = directory / name
        if not path.resolve().is_relative_to(directory.resolve()):
            raise ValueError('qualification artifact escaped its revision')
        _checked_file(path, digest)
    teacher = json.loads((directory / 'teacher/answer.json.receipt.json').read_text())
    if (teacher.get('model') != repair.MODEL or teacher.get('effort') != 'high'
            or teacher.get('role') != 'teacher' or teacher.get('provider') != 'openai-codex'
            or teacher.get('transport') != 'corral-pi-subscription'
            or teacher.get('wire') != {'kind': 'effort', 'value': 'high'}
            or teacher.get('promptHash') != entry['teacherRequestHash']
            or teacher.get('responseHash') != entry['teacherResponseHash']):
        raise ValueError('repair teacher provenance must verify explicit high subscription effort')
    _checked_file(directory / 'teacher/prompt.txt', teacher['promptHash'])
    teacher_answer = json.loads(_checked_file(directory / 'teacher/answer.json', teacher['responseHash']))
    if (teacher_answer.get('status') != 'repaired'
            or any(teacher_answer.get(key) != case[key] for key in repair.MUTABLE_FIELDS)):
        raise ValueError('qualified fixture differs from the completed repair')
    reviewer_raw = _checked_file(directory / 'reviewer/answer.json.receipt.json', entry['independentReviewHash'])
    reviewer = json.loads(reviewer_raw)
    reviewer_request = json.loads((directory / 'reviewer/answer.json.request.json').read_text())
    if (reviewer.get('transport') != 'corral-credential-hive' or reviewer.get('effort') != 'high'
            or 'deepseek' not in str(reviewer.get('model', '')).lower()
            or reviewer.get('requestHash') != entry['reviewerRequestHash']
            or reviewer.get('responseHash') != entry['reviewerResponseHash']
            or any(reviewer_request.get(key) != reviewer.get(key) for key in ('model', 'effort', 'transport', 'requestHash'))):
        raise ValueError('independent Hive DeepSeek review must verify explicit high effort')
    reviewed = json.loads(_checked_file(directory / 'reviewer/answer.json', reviewer['responseHash']))
    if reviewed.get('valid') is not True or reviewed.get('issues') != []:
        raise ValueError('independent reviewer did not approve the revision')
    if (directory / 'reviewer/prompt.txt').read_text() != repair.review_prompt(case):
        raise ValueError('independent review did not use the unchanged criterion and revised fixture')
    identity = {
        'id': case_id, 'group': case['group'], 'version': version,
        'originalCaseHash': entry['originalCaseHash'], 'revisedCaseHash': entry['revisedCaseHash'],
        'inputHash': entry['inputHash'], 'testHash': entry['testHash'],
        'amendmentHash': repair.sha(amended_raw), 'integritySnapshotHash': integrity_hash,
        'workerFixtureHash': repair.sha(json.dumps(case, sort_keys=True)),
        'independentReviewHash': entry['independentReviewHash'],
        'mechanicalReceiptHash': entry['mechanicalReceiptHash'], 'frozenAt': entry['frozenAt'],
    }
    return {'case': case, 'identity': identity}


def _supplemental(root, supplied):
    root, source = Path(root).resolve(), Path(supplied).resolve()
    if source != (root / 'supplemental').resolve() or source == root:
        raise ValueError('original admission requires the explicitly selected supplemental source')
    return root, source


def _authored_case(raw, wanted):
    """Select one authored object without decoding difficulty/rationale metadata."""
    text = repair.field_bytes(raw, 'cases').decode('utf8'); offset = 1; index = 0
    while offset < len(text):
        while offset < len(text) and (text[offset].isspace() or text[offset] == ','):
            offset += 1
        if offset >= len(text) or text[offset] == ']':
            break
        end = repair._value_end(text, offset)
        if index == wanted:
            item = text[offset:end].encode()
            return {key: json.loads(repair.field_bytes(item, key))
                    for key in (*repair.REVIEW_FIELDS, 'family')}
        offset = end; index += 1
    raise ValueError('authored fixture index is absent')


def admit_original(root, supplemental_root, case_path):
    root, source = _supplemental(root, supplemental_root)
    case_path = Path(case_path).resolve(); case_id = case_path.parent.name
    if (not re.fullmatch(r'outcome-\d{4}-\d{2}', case_id)
            or case_path != source / 'outcomes/validated' / case_id / 'case.json'):
        raise ValueError('original fixture must belong to the selected supplemental source')
    artifacts = {}

    def read(path):
        path = Path(path)
        if not path.resolve().is_relative_to(source):
            raise ValueError('original evidence escaped its selected source')
        raw = path.read_bytes(); artifacts[str(path.relative_to(source))] = repair.sha(raw)
        return raw

    raw = read(case_path); case = repair.fixture_fields(raw)
    if case['id'] != case_id or not isinstance(case['group'], str) or not case['group'].strip():
        raise ValueError('invalid original fixture identity or family')
    mechanical_raw = read(case_path.parent / 'receipt.json'); mechanical = json.loads(mechanical_raw)
    if (mechanical.get('id') != case_id or mechanical.get('valid') is not True
            or mechanical.get('reference', {}).get('passed') is not True
            or mechanical.get('buggy', {}).get('passed') is not False):
        raise ValueError('original fixture requires reference-pass and buggy-fail')
    batch, index = map(int, case_id.split('-')[1:])
    author = source / 'outcomes/author' / f'{batch:04d}'
    complete = json.loads(read(author / 'complete.json'))
    teacher_raw = read(author / 'answer.json.receipt.json'); teacher = json.loads(teacher_raw)
    answer_raw = read(author / 'answer.json')
    prompt_raw = read(author / 'prompt.txt')
    if (teacher.get('model') != repair.MODEL or teacher.get('effort') != 'high'
            or teacher.get('role') != 'teacher' or teacher.get('provider') != 'openai-codex'
            or teacher.get('transport') != 'corral-pi-subscription'
            or teacher.get('wire') != {'kind': 'effort', 'value': 'high'}
            or teacher.get('responseHash') != repair.sha(answer_raw)
            or teacher.get('promptHash') != repair.sha(prompt_raw)
            or complete.get('model') != repair.MODEL or complete.get('effort') != 'high'
            or complete.get('transport') != 'corral' or complete.get('batch') != batch
            or not isinstance(complete.get('count'), int) or not 0 <= index < complete['count']
            or complete.get('answerHash') != teacher['responseHash']
            or complete.get('promptHash') != teacher['promptHash']):
        raise ValueError('original author provenance must verify high subscription effort')
    authored = _authored_case(answer_raw, index)
    if authored['family'] != case['group'] or any(authored[key] != case[key] for key in repair.REVIEW_FIELDS):
        raise ValueError('original fixture changed after high-effort authoring')
    quality_dir = source / 'outcomes/quality' / case_id
    quality_raw = read(quality_dir / 'receipt.json'); quality = json.loads(quality_raw)
    if (quality.get('id') != case_id or quality.get('valid') is not True
            or quality.get('issues') != [] or quality.get('effort') != 'high'
            or quality.get('transport') != 'corral-credential-hive'
            or 'deepseek' not in str(quality.get('model', '')).lower()):
        raise ValueError('original fixture lacks an approved independent high Hive review')
    attempt = None
    for candidate in (quality_dir, quality_dir / 'larger-high-budget'):
        receipt_path = candidate / 'answer.json.receipt.json'
        if receipt_path.exists():
            receipt = json.loads(read(receipt_path))
            if all(receipt.get(key) == quality.get(key) for key in
                   ('model', 'effort', 'transport', 'requestHash', 'responseHash', 'completedAt')):
                attempt = candidate; break
    if attempt is None:
        raise ValueError('completed independent review transport is absent')
    request = json.loads(read(attempt / 'answer.json.request.json'))
    if any(request.get(key) != quality.get(key) for key in ('model', 'effort', 'transport', 'requestHash')):
        raise ValueError('independent original review request changed')
    response = read(attempt / 'answer.json')
    reviewed = json.loads(response)
    if (repair.sha(response) != quality['responseHash'] or reviewed.get('valid') is not True
            or reviewed.get('issues') != []
            or read(attempt / 'prompt.txt').decode() != repair.review_prompt(case)):
        raise ValueError('independent original review did not approve the exact fixture')
    frozen = datetime.fromisoformat(quality['completedAt'].replace('Z', '+00:00'))
    if frozen.tzinfo is None or frozen > datetime.now(timezone.utc):
        raise ValueError('original review must complete before worker dispatch')
    identity = {
        'kind': 'original-approved', 'id': case_id, 'group': case['group'], 'version': 0,
        'sourceRoot': str(source.relative_to(root)), 'casePath': str(case_path.relative_to(root)),
        'caseHash': repair.sha(raw), 'inputHash': repair.input_hash(raw), 'testHash': repair.test_hash(raw),
        'referenceHash': repair.sha(repair.canonical(case['referenceFiles'])),
        'mechanicalReceiptHash': repair.sha(mechanical_raw), 'independentReviewHash': repair.sha(quality_raw),
        'teacherReceiptHash': repair.sha(teacher_raw), 'workerFixtureHash': repair.sha(json.dumps(case, sort_keys=True)),
        'frozenAt': quality['completedAt'], 'sourceArtifacts': artifacts,
    }
    pin = root / 'qualified-trials/original-approvals' / f'{case_id}.json'
    if pin.exists() and json.loads(pin.read_text())['identity'] != identity:
        raise ValueError('original fixture or qualification evidence changed after first-dispatch pin')
    return {'case': case, 'identity': identity}


def original_snapshot(root, supplemental_root):
    root, source = _supplemental(root, supplemental_root)
    entries = []; rejected = waiting = 0
    for case_path in sorted((source / 'outcomes/validated').glob('outcome-*/case.json')):
        if not (source / 'outcomes/quality' / case_path.parent.name / 'receipt.json').exists():
            waiting += 1; continue
        try:
            admission = admit_original(root, source, case_path); identity = admission['identity']
            pin = root / 'qualified-trials/original-approvals' / f"{identity['id']}.json"
            if not pin.exists():
                repair.write_once(pin, {'protocol': ORIGINAL_PROTOCOL, 'identity': identity,
                                        'pinnedAt': repair.now(), 'workerOutcomesRead': False})
            entries.append({'id': identity['id'], 'version': 0, 'frozenAt': identity['frozenAt'],
                            'casePath': identity['casePath'], 'pinPath': str(pin.relative_to(root)),
                            'pinHash': repair.sha(pin.read_bytes()), 'identity': identity})
        except (ValueError, KeyError, OSError, TypeError):
            rejected += 1
    document = {'protocol': ORIGINAL_PROTOCOL, 'sourceRoot': str(source.relative_to(root)),
                'requiresFreshWorkerCohort': True, 'mayRegradePriorWorkerAnswers': False,
                'workerOutcomesRead': False, 'cases': entries,
                'admissionCounts': {'approved': len(entries), 'rejected': rejected, 'awaitingReview': waiting}}
    digest = repair.sha(repair.canonical(document))
    manifest = root / 'qualified-trials/original-manifests' / f'eligible-original-{digest}.json'
    if not manifest.exists():
        repair.write_once(manifest, {**document, 'createdAt': repair.now()})
    return manifest


def claim(root, admission, manifest, *, output_root=None):
    root = Path(root).resolve(); identity = admission['identity']
    case_hash = identity.get('caseHash', identity.get('revisedCaseHash'))
    expected = root / 'qualified-trials' / f"{identity['id']}-v{identity['version']}-{case_hash[:12]}"
    output = expected if output_root is None else Path(output_root).resolve()
    if output != expected or not output.resolve().is_relative_to(root / 'qualified-trials'):
        raise ValueError('workers require the dedicated fresh version output root')
    selection = root / 'qualified-trials/selections' / f"{repair.sha(identity['group'])}.json"
    if selection.exists():
        prior = json.loads(selection.read_text())
        if prior['identity'] != identity:
            return None
    record = output / 'cohort.json'
    if record.exists():
        saved = json.loads(record.read_text())
        if saved['identity'] != identity:
            raise ValueError('existing fresh cohort identity changed')
    else:
        if output.exists() and any(output.iterdir()):
            raise ValueError('unclaimed nonempty worker roots cannot be reused')
        saved = {'protocol': ORIGINAL_PROTOCOL if identity.get('kind') == 'original-approved' else repair.PROTOCOL,
                 'identity': identity, 'createdAt': repair.now(),
                 'requiresFreshWorkerCohort': True, 'mayRegradePriorWorkerAnswers': False,
                 'workerOutcomesRead': False, 'phase': 'development' if int(identity['id'].split('-')[1]) < 20 else 'final',
                 'sourceManifest': str(Path(manifest).resolve().relative_to(root)),
                 'sourceManifestHash': repair.sha(Path(manifest).read_bytes()),
                 'workerRoot': str(output.relative_to(root)), 'levels': LEVELS, 'repeats': 2}
        repair.write_once(record, saved)
    if not (output / 'case.json').exists():
        repair.write_once(output / 'case.json', admission['case'])
    if json.loads((output / 'case.json').read_text()) != admission['case']:
        raise ValueError('frozen fresh worker fixture changed')
    if not selection.exists():
        repair.write_once(selection, saved)
    return output


def run_snapshot(root, manifest, *, workers=2, worker=trial, deadline=None, supplemental_root=None):
    root, manifest = Path(root).resolve(), Path(manifest).resolve()
    if workers not in (1, 2):
        raise ValueError('qualified trials allow at most two concurrent workers')
    document = json.loads(manifest.read_bytes())
    originals = document.get('protocol') == ORIGINAL_PROTOCOL
    if originals:
        if supplemental_root is None:
            raise ValueError('original dispatch requires explicit supplemental opt-in')
        _, source = _supplemental(root, supplemental_root)
        if document.get('sourceRoot') != str(source.relative_to(root)):
            raise ValueError('original snapshot addresses another source')
    _fresh(document, ORIGINAL_PROTOCOL if originals else repair.PROTOCOL)
    report = {'scheduled': 0, 'completed': 0, 'incomplete': 0, 'pending': 0,
              'rejected': 0, 'duplicateGroups': 0, 'groups': 0}
    admitted, seen_groups = [], set()
    for entry in sorted(document['cases'], key=lambda item: (item['frozenAt'], item['id'], item['version'])):
        try:
            if originals:
                admission = admit_original(root, source, root / entry['casePath'])
                expected_pin = f"qualified-trials/original-approvals/{admission['case']['id']}.json"
                if entry['pinPath'] != expected_pin:
                    raise ValueError('original pin must address its dedicated approval record')
                pin = _checked_file(root / entry['pinPath'], entry['pinHash'])
                if (json.loads(pin)['identity'] != admission['identity']
                        or entry['identity'] != admission['identity']):
                    raise ValueError('original first-dispatch pin changed')
            else:
                admission = admit(root, entry)
            if admission['case']['group'] in seen_groups:
                report['duplicateGroups'] += 1
                continue
            output = claim(root, admission, manifest)
            if output is None:
                report['duplicateGroups'] += 1
                continue
            admitted.append((admission, output)); report['groups'] += 1
            seen_groups.add(admission['case']['group'])
        except (ValueError, KeyError, OSError, TypeError):
            report['rejected'] += 1

    def execute(job):
        admission, output, effort, repeat = job
        status = output / 'job-status' / f'{effort}-{repeat}.json'
        if status.exists():
            return json.loads(status.read_text())['state']
        if deadline is not None and time.monotonic() >= deadline:
            return 'pending'
        try:
            result = worker(SimpleNamespace(root=str(output), transport='corral'), admission['case'], effort, repeat)
            state = result['state']
            if state not in ('complete', 'cached', 'unsettled', 'timeout', 'provider-error', 'invalid-protocol-tools'):
                state = 'invalid'
        except Exception:
            state = 'invalid'
        repair.write_once(status, {'state': state, 'effort': effort, 'repeat': repeat,
                                  'settledAt': repair.now(), 'workerOutcomesRead': False})
        return state

    # Finish every queued development attempt before launching final attempts.
    # Known failures/unknown outcomes settle scheduling, never imply a success.
    for development in (True, False):
        jobs = []
        for admission, output in admitted:
            case = admission['case']
            if (int(case['id'].split('-')[1]) < 20) != development:
                continue
            for repeat in range(2):
                levels = LEVELS.copy()
                random.Random(f"{case['id']}:{admission['identity']['version']}:{repeat}:41").shuffle(levels)
                jobs.extend((admission, output, effort, repeat) for effort in levels)
        report['scheduled'] += len(jobs)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for future in as_completed([pool.submit(execute, job) for job in jobs]):
                state = future.result()
                report['completed' if state in ('complete', 'cached') else 'pending' if state == 'pending' else 'incomplete'] += 1
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--workers', type=int, default=2, choices=(1, 2))
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--watch-seconds', type=int, default=10800)
    parser.add_argument('--supplemental-root')
    parser.add_argument('--supplemental-only', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.watch_seconds <= 10800:
        parser.error('watch duration must be between one second and three hours')
    if bool(args.supplemental_root) != args.supplemental_only:
        parser.error('supplemental originals require both --supplemental-root and --supplemental-only')
    os.umask(0o077)
    root = Path(args.root).resolve(); output = root / 'qualified-trials'
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_name = '.supplemental-orchestrator.lock' if args.supplemental_only else '.orchestrator.lock'
    with (output / lock_name).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deadline = time.monotonic() + args.watch_seconds
        last = None
        while True:
            paths = ([original_snapshot(root, args.supplemental_root)] if args.supplemental_only
                     else sorted((root / 'outcomes/quality-revisions').glob('eligible-manifest-*.json')))
            if paths:
                manifest = paths[-1]; digest = repair.sha(manifest.read_bytes())
                if digest != last:
                    try:
                        report = run_snapshot(root, manifest, workers=args.workers, deadline=deadline,
                                              supplemental_root=args.supplemental_root)
                        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
                        repair.write_once(output / f'status-{stamp}.json', {
                            **report, 'at': repair.now(), 'manifestHash': digest,
                            'workerOutcomesRead': False, 'scope': 'counts only; no success or cost aggregates',
                        })
                        print(json.dumps(report), flush=True); last = digest
                    except (ValueError, KeyError, OSError, TypeError):
                        # A newly written snapshot may still be incomplete. No work
                        # is admitted until parsing and top-level approval succeed.
                        if not args.watch:
                            raise
            if not args.watch or time.monotonic() >= deadline:
                break
            time.sleep(min(10, max(0, deadline - time.monotonic())))


if __name__ == '__main__':
    main()
