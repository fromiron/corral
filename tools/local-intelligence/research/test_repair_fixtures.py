"""Focused blind-repair data and eligibility boundaries; no live model calls."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import repair_fixtures as repair


def original():
    # Keep irregular formatting and opaque author metadata to detect rewrites.
    return b'''{ "id" : "outcome-0000-02", "group":"group-a", "language":"python",
  "request" : "Fix the result.\\nPreserve behavior.", "context":"context", "files":[{"path":"src/a.py","content":"VALUE = 0\\n"}],
  "referenceFiles":[{"path":"src/a.py","content":"VALUE = 1\\n"}],
  "tests":[{"path":"tests/test_a.py","content":"old tests"}],
  "expectedDifficulty": "DO_NOT_DECODE_DIFFICULTY", "rationale":{"text":"DO_NOT_READ_RATIONALE","nested":[{"brace":"}"}]}}
'''


def answer():
    return {'status': 'repaired', 'referenceFiles': [{'path': 'src/a.py', 'content': 'VALUE = 2\n'}],
            'tests': [{'path': 'tests/test_a.py', 'content': 'new tests'}],
            'changes': [{'kind': 'weak-tests', 'evidence': 'Adds the requested boundary.'}], 'reason': ''}


class RepairBoundaries(unittest.TestCase):
    def test_revision_only_replaces_two_fields_byte_for_byte(self):
        raw = original()
        revised = repair.revise_fixture(raw, answer())
        before = repair.field_spans(raw)
        after = repair.field_spans(revised)
        for key in before:
            if key not in ('referenceFiles', 'tests'):
                self.assertEqual(repair.field_bytes(raw, key), repair.field_bytes(revised, key), key)
        self.assertEqual(repair.input_hash(raw), repair.input_hash(revised))
        self.assertNotEqual(repair.test_hash(raw), repair.test_hash(revised))

    def test_teacher_and_reviewer_never_receive_author_metadata(self):
        decode = json.loads
        def guarded(value, *args, **kwargs):
            self.assertNotIn('DO_NOT_', value)
            return decode(value, *args, **kwargs)
        with patch.object(repair.json, 'loads', side_effect=guarded):
            case = repair.fixture_fields(original())
        teacher = repair.repair_prompt(case, [{'kind': 'weak-tests', 'evidence': 'Check boundary.'}])
        reviewer = repair.review_prompt(case)
        for prompt in (teacher, reviewer):
            self.assertNotIn('DO_NOT_', prompt)
            self.assertNotIn('expectedDifficulty', prompt)
            self.assertNotIn('rationale', prompt)
        self.assertEqual(set(case), set(repair.FIXTURE_FIELDS))

    def test_teacher_cannot_change_visible_contract_or_escape_paths(self):
        attempts = []
        extra = answer(); extra['request'] = 'Different request'; attempts.append(extra)
        source = answer(); source['referenceFiles'][0]['path'] = 'src/../secret'; attempts.append(source)
        checks = answer(); checks['tests'][0]['path'] = '../test.py'; attempts.append(checks)
        missing = answer(); missing['referenceFiles'] = []; attempts.append(missing)
        duplicate = answer(); duplicate['tests'] *= 2; attempts.append(duplicate)
        for value in attempts:
            with self.subTest(value=value), self.assertRaises(ValueError):
                repair.revise_fixture(original(), value)

    def test_ambiguous_request_never_becomes_repaired(self):
        value = answer(); value['status'] = 'ambiguous-request'
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            repair.revise_fixture(original(), value)

    def test_eligibility_needs_both_mechanical_and_independent_pass(self):
        good = {'reference': {'passed': True}, 'buggy': {'passed': False}}
        self.assertTrue(repair.eligible(good, {'valid': True, 'issues': []}))
        self.assertFalse(repair.eligible(good, {'valid': False, 'issues': [{'kind': 'weak-tests', 'evidence': 'Gap.'}]}))
        self.assertFalse(repair.eligible({'reference': {'passed': False}, 'buggy': {'passed': False}}, {'valid': True, 'issues': []}))
        self.assertFalse(repair.eligible({'reference': {'passed': True}, 'buggy': {'passed': True}}, {'valid': True, 'issues': []}))
        self.assertFalse(repair.eligible(good, {'valid': True, 'issues': [{'kind': 'weak-tests', 'evidence': 'Gap.'}]}))

    def test_started_unknown_transport_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repair.write_once(root / 'invocation.json', {'startedAt': 'before'})
            with patch.object(repair.subprocess, 'Popen', side_effect=AssertionError('must not dispatch')):
                result = repair.invoke(root, ['unused'], timeout=1)
            self.assertEqual(result['state'], 'unsettled')

    def test_amendment_requires_fresh_worker_cohort(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = original(); revised = repair.revise_fixture(raw, answer())
            amendment = repair.amendment(raw, revised, 'outcome-0000-02', 1,
                                         {'valid': False}, {'valid': True, 'issues': []},
                                         'review-hash', '2026-11-01T00:00:00Z')
            self.assertTrue(amendment['requiresFreshWorkerCohort'])
            self.assertFalse(amendment['mayRegradePriorWorkerAnswers'])
            self.assertFalse(amendment['originalReviewValid'])
            self.assertEqual(amendment['inputHash'], repair.input_hash(raw))
            repair.write_once(root / 'amendment.json', amendment)
            with self.assertRaises(FileExistsError):
                repair.write_once(root / 'amendment.json', {'changed': True})

    def test_resume_after_manifest_write_does_not_rewrite_or_repeat_models(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(root=str(root), config='unused')
            original_review = {'valid': False, 'effort': 'high', 'issues': [{'kind': 'weak-tests', 'evidence': 'Boundary missing.'}]}
            review_raw = json.dumps(original_review).encode()
            calls = []
            def completed(stage, command, timeout):
                receipt_path = stage / 'answer.json.receipt.json'
                if receipt_path.exists():
                    return {'state': 'complete', 'receipt': json.loads(receipt_path.read_text())}
                calls.append(stage.name)
                value = answer() if stage.name == 'teacher' else {'valid': True, 'issues': []}
                content = json.dumps(value).encode()
                receipt = {'model': repair.MODEL if stage.name == 'teacher' else 'hive-model',
                           'provider': 'openai-codex', 'effort': 'high', 'wire': {'kind': 'effort', 'value': 'high'},
                           'role': 'teacher', 'promptHash': repair.sha((stage / 'prompt.txt').read_bytes()),
                           'responseHash': repair.sha(content), 'requestHash': 'request-hash',
                           'transport': 'corral-pi-subscription' if stage.name == 'teacher' else 'corral-credential-hive'}
                repair.write_once(stage / 'answer.json', content)
                repair.write_once(stage / 'answer.json.request.json', {'effort': 'high'})
                repair.write_once(receipt_path, receipt)
                return {'state': 'complete', 'receipt': receipt}
            with patch.object(repair, 'invoke', side_effect=completed), patch.object(repair, 'grade', side_effect=[{'passed': True}, {'passed': False}]):
                with patch.object(repair, '_finish', side_effect=RuntimeError('interrupted after eligibility')):
                    with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                        repair._revision(args, 'outcome-0000-02', original(), original(), original_review,
                                         review_raw, original_review['issues'], 1)
                amendment_path = root / 'outcomes/quality-revisions/outcome-0000-02/v1/amendment.json'
                saved = amendment_path.read_bytes()
                result = repair._revision(args, 'outcome-0000-02', original(), original(), original_review,
                                          review_raw, original_review['issues'], 1)
            self.assertEqual(result['state'], 'eligible')
            self.assertEqual(amendment_path.read_bytes(), saved)
            self.assertEqual(calls, ['teacher', 'reviewer'])


if __name__ == '__main__':
    unittest.main()
