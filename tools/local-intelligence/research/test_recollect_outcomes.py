"""Declared full-block recollection, never completion-driven case substitution."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import recollect_outcomes as recollect
from test_repair_fixtures import original


def sources(root):
    for case_id, missing in recollect.TARGETS.items():
        raw = original().replace(b'outcome-0000-02', case_id.encode()).replace(b'group-a', case_id.encode())
        case = root / 'outcomes/validated' / case_id / 'case.json'; case.parent.mkdir(parents=True); case.write_bytes(raw)
        quality = root / 'outcomes/quality' / case_id / 'receipt.json'; quality.parent.mkdir(parents=True)
        quality.write_text(json.dumps({'id': case_id, 'valid': True, 'issues': [], 'effort': 'high',
                                      'model': 'deepseek-v4-pro', 'transport': 'corral-credential-hive'}))
        for level, repeat in recollect.BLOCK:
            directory = root / 'outcomes/trials-corral' / case_id / level / str(repeat)
            directory.mkdir(parents=True); (directory / 'started.json').write_text('SEALED_STARTED')
            if (level, repeat) != missing:
                (directory / 'receipt.json').write_text('SEALED_RECEIPT')


class RecollectionTests(unittest.TestCase):
    def test_freeze_never_reads_old_worker_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); sources(root)
            old = root / 'outcomes/trials-corral'; reader = Path.read_bytes
            def guarded(path):
                self.assertFalse(path.is_relative_to(old), 'old worker output opened')
                return reader(path)
            with patch.object(Path, 'read_bytes', guarded):
                document = recollect.prepare(root, root / 'outcomes/measurement-recollections/m1/amendment.json')
            self.assertEqual(document['maxExecutions'], 16)
            self.assertEqual(len(document['cases']), 2)
            self.assertTrue(all(len(row['newBlock']) == 8 for row in document['cases']))
            self.assertTrue(document['oldCohortsExcludedFromPrimary'])

    def test_partial_block_extra_case_and_changed_hash_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); sources(root)
            document = recollect.prepare(root, root / 'outcomes/measurement-recollections/m1/amendment.json')
            versions = []
            partial = copy.deepcopy(document); partial['cases'][0]['newBlock'].pop(); versions.append(partial)
            extra = copy.deepcopy(document); extra['cases'].append(copy.deepcopy(extra['cases'][0])); versions.append(extra)
            hash_change = copy.deepcopy(document); hash_change['cases'][0]['testHash'] = 'different'; versions.append(hash_change)
            bound = copy.deepcopy(document); bound['maxExecutions'] = 17; versions.append(bound)
            old_root = copy.deepcopy(document); old_root['cases'][0]['workerRoot'] = '.'; versions.append(old_root)
            for value in versions:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    recollect.validate(root, value)

    def test_selector_replaces_entire_blocks_even_while_new_measurements_are_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); sources(root)
            path = root / 'outcomes/measurement-recollections/m1/amendment.json'
            document = recollect.prepare(root, path)
            candidates = [{'id': row['id'], 'family': row['family'], 'origin': 'original', 'version': 0,
                           'casePath': row['casePath'], 'workerRoot': '.',
                           'independentReviewHash': row['independentReviewHash']} for row in document['cases']]
            updated = recollect.apply_manifest(root, candidates, path)
            self.assertEqual({row['id'] for row in updated}, set(recollect.TARGETS))
            self.assertTrue(all(row['workerRoot'] != '.' and row['priorWorkerRoot'] == '.' for row in updated))
            self.assertEqual([row['workerRoot'] for row in updated], [row['workerRoot'] for row in document['cases']])

    def test_identity_drift_and_existing_unknown_new_attempt_are_not_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); sources(root)
            path = root / 'outcomes/measurement-recollections/m1/amendment.json'
            document = recollect.prepare(root, path)
            row = document['cases'][0]
            target = root / row['workerRoot'] / 'job-status/low-0.started.json'
            target.parent.mkdir(parents=True); target.write_text('{}')
            with patch.object(recollect, 'trial', side_effect=AssertionError('no dispatch')):
                self.assertEqual(recollect.run_job(root, document, row, 'low', 0)['state'], 'unsettled')
            source = root / row['casePath']; source.write_bytes(source.read_bytes() + b' ')
            with self.assertRaises(ValueError):
                recollect.validate(root, document)


if __name__ == '__main__':
    unittest.main()
