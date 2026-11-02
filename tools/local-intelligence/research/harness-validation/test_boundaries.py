"""No model calls: verify the sealed-data boundary before any filesystem read."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run


class Boundaries(unittest.TestCase):
    def test_sealed_and_invalid_ids_rejected_before_read(self):
        with patch.object(Path, 'read_text', side_effect=AssertionError('must not read')):
            for case_id in ['outcome-0020-00', 'outcome-0099-02', '../case', 'outcome-0000-00/../../case']:
                with self.subTest(case_id=case_id), self.assertRaises(ValueError):
                    run.load_case(Path('/unused'), case_id)

    def test_development_fixture_identity_is_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'outcomes/validated/outcome-0000-00/case.json'
            run.save(path, {'id': 'outcome-0020-00'})
            with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                run.load_case(root, 'outcome-0000-00')

    def test_started_trial_never_replays(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run.save(root / 'outcomes/harness/trials/outcome-0000-00/medium/started.json', {})
            with patch.object(run.subprocess, 'Popen', side_effect=AssertionError('must not execute')):
                result = run.trial(root, {'id': 'outcome-0000-00'}, 'medium', {})
            self.assertEqual(result['state'], 'unsettled')
            self.assertFalse(result['passed'])


if __name__ == '__main__':
    unittest.main()
