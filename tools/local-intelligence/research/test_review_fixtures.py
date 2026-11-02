"""Known terminal review truncation may escalate once; unknown calls never retry."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import review_fixtures as review
from test_repair_fixtures import original


def fixture(root, *, incomplete=True, budget=32768):
    path = root / 'outcomes/validated/outcome-0000-02/case.json'
    path.parent.mkdir(parents=True); path.write_bytes(original())
    directory = root / 'outcomes/quality/outcome-0000-02'; directory.mkdir(parents=True)
    request = {'model': 'deepseek-v4-pro', 'effort': 'high', 'transport': 'corral-credential-hive', 'requestHash': 'bound-request'}
    (directory / 'answer.json.request.json').write_text(json.dumps(request))
    if incomplete:
        (directory / 'answer.json.incomplete.json').write_text(json.dumps({
            **request, 'finishReason': 'stop', 'maxCompletionTokens': budget,
            'usage': {'completion_tokens': budget}, 'hasContent': False,
        }))
    return path, directory


def args(root, budget=65536):
    return SimpleNamespace(root=str(root), config='unused', retry_attempt='high-budget-65536-v1',
                           max_output_tokens=budget, timeout_seconds=600, process_timeout=720,
                           publish_rejected=False)


class ReviewEscalationTests(unittest.TestCase):
    def test_unknown_transport_without_terminal_evidence_is_never_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path, _ = fixture(root, incomplete=False)
            with patch.object(review.subprocess, 'run', side_effect=AssertionError('no dispatch')):
                result = review.review(args(root), path)
            self.assertEqual(result['state'], 'unsettled')

    def test_unchanged_truncated_budget_is_never_repeated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path, _ = fixture(root)
            with patch.object(review.subprocess, 'run', side_effect=AssertionError('no dispatch')):
                result = review.review(args(root, budget=32768), path)
            self.assertEqual(result['state'], 'budget-not-increased')

    def test_new_attempt_unknown_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path, output = fixture(root)
            attempt = output / 'high-budget-65536-v1'; attempt.mkdir()
            (attempt / 'answer.json.request.json').write_text('{}')
            with patch.object(review.subprocess, 'run', side_effect=AssertionError('no dispatch')):
                result = review.review(args(root), path)
            self.assertEqual(result['state'], 'unsettled')

    def test_known_terminal_escalation_uses_new_limits_and_preserves_old_evidence(self):
        for valid in (True, False):
            with self.subTest(valid=valid), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); path, output = fixture(root)
                old = (output / 'answer.json.incomplete.json').read_bytes()
                def provider(command, **options):
                    self.assertEqual(command[-2:], ['65536', '600'])
                    self.assertEqual(options['timeout'], 720)
                    answer_path = Path(command[-3])
                    self.assertEqual(answer_path.parent, output / 'high-budget-65536-v1')
                    answer_path.write_text(json.dumps({'valid': valid, 'issues': [] if valid else [{'kind': 'weak-tests', 'evidence': 'Missing case.'}]}))
                    Path(str(answer_path) + '.receipt.json').write_text(json.dumps({'effort': 'high', 'transport': 'corral-credential-hive'}))
                    return SimpleNamespace(returncode=0)
                with patch.object(review.subprocess, 'run', side_effect=provider):
                    result = review.review(args(root), path)
                self.assertEqual(result['valid'], valid)
                self.assertEqual((output / 'answer.json.incomplete.json').read_bytes(), old)
                self.assertEqual((output / 'receipt.json').exists(), valid)
                self.assertTrue((output / 'high-budget-65536-v1/qualification.json').exists())


if __name__ == '__main__':
    unittest.main()
