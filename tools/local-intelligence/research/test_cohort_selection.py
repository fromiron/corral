"""Outcome-blind, deterministic family selection and missingness accounting."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cohort_selection as cohort


def candidate(case_id, family, version=0, origin='original'):
    return {'id': case_id, 'family': family, 'phase': 'final', 'version': version,
            'origin': origin, 'casePath': f'cases/{case_id}/v{version}.json'}


class CohortTests(unittest.TestCase):
    def test_selection_never_prefers_complete_or_successful_alternative(self):
        rows = [candidate('outcome-0020-00', 'same'), candidate('outcome-0021-00', 'same')]
        rows[0].update({'complete': False, 'passed': False, 'usage': 100000})
        rows[1].update({'complete': True, 'passed': True, 'usage': 1})
        first = cohort.select_candidates(rows, target=1)
        rows[0].update({'complete': True, 'passed': True, 'usage': 1})
        rows[1].update({'complete': False, 'passed': False, 'usage': 100000})
        second = cohort.select_candidates(list(reversed(rows)), target=1)
        self.assertEqual([row['id'] for row in first['selected']], ['outcome-0020-00'])
        self.assertEqual([row['id'] for row in first['selected']], [row['id'] for row in second['selected']])

    def test_one_version_one_case_per_family_and_stable_ranking(self):
        rows = [candidate('outcome-0020-00', 'a', 2, 'repaired'),
                candidate('outcome-0020-00', 'a', 1, 'repaired'),
                candidate('outcome-0021-00', 'a'), candidate('outcome-0022-00', 'b')]
        selection = cohort.select_candidates(rows, target=200)
        self.assertEqual(len(selection['families']), 2)
        picked = {row['family']: (row['id'], row['version']) for row in selection['selected']}
        self.assertEqual(picked['a'], ('outcome-0020-00', 1))
        self.assertEqual(selection['selected'], cohort.select_candidates(list(reversed(rows)), target=200)['selected'])

    def test_development_family_is_never_promoted_to_final(self):
        rows = [candidate('outcome-0020-00', 'shared'), candidate('outcome-0021-00', 'fresh')]
        development = candidate('outcome-0000-00', 'shared'); development['phase'] = 'development'
        selected = cohort.select_candidates([*rows, development], target=200)
        self.assertEqual([row['family'] for row in selected['selected']], ['fresh'])
        self.assertEqual(selected['crossPhaseExcluded'], ['shared'])

    def test_metadata_projection_never_decodes_sealed_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'metadata.json'
            path.write_text('{"id":"x","state":"complete","grade":"SEALED_GRADE","usage":{"x":"SEALED_USAGE"},"input":{"text":"SEALED_INPUT"}}')
            decode = json.loads
            def guarded(value, *args, **kwargs):
                self.assertNotIn('SEALED_', value)
                return decode(value, *args, **kwargs)
            with patch.object(cohort.json, 'loads', side_effect=guarded):
                self.assertEqual(cohort.metadata(path, ('id', 'state')), {'id': 'x', 'state': 'complete'})

    def test_missing_receipts_remain_missing_without_opening_any_worker_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); worker = root / 'worker'
            trial = worker / 'outcomes/trials-corral/outcome-0020-00'
            for level in cohort.LEVELS:
                for repeat in (0, 1):
                    folder = trial / level / str(repeat); folder.mkdir(parents=True)
                    (folder / 'started.json').write_text('SEALED_STARTED')
                    if (level, repeat) != ('high', 1):
                        (folder / 'receipt.json').write_text('SEALED_RECEIPT')
            row = candidate('outcome-0020-00', 'a'); row['workerRoot'] = 'worker'
            original = Path.read_bytes
            def guarded(path):
                self.assertFalse(path.is_relative_to(trial), 'worker artifact opened')
                return original(path)
            with patch.object(Path, 'read_bytes', guarded):
                result = cohort.availability(root, row, active_outputs=set())
            self.assertFalse(result['complete'])
            self.assertEqual(result['receiptCount'], 7)
            self.assertEqual(result['missing'], [{'effort': 'high', 'repeat': 1, 'state': 'started-unsettled'}])

    def test_pending_and_inflight_are_separate_from_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = candidate('outcome-0020-00', 'a'); row['workerRoot'] = 'worker'
            folder = root / 'worker/outcomes/trials-corral/outcome-0020-00/low/0'
            folder.mkdir(parents=True); (folder / 'started.json').write_text('SEALED')
            result = cohort.availability(root, row, active_outputs={str(folder.resolve())})
            self.assertEqual(result['missing'][0]['state'], 'inflight')
            self.assertEqual(sum(item['state'] == 'pending' for item in result['missing']), 7)

    def test_node_mainthread_process_is_counted_as_inflight(self):
        root = Path('/private/experiment')
        folder = root / 'qualified-trials/case/outcomes/trials-corral/outcome-0020-00/high/0'
        line = f'123 456 7 MainThread /node/bin/node /repo/subscription.ts {folder}/prompt.txt {folder}/schema.json {folder}/answer.json high worker\n'
        with patch.object(cohort.subprocess, 'check_output', return_value=line):
            report, active = cohort.processes(root)
        self.assertEqual(active, {str(folder)})
        self.assertEqual(report['activeCalls'][0]['role'], 'worker')


if __name__ == '__main__':
    unittest.main()
