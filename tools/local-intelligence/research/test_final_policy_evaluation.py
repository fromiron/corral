import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('final_policy_evaluation', Path(__file__).with_name('final-policy-evaluation.py'))
final = importlib.util.module_from_spec(spec)
spec.loader.exec_module(final)


def cohort(root):
    rows = []
    for index in range(200):
        case_id = f'outcome-{index + 20:04d}-00'
        rows.append({'id': case_id, 'group': f'family-{index}', 'sourceGroup': f'source-{index}',
                     'origin': 'original', 'fixtureVersion': 0, 'measurementVersion': None, 'workerRoot': '.',
                     'visibleFixturePath': str(root / 'outcomes/validated' / case_id / 'case.json'),
                     'receipts': [{'effort': level, 'repeat': repeat,
                                   'path': str(root / 'outcomes/trials-corral' / case_id / level / str(repeat) / 'receipt.json')}
                                  for level in final.LEVELS for repeat in range(2)]})
    manifest = {'frozen': True, 'targetFamilies': 200,
                'final': [{**row, 'family': row['group'], 'phase': 'final'} for row in rows]}
    mapping = {'phase': 'final', 'frozen': True, 'manifestHash': 'manifest-hash', 'rows': rows}
    return manifest, mapping


class FinalPolicyTests(unittest.TestCase):
    def test_final_requires_explicit_unseal(self):
        with self.assertRaises(ValueError):
            final.require_unseal(False)

    def test_exact_200_manifest_receipts_no_reserve_substitution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest, mapping = cohort(root)
            final.validate_cohort(root, manifest, mapping, 'manifest-hash')
            mapping['rows'][0]['receipts'][0]['path'] = str(root / 'outcomes/trials-corral/outcome-0999-00/low/0/receipt.json')
            with self.assertRaises(ValueError):
                final.validate_cohort(root, manifest, mapping, 'manifest-hash')

    def test_missing_or_duplicate_family_is_an_error_not_an_exclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest, mapping = cohort(root)
            mapping['rows'].pop()
            with self.assertRaises(ValueError):
                final.validate_cohort(root, manifest, mapping, 'manifest-hash')
            manifest, mapping = cohort(root)
            mapping['rows'][-1] = mapping['rows'][0]
            with self.assertRaises(ValueError):
                final.validate_cohort(root, manifest, mapping, 'manifest-hash')

    def test_full_block_recollection_cannot_mix_old_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest, mapping = cohort(root)
            item = mapping['rows'][0]
            item['measurementVersion'] = 'm1'
            item['workerRoot'] = f"recollection-trials/m1/{item['id']}"
            manifest['final'][0].update(item)
            # Old paths were deliberately retained: validate before reading them.
            with self.assertRaises(ValueError):
                final.validate_cohort(root, manifest, mapping, 'manifest-hash')

    def test_incomplete_usage_is_never_imputed_and_worker_failure_stays(self):
        mapping = {'id': 'outcome-0020-00', 'sourceGroup': 'source'}
        slot = {'effort': 'low', 'repeat': 0}
        receipt = {'id': mapping['id'], 'group': 'source', 'model': 'gpt-6.1-sol', 'role': 'evaluated-worker',
                   'transport': 'corral', 'effort': 'low', 'repeat': 0, 'wire': {'kind': 'effort', 'value': 'low'},
                   'fixtureHash': 'fixture', 'promptHash': 'prompt', 'grade': {'passed': False},
                   'usage': {'totalTokens': 123}, 'responseSeconds': 2.}
        self.assertFalse(final.validate_receipt(receipt, mapping, slot, 'fixture', 'prompt')['passed'])
        for usage in [{}, {'totalTokens': 0}, {'totalTokens': None}]:
            with self.assertRaises(ValueError):
                final.validate_receipt({**receipt, 'usage': usage}, mapping, slot, 'fixture', 'prompt')


if __name__ == '__main__':
    unittest.main()
