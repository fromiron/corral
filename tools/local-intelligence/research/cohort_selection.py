#!/usr/bin/env python3
"""Draft outcome-blind cohort qualification. Never opens worker receipts/answers.

Selection uses independent quality, the frozen visible-input family audit, and
fixed identity ordering only. Availability is inspected AFTER selection, using
receipt existence and orchestration status metadata. Nothing is frozen here.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess

import repair_fixtures as repair

LEVELS = ('low', 'medium', 'high', 'xhigh')
POLICY = 'blind-family-selection-v1-seed41'
IDENTITY_FIELDS = ('id', 'group', 'version', 'kind', 'caseHash', 'revisedCaseHash', 'inputHash',
                   'testHash', 'independentReviewHash', 'frozenAt', 'casePath', 'sourceRoot')


def projected(raw, keys):
    spans = repair.field_spans(raw); text = raw.decode('utf8')
    return {key: json.loads(text[spans[key][0]:spans[key][1]]) for key in keys if key in spans}


def metadata(path, keys):
    return projected(Path(path).read_bytes(), keys)


def _group_rank(group):
    return hashlib.sha256(f'{POLICY}:{group}'.encode()).hexdigest()


def select_candidates(candidates, target=200):
    """Pure selection: no receipt counts, completion, success, cost, or predictions."""
    candidates = list(candidates)
    development_families = {row['family'] for row in candidates if row['phase'] == 'development'}
    final_families = {row['family'] for row in candidates if row['phase'] == 'final'}
    cross_phase = development_families & final_families
    grouped = defaultdict(list)
    for row in candidates:
        if row['family'] not in cross_phase:
            grouped[(row['phase'], row['family'])].append(row)
    # The lowest case ID then earliest approved version is fixed before looking
    # at availability. A missing selected case is never replaced by another.
    representatives = [min(rows, key=lambda row: (row['id'], row['version'], row['origin']))
                       for rows in grouped.values()]
    final = sorted((row for row in representatives if row['phase'] == 'final'),
                   key=lambda row: (_group_rank(row['family']), row['family']))
    development = sorted((row for row in representatives if row['phase'] == 'development'),
                         key=lambda row: (row['family'], row['id']))
    return {'selected': final[:target], 'reserve': final[target:], 'families': final,
            'development': development, 'crossPhaseExcluded': sorted(cross_phase)}


def availability(root, row, active_outputs):
    root = Path(root).resolve()
    worker_root = row.get('workerRoot')
    if worker_root is None:
        return {'complete': False, 'receiptCount': 0, 'expectedReceipts': 8,
                'missing': [{'effort': level, 'repeat': repeat, 'state': 'pending-unclaimed'}
                            for level in LEVELS for repeat in (0, 1)]}
    worker = (root / worker_root).resolve()
    if not worker.is_relative_to(root):
        raise ValueError('worker root escaped the experiment')
    missing = []; complete = 0
    for effort in LEVELS:
        for repeat in (0, 1):
            folder = worker / 'outcomes/trials-corral' / row['id'] / effort / str(repeat)
            # Never open receipt.json, answer.json, prompt, transport usage or logs.
            if (folder / 'receipt.json').is_file():
                complete += 1
                continue
            state_path = worker / 'job-status' / f'{effort}-{repeat}.json'
            state = metadata(state_path, ('state',)).get('state') if state_path.exists() else None
            if str(folder.resolve()) in active_outputs:
                state = 'inflight'
            elif state in ('complete', 'cached'):
                state = 'missing-receipt'
            elif state:
                state = f'settled-{state}'
            elif (folder / 'started.json').exists():
                state = 'started-unsettled'
            else:
                state = 'pending'
            missing.append({'effort': effort, 'repeat': repeat, 'state': state})
    return {'complete': not missing, 'receiptCount': complete, 'expectedReceipts': 8, 'missing': missing}


def processes(root):
    root = Path(root).resolve()
    outputs = set(); calls = []; watchers = []
    snapshot = subprocess.check_output(['ps', '-eo', 'pid=,ppid=,etimes=,comm=,args='], text=True)
    for line in snapshot.splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) != 5:
            continue
        pid, parent, elapsed, _, command = parts
        head = command.split(None, 2)
        supported = {'subscription.ts', 'hive.ts', 'repair_fixtures.py', 'qualified_trials.py',
                     'review_fixtures.py', 'validate-supplemental.py', 'recollect_outcomes.py', 'review-budget-escalation.py'}
        if (len(head) < 2 or Path(head[0]).name not in ('python', 'python3', 'node')
                or Path(head[1]).name not in supported):
            continue
        args = shlex.split(command)
        if len(args) < 2 or Path(args[0]).name not in ('python', 'python3', 'node'):
            continue
        script = Path(args[1]).name
        if script == 'subscription.ts' and len(args) >= 7:
            output = Path(args[4]).resolve(); role = args[6]
        elif script == 'hive.ts' and len(args) >= 5:
            output = Path(args[4]).resolve(); role = 'reviewer'
        else:
            output = None; role = None
        if output is not None and output.is_relative_to(root):
            calls.append({'pid': int(pid), 'parentPid': int(parent), 'elapsedSeconds': int(elapsed),
                          'role': role, 'directory': str(output.parent.relative_to(root))})
            if role == 'worker':
                outputs.add(str(output.parent))
        if script in ('repair_fixtures.py', 'qualified_trials.py', 'review_fixtures.py', 'validate-supplemental.py', 'recollect_outcomes.py', 'review-budget-escalation.py') and str(root) in command:
            bound = int(args[args.index('--watch-seconds') + 1]) if '--watch-seconds' in args else None
            watchers.append({'pid': int(pid), 'script': script, 'elapsedSeconds': int(elapsed),
                             'watchSeconds': bound, 'remainingSeconds': max(0, bound - int(elapsed)) if bound else None,
                             'supplemental': '--supplemental-only' in args or str(root / 'supplemental') in command})
    return {'activeCalls': calls, 'watchers': watchers}, outputs


def read_audit(root):
    directory = root / 'outcomes/visible-audit-result'
    manifest = metadata(directory / 'manifest.json', ('splits', 'quarantined', 'groups', 'total', 'sourceManifestSha256'))
    kept = {}
    for split in ('fit', 'calibration', 'policy', 'final'):
        raw = (directory / f'{split}.jsonl').read_bytes()
        if repair.sha(raw) != manifest['splits'][split]['sha256']:
            raise ValueError('visible audit snapshot hash changed')
        for line in raw.splitlines():
            row = projected(line, ('id', 'group', 'split'))
            if row['id'] in kept or row['split'] != split:
                raise ValueError('invalid visible audit identity')
            kept[row['id']] = {'family': row['group'], 'phase': 'final' if split == 'final' else 'development'}
    source_ids = set()
    source = root / 'outcomes/visible-audit-source'
    if repair.sha((source / 'manifest.json').read_bytes()) != manifest['sourceManifestSha256']:
        raise ValueError('visible source audit changed')
    for split in ('fit', 'calibration', 'policy', 'final'):
        for line in (source / f'{split}.jsonl').read_bytes().splitlines():
            source_ids.add(projected(line, ('id',))['id'])
    return kept, source_ids - set(kept), manifest


def approved_quality(path):
    canonical = path
    if not path.exists():
        path = path.parent / 'high-budget-65536-v1/qualification.json'
        if not path.exists():
            return None
    raw = path.read_bytes()
    record = projected(raw, ('id', 'valid', 'effort', 'transport', 'model', 'requestHash', 'responseHash', 'completedAt'))
    approved = (record.get('valid') is True and record.get('effort') == 'high'
                and record.get('transport') == 'corral-credential-hive'
                and 'deepseek' in str(record.get('model', '')).lower()
                and repair.field_bytes(raw, 'issues').strip() == b'[]')
    return {'approved': approved, 'metadata': record, 'recordHash': repair.sha(raw),
            'canonicalPublished': path == canonical}


def _cohorts(root):
    found = {}
    for path in sorted((root / 'qualified-trials').glob('outcome-*/cohort.json')):
        raw = path.read_bytes()
        record = projected(raw, ('protocol', 'createdAt', 'requiresFreshWorkerCohort', 'mayRegradePriorWorkerAnswers',
                                 'workerOutcomesRead', 'phase', 'workerRoot', 'levels', 'repeats', 'sourceManifestHash'))
        identity = projected(repair.field_bytes(raw, 'identity'), IDENTITY_FIELDS)
        if (record.get('requiresFreshWorkerCohort') is not True or record.get('mayRegradePriorWorkerAnswers') is not False
                or record.get('workerOutcomesRead') is not False or record.get('levels') != list(LEVELS) or record.get('repeats') != 2):
            raise ValueError('invalid fresh cohort qualification metadata')
        expected = str(path.parent.relative_to(root))
        if record.get('workerRoot') != expected:
            raise ValueError('fresh worker root differs from its record')
        key = (identity['id'], identity['version'])
        if key in found:
            raise ValueError('duplicate fresh cohort identity')
        if datetime.fromisoformat(record['createdAt'].replace('Z', '+00:00')) < datetime.fromisoformat(identity['frozenAt'].replace('Z', '+00:00')):
            raise ValueError('fresh cohort predates frozen checks')
        found[key] = {'workerRoot': expected, 'identity': identity, 'cohortHash': repair.sha(raw)}
    return found


def inventory(root, audit, quarantined):
    candidates = []; excluded = []; source_counts = Counter(); cohorts = _cohorts(root)
    for origin, source in (('original', root), ('supplemental', root / 'supplemental')):
        for case_path in sorted((source / 'outcomes/validated').glob('outcome-*/case.json')):
            case_id = case_path.parent.name
            if not re.fullmatch(r'outcome-\d{4}-\d{2}', case_id):
                raise ValueError('invalid fixture directory identity')
            source_counts[origin] += 1
            basic = {'id': case_id, 'origin': origin}
            if case_id not in audit:
                excluded.append({**basic, 'reason': 'audit-quarantined' if case_id in quarantined else 'not-audited'})
                continue
            phase = 'development' if int(case_id.split('-')[1]) < 20 else 'final'
            if audit[case_id]['phase'] != phase:
                excluded.append({**basic, 'reason': 'audit-phase-conflict'}); continue
            base = {**basic, **audit[case_id]}
            mechanical = case_path.parent / 'receipt.json'
            if not mechanical.exists() or metadata(mechanical, ('id', 'valid')) != {'id': case_id, 'valid': True}:
                excluded.append({**base, 'reason': 'missing-mechanical-qualification'}); continue
            quality = approved_quality(source / 'outcomes/quality' / case_id / 'receipt.json')
            if quality and quality['approved']:
                row = {**base, 'version': 0, 'casePath': str(case_path.relative_to(root)),
                       'independentReviewHash': quality['recordHash'], 'qualityApprovedAt': quality['metadata']['completedAt']}
                if origin == 'original':
                    row['workerRoot'] = '.'
                    row['workerCohort'] = 'original-frozen-checks'
                else:
                    cohort = cohorts.get((case_id, 0))
                    if cohort and cohort['identity'].get('kind') != 'original-approved':
                        raise ValueError('supplemental cohort kind mismatch')
                    row['workerRoot'] = cohort['workerRoot'] if cohort else None
                    row['cohortHash'] = cohort['cohortHash'] if cohort else None
                    row['workerCohort'] = 'fresh-supplemental-original'
                candidates.append(row)
                continue
            revisions = []
            if origin == 'original' and quality is not None:
                for path in sorted((root / 'outcomes/quality-revisions' / case_id).glob('v*/eligible.json')):
                    entry = metadata(path, ('protocol', 'id', 'version', 'casePath', 'originalReviewValid', 'independentReviewValid',
                                             'requiresFreshWorkerCohort', 'mayRegradePriorWorkerAnswers', 'workerOutcomesRead',
                                             'revisedCaseHash', 'inputHash', 'testHash', 'independentReviewHash', 'frozenAt'))
                    if (entry.get('protocol') != repair.PROTOCOL or entry.get('id') != case_id
                            or type(entry.get('version')) is not int or entry['version'] < 1
                            or entry.get('originalReviewValid') is not False or entry.get('independentReviewValid') is not True
                            or entry.get('requiresFreshWorkerCohort') is not True or entry.get('mayRegradePriorWorkerAnswers') is not False
                            or entry.get('workerOutcomesRead') is not False):
                        raise ValueError('invalid revised eligibility metadata')
                    if metadata(path.parent / 'status.json', ('state',)).get('state') != 'eligible':
                        raise ValueError('revised qualification is not settled')
                    reviewed = metadata(path.parent / 'reviewer/answer.json.receipt.json', ('model', 'effort', 'transport'))
                    if reviewed.get('effort') != 'high' or reviewed.get('transport') != 'corral-credential-hive' or 'deepseek' not in str(reviewed.get('model', '')).lower():
                        raise ValueError('revised independent reviewer identity invalid')
                    cohort = cohorts.get((case_id, entry['version']))
                    if cohort and any(cohort['identity'].get(key) != entry[key] for key in ('revisedCaseHash', 'inputHash', 'testHash', 'independentReviewHash')):
                        raise ValueError('fresh worker qualification differs from approved revision')
                    revisions.append({**base, 'origin': 'repaired', 'version': entry['version'], 'casePath': entry['casePath'],
                                      'revisedCaseHash': entry['revisedCaseHash'], 'inputHash': entry['inputHash'], 'testHash': entry['testHash'],
                                      'independentReviewHash': entry['independentReviewHash'], 'qualityApprovedAt': entry['frozenAt'],
                                      'workerRoot': cohort['workerRoot'] if cohort else None,
                                      'cohortHash': cohort['cohortHash'] if cohort else None,
                                      'workerCohort': 'fresh-approved-revision'})
            candidates.extend(revisions)
            if not revisions:
                reason = 'awaiting-independent-review' if quality is None else 'independent-rejection-no-approved-revision'
                excluded.append({**base, 'reason': reason,
                                 'automaticRepairQueued': quality.get('canonicalPublished', False) if quality else False})
    return candidates, excluded, dict(source_counts)


def _coverage(rows):
    states = Counter(item['state'] for row in rows for item in row['availability']['missing'])
    return {'families': len(rows), 'receiptCompleteFamilies': sum(row['availability']['complete'] for row in rows),
            'incompleteFamilies': sum(not row['availability']['complete'] for row in rows),
            'presentReceipts': sum(row['availability']['receiptCount'] for row in rows),
            'expectedReceipts': len(rows) * 8, 'missingStates': dict(states)}


def qualification_backlog(root, exclusions, final_families, process_info):
    """Status-only ceiling; never assumes a rejected or truncated review passes."""
    review_states = Counter(); repairs = []; supplemental_rejections = 0
    active_directories = {item['directory'] for item in process_info['activeCalls']}
    repair_watcher_active = any(item['script'] == 'repair_fixtures.py' for item in process_info['watchers'])
    for row in exclusions:
        source = root / 'supplemental' if row['origin'] == 'supplemental' else root
        if row['reason'] == 'awaiting-independent-review':
            directory = source / 'outcomes/quality' / row['id']
            attempts = [directory, directory / 'larger-high-budget', directory / 'high-budget-65536-v1']
            started = [path for path in attempts if (path / 'answer.json.request.json').exists()]
            current = started[-1] if started else directory
            if (current / 'answer.json.incomplete.json').exists():
                state = 'known-truncated-no-qualification'
            elif (current / 'answer.json.receipt.json').exists():
                state = 'transport-complete-qualification-absent'
            elif str(current.relative_to(root)) in active_directories:
                state = 'review-inflight'
            else:
                state = 'unknown-review' if started else 'review-not-started'
            review_states[f"{row['origin']}:{state}"] += 1
        elif row['reason'] == 'independent-rejection-no-approved-revision':
            if row['origin'] == 'supplemental':
                supplemental_rejections += 1
                continue
            directory = root / 'outcomes/quality-revisions' / row['id']
            versions = sorted(directory.glob('v*'), key=lambda path: int(path.name[1:]))
            version = int(versions[-1].name[1:]) if versions else 0
            status = versions[-1] / 'status.json' if versions else None
            state = metadata(status, ('state',)).get('state') if status and status.exists() else 'unfinished' if versions else 'not-started'
            # Current repair queue was launched with the documented default of
            # three revisions; terminal unknowns and exhausted revisions stay out.
            possible = (repair_watcher_active and row.get('automaticRepairQueued', True) and
                        (state in ('not-started', 'unfinished') or
                         (state in ('review-rejected', 'mechanical-rejected') and version < 3)))
            repairs.append({'id': row['id'], 'family': row['family'], 'phase': row['phase'],
                            'version': version, 'state': state, 'mayStillQualifyFromCurrentQueue': possible})
    additional = {row['family'] for row in repairs if row['phase'] == 'final' and row['mayStillQualifyFromCurrentQueue']} - set(final_families)
    review_potential = set(); review_jobs = []
    for plan_path in sorted((root / 'outcomes/quality-review-escalation').glob('*/plan.json')):
        plan = metadata(plan_path, ('protocol', 'selected'))
        if plan.get('protocol') != 'bounded-known-terminal-review-escalation-v1':
            continue
        for entry in plan['selected']:
            status_path = plan_path.parent / 'jobs' / entry['id'] / 'status.json'
            status = metadata(status_path, ('state', 'valid')) if status_path.exists() else {}
            possible = status.get('valid') is True or not status
            if possible:
                review_potential.add(entry['family'])
            review_jobs.append({'id': entry['id'], 'family': entry['family'], 'state': status.get('state', 'queued-or-inflight'),
                                'mayStillQualifyFromBoundedReviewQueue': possible})
    review_potential -= set(final_families)
    return {'missingIndependentReviewStates': dict(review_states), 'repairStates': repairs,
            'supplementalRejectedWithoutRepairQueue': supplemental_rejections,
            'possibleAdditionalFinalFamiliesFromCurrentRepairQueue': sorted(additional),
            'boundedReviewJobs': review_jobs,
            'possibleAdditionalFinalFamiliesFromBoundedReviewQueue': sorted(review_potential),
            'maximumQualifiedFinalFamiliesFromCurrentQueues': len(set(final_families) | additional | review_potential),
            'ceilingOnly': True,
            'note': 'Unknown/truncated calls are not replayed. Additional quality calls or new fixtures require a separate authorization decision; no final outcomes were inspected.'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--target', type=int, default=200)
    parser.add_argument('--recollection-manifest', type=Path)
    args = parser.parse_args()
    if args.target < 1:
        parser.error('positive target required')
    root = args.root.resolve(); output = args.out.resolve()
    if output.exists() or not output.is_relative_to(root / 'outcomes/cohort-drafts'):
        raise ValueError('use a new private outcomes/cohort-drafts directory; nothing is overwritten')
    process_info, active_outputs = processes(root)
    audit, quarantined, audit_manifest = read_audit(root)
    candidates, exclusions, source_counts = inventory(root, audit, quarantined)
    if args.recollection_manifest:
        from recollect_outcomes import apply_manifest
        candidates = apply_manifest(root, candidates, args.recollection_manifest)
    selection = select_candidates(candidates, target=args.target)
    # Seal the identity decision in memory before asking which workers completed.
    def annotate(rows):
        annotated = []
        for row in rows:
            receipts = [{'effort': level, 'repeat': repeat,
                         'path': str((root / row['workerRoot'] / 'outcomes/trials-corral' / row['id'] / level / str(repeat) / 'receipt.json').resolve())}
                        for level in LEVELS for repeat in (0, 1)] if row.get('workerRoot') is not None else []
            annotated.append({**row, 'group': row['family'], 'receipts': receipts,
                              'visibleFixturePath': str((root / row['casePath']).resolve()),
                              'availability': availability(root, row, active_outputs)})
        return annotated
    all_final = annotate(selection['families'])
    chosen = all_final[:args.target]
    development = annotate(selection['development'])
    candidate_keys = {(row['id'], row['version']) for row in selection['families'] + selection['development']}
    duplicates = [row for row in candidates if (row['id'], row['version']) not in candidate_keys]
    summary = {
        'draft': True, 'frozen': False, 'createdAt': repair.now(), 'policy': POLICY,
        'selectorHash': repair.sha(Path(__file__).read_bytes()),
        'sourceCounts': source_counts, 'qualifiedCaseVersions': len(candidates),
        'qualifiedOrigins': dict(Counter(row['origin'] for row in candidates)),
        'allQualifiedFinal': _coverage(all_final), 'deterministicFinalTarget': _coverage(chosen),
        'development': _coverage(development), 'duplicateCaseVersions': len(duplicates),
        'auditQuarantinedIds': sorted(quarantined), 'crossPhaseExcluded': selection['crossPhaseExcluded'],
        'exclusions': dict(Counter(row['reason'] for row in exclusions)),
        'processes': process_info, 'visibleAudit': audit_manifest,
        'receiptPresenceOnly': True, 'workerOutcomesRead': False,
        'statisticalGateReady': False,
        'recollectionManifest': str(args.recollection_manifest) if args.recollection_manifest else None,
        'gateNote': 'Receipt presence is status evidence only; explicit success and positive reported token validity remain sealed and unverified.',
    }
    summary['qualificationBacklog'] = qualification_backlog(root, exclusions, {row['family'] for row in all_final}, process_info)
    manifest = {
        'draft': True, 'frozen': False, 'createdAt': summary['createdAt'], 'policy': POLICY, 'targetFamilies': args.target,
        'selectorHash': summary['selectorHash'],
        'selectionRule': 'independent quality and frozen visible audit; lowest case ID then lowest approved version per family; SHA256(policy:family) rank; first target families',
        'availabilityAffectsSelection': False, 'workerOutcomesRead': False,
        'missingnessPolicyProposal': 'Keep every selected family and both repeats. No substitution, success imputation, zero-cost imputation, or replay of unknown provider calls. Missing selected data blocks the paired gate.',
        'originalPolicy': 'approved original tests retain original cohort',
        'revisionPolicy': 'approved revisions require their separately pinned fresh cohort; no old-answer regrading',
        'recollectionManifest': summary['recollectionManifest'],
        'final': chosen, 'reserve': all_final[args.target:], 'development': development,
        'allQualifiedFinal': all_final, 'duplicates': duplicates, 'exclusions': exclusions,
    }
    output.mkdir(parents=True, mode=0o700)
    repair.write_once(output / 'summary.json', summary)
    repair.write_once(output / 'manifest.json', manifest)
    print(json.dumps({key: summary[key] for key in ('sourceCounts', 'qualifiedOrigins', 'allQualifiedFinal', 'deterministicFinalTarget', 'development', 'duplicateCaseVersions', 'exclusions')}))


if __name__ == '__main__':
    main()
