"""Admission and resumption boundaries; never makes live model calls."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import repair_fixtures as repair
import qualified_trials as qualified
import trials
from test_repair_fixtures import original, answer


def fixture(root, *, reviewer_effort='high'):
    raw = original()
    source = root / 'outcomes/validated/outcome-0000-02/case.json'
    repair.write_once(source, raw)
    review = {'valid': False, 'effort': 'high', 'issues': [{'kind': 'weak-tests', 'evidence': 'Missing boundary.'}]}
    review_raw = json.dumps(review).encode()
    repair.write_once(root / 'outcomes/quality/outcome-0000-02/receipt.json', review_raw)

    def invoke(stage, command, timeout):
        value = answer() if stage.name == 'teacher' else {'valid': True, 'issues': []}
        content = json.dumps(value).encode()
        receipt = {'model': repair.MODEL if stage.name == 'teacher' else 'deepseek-test',
                   'provider': 'openai-codex',
                   'effort': 'high' if stage.name == 'teacher' else reviewer_effort,
                   'role': 'teacher',
                   'wire': {'kind': 'effort', 'value': 'high'},
                   'promptHash': repair.sha((stage / 'prompt.txt').read_bytes()),
                   'responseHash': repair.sha(content), 'requestHash': 'test-request-hash',
                   'transport': 'corral-pi-subscription' if stage.name == 'teacher' else 'corral-credential-hive'}
        repair.write_once(stage / 'answer.json', content)
        repair.write_once(stage / 'answer.json.receipt.json', receipt)
        repair.write_once(stage / 'answer.json.request.json', receipt)
        return {'state': 'complete', 'receipt': receipt}

    with patch.object(repair, 'invoke', side_effect=invoke), patch.object(
        repair, 'grade', side_effect=[{'passed': True}, {'passed': False}],
    ):
        repair._revision(SimpleNamespace(root=str(root), config='unused'), 'outcome-0000-02',
                         raw, raw, review, review_raw, review['issues'], 1)
    return Path(repair.write_manifest(root))


def original_fixture(root):
    source = root / 'supplemental'
    raw = original().replace(b'outcome-0000-02', b'outcome-0100-00')
    case = repair.fixture_fields(raw)
    path = source / 'outcomes/validated/outcome-0100-00/case.json'
    repair.write_once(path, raw)
    repair.write_once(path.parent / 'receipt.json', {
        'id': case['id'], 'valid': True, 'reference': {'passed': True}, 'buggy': {'passed': False},
    })
    author = source / 'outcomes/author/0100'
    authored = {key: case[key] for key in repair.REVIEW_FIELDS}
    authored.update({'family': case['group'], 'expectedDifficulty': 'opaque', 'rationale': 'opaque'})
    answer_raw = json.dumps({'cases': [authored]}).encode()
    receipt = {'model': repair.MODEL, 'effort': 'high', 'provider': 'openai-codex',
               'role': 'teacher', 'wire': {'kind': 'effort', 'value': 'high'},
               'transport': 'corral-pi-subscription', 'promptHash': repair.sha('author prompt'),
               'responseHash': repair.sha(answer_raw)}
    repair.write_once(author / 'prompt.txt', b'author prompt')
    repair.write_once(author / 'answer.json', answer_raw)
    repair.write_once(author / 'answer.json.receipt.json', receipt)
    repair.write_once(author / 'complete.json', {
        'batch': 100, 'count': 1, 'model': repair.MODEL, 'effort': 'high', 'transport': 'corral',
        'promptHash': receipt['promptHash'], 'answerHash': receipt['responseHash'],
    })
    quality = source / 'outcomes/quality' / case['id']
    response = json.dumps({'valid': True, 'issues': []}).encode()
    reviewed = {'model': 'deepseek-test', 'effort': 'high', 'transport': 'corral-credential-hive',
                'requestHash': 'review-request', 'responseHash': repair.sha(response),
                'completedAt': '2026-10-31T00:00:00Z', 'finishReason': 'stop'}
    repair.write_once(quality / 'prompt.txt', repair.review_prompt(case).encode())
    repair.write_once(quality / 'answer.json', response)
    repair.write_once(quality / 'answer.json.receipt.json', reviewed)
    repair.write_once(quality / 'answer.json.request.json', reviewed)
    repair.write_once(quality / 'receipt.json', {**reviewed, 'id': case['id'], 'valid': True, 'issues': []})
    return source, path


class QualifiedTrialTests(unittest.TestCase):
    def test_modified_fixture_never_dispatches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = fixture(root)
            entry = json.loads(manifest.read_text())['cases'][0]
            path = root / entry['casePath']; path.write_bytes(path.read_bytes() + b' ')
            calls = []
            result = qualified.run_snapshot(root, manifest, worker=lambda *args: calls.append(args))
            self.assertEqual(result['rejected'], 1)
            self.assertEqual(calls, [])

    def test_manifest_must_require_new_workers_and_reject_prior_regrading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = fixture(root)
            value = json.loads(manifest.read_text()); value['mayRegradePriorWorkerAnswers'] = True
            manifest.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                qualified.run_snapshot(root, manifest, worker=lambda *args: self.fail('dispatch'))

    def test_low_reviewer_and_tampered_mechanical_receipt_are_rejected(self):
        for name in ['reviewer/answer.json.receipt.json', 'mechanical.json']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); manifest = fixture(root)
                entry = json.loads(manifest.read_text())['cases'][0]
                path = (root / entry['casePath']).parent / name
                data = json.loads(path.read_text()); data['effort'] = 'low'; path.write_text(json.dumps(data))
                result = qualified.run_snapshot(root, manifest, worker=lambda *args: self.fail('dispatch'))
                self.assertEqual(result['rejected'], 1)

    def test_old_output_root_is_forbidden(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = fixture(root)
            entry = json.loads(manifest.read_text())['cases'][0]
            admission = qualified.admit(root, entry)
            with self.assertRaises(ValueError):
                qualified.claim(root, admission, manifest, output_root=root)

    def test_valid_hashes_do_not_make_a_low_effort_review_eligible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = fixture(root, reviewer_effort='low')
            result = qualified.run_snapshot(root, manifest, worker=lambda *args: self.fail('dispatch'))
            self.assertEqual(result['rejected'], 1)
            self.assertEqual(result['scheduled'], 0)

    def test_duplicate_snapshot_does_not_redispatch_and_reports_no_scores(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = fixture(root); calls = []
            def worker(args, case, effort, repeat):
                calls.append((args.root, case['id'], effort, repeat))
                self.assertTrue(Path(args.root).is_relative_to(root / 'qualified-trials'))
                self.assertNotIn('expectedDifficulty', case)
                return {'state': 'complete', 'passed': False, 'usage': {'totalTokens': 999}}
            first = qualified.run_snapshot(root, manifest, worker=worker)
            second = qualified.run_snapshot(root, Path(repair.write_manifest(root)), worker=worker)
            self.assertEqual(len(calls), 8)
            self.assertEqual(first['completed'], 8)
            self.assertEqual(second['completed'], 8)
            self.assertNotIn('passed', json.dumps(first))
            self.assertNotIn('usage', json.dumps(first))
            self.assertEqual({(effort, repeat) for _, _, effort, repeat in calls},
                             {(effort, repeat) for effort in trials.LEVELS for repeat in [0, 1]})

    def test_incomplete_request_is_delegated_without_another_provider_call(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = fixture(root)
            def worker(args, case, effort, repeat):
                path = Path(args.root) / 'outcomes/trials-corral' / case['id'] / effort / str(repeat)
                repair.write_once(path / 'started.json', {'unknown': True})
                return trials.trial(args, case, effort, repeat)
            with patch.object(trials.subprocess, 'Popen', side_effect=AssertionError('must not redispatch')):
                first = qualified.run_snapshot(root, manifest, worker=worker)
                second = qualified.run_snapshot(root, manifest, worker=worker)
            self.assertEqual(first['incomplete'], 8)
            self.assertEqual(second['incomplete'], 8)
            self.assertEqual(second['completed'], 0)

    def test_duplicate_entry_is_one_family_and_eight_scheduled_trials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = fixture(root)
            data = json.loads(manifest.read_text()); data['cases'] *= 2
            manifest.write_text(json.dumps(data))
            result = qualified.run_snapshot(root, manifest, worker=lambda *args: {'state': 'complete'})
            self.assertEqual(result['groups'], 1)
            self.assertEqual(result['scheduled'], 8)


class SupplementalOriginalTests(unittest.TestCase):
    def test_unreviewed_and_rejected_originals_cannot_be_admitted(self):
        for missing in (True, False):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); source, path = original_fixture(root)
                review = source / 'outcomes/quality/outcome-0100-00/receipt.json'
                if missing:
                    review.unlink()
                else:
                    data = json.loads(review.read_text()); data['valid'] = False
                    review.write_text(json.dumps(data))
                with self.assertRaises((ValueError, OSError)):
                    qualified.admit_original(root, source, path)

    def test_changed_fixture_after_review_and_after_pin_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source, path = original_fixture(root)
            raw = path.read_bytes()
            path.write_bytes(raw.replace(b'Fix the result.', b'Fix something else.'))
            with self.assertRaises(ValueError):
                qualified.admit_original(root, source, path)
            path.write_bytes(raw)
            qualified.original_snapshot(root, source)
            path.write_bytes(raw + b' ')
            with self.assertRaises(ValueError):
                qualified.admit_original(root, source, path)

    def test_supplemental_source_is_explicitly_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source, path = original_fixture(root)
            with self.assertRaises(ValueError):
                qualified.admit_original(root, root, path)
            with self.assertRaises(ValueError):
                qualified.admit_original(root, source, root / 'outcomes/validated/outcome-0100-00/case.json')

    def test_original_v0_uses_fresh_root_and_no_repair_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source, path = original_fixture(root)
            manifest = qualified.original_snapshot(root, source)
            calls = []
            def worker(args, case, effort, repeat):
                calls.append((args.root, effort, repeat))
                self.assertIn('-v0-', args.root)
                return {'state': 'complete', 'passed': True, 'usage': {'totalTokens': 20}}
            first = qualified.run_snapshot(root, manifest, worker=worker, supplemental_root=source)
            second = qualified.run_snapshot(root, manifest, worker=worker, supplemental_root=source)
            self.assertEqual(len(calls), 8)
            self.assertEqual(first['completed'], 8)
            self.assertEqual(second['completed'], 8)
            with self.assertRaises(ValueError):
                qualified.run_snapshot(root, manifest, worker=worker)
            cohort = json.loads((Path(calls[0][0]) / 'cohort.json').read_text())
            self.assertEqual(cohort['identity']['kind'], 'original-approved')
            self.assertNotIn('amendmentHash', cohort['identity'])
            self.assertNotIn('revisedCaseHash', cohort['identity'])

    def test_original_and_repaired_watchers_share_family_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); repaired_manifest = fixture(root)
            repaired = qualified.run_snapshot(root, repaired_manifest, worker=lambda *args: {'state': 'complete'})
            source, _ = original_fixture(root)
            original_manifest = qualified.original_snapshot(root, source)
            fresh = qualified.run_snapshot(root, original_manifest, supplemental_root=source,
                                           worker=lambda *args: self.fail('duplicate family dispatched'))
            self.assertEqual(repaired['scheduled'], 8)
            self.assertEqual(fresh['scheduled'], 0)
            self.assertEqual(fresh['duplicateGroups'], 1)

    def test_pin_path_cannot_redirect_admission_into_old_trial_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source, _ = original_fixture(root)
            manifest = qualified.original_snapshot(root, source)
            data = json.loads(manifest.read_text())
            forbidden = root / 'outcomes/trials-corral/forbidden.json'
            data['cases'][0]['pinPath'] = str(forbidden.relative_to(root))
            manifest.write_text(json.dumps(data))
            original_read = Path.read_bytes
            def guarded(path):
                self.assertNotEqual(path, forbidden, 'old trial artifact was read')
                return original_read(path)
            with patch.object(Path, 'read_bytes', guarded):
                result = qualified.run_snapshot(root, manifest, supplemental_root=source,
                                                worker=lambda *args: self.fail('dispatch'))
            self.assertEqual(result['rejected'], 1)


if __name__ == '__main__':
    unittest.main()
