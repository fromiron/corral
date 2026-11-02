import hashlib
import copy
import unittest
from split_eval import fit_dev_rows, fit_dev_groups, validate_fit_rows


class FitDevBoundaryTests(unittest.TestCase):
    def explicit_fixture(self):
        rows = [{'group': str(i), 'split': 'fit'} for i in range(12)]
        manifest = {'version': 'fit-holdout-v1', 'fitSha256': 'a' * 64,
                    'folds': [{'devGroups': [str(i) for i in range(j, 12, 3)]} for j in range(3)]}
        return rows, manifest

    def test_explicit_folds_use_frozen_groups_and_exact_source_hash(self):
        rows, manifest = self.explicit_fixture()
        actual = fit_dev_groups(rows, 0, holdout_manifest=manifest, fit_sha256='a' * 64)
        self.assertEqual(actual, {'0', '3', '6', '9'})
        self.assertNotEqual(actual, fit_dev_groups(rows, 0))
        with self.assertRaises(ValueError):
            fit_dev_groups(rows, 0, holdout_manifest=manifest, fit_sha256='b' * 64)

    def test_explicit_manifest_rejects_group_leakage_and_incomplete_partition(self):
        rows, original = self.explicit_fixture()
        for change in ('duplicate', 'unknown', 'missing', 'empty'):
            manifest = copy.deepcopy(original)
            if change == 'duplicate': manifest['folds'][1]['devGroups'].append('0')
            if change == 'unknown': manifest['folds'][1]['devGroups'].append('not-in-F')
            if change == 'missing': manifest['folds'][0]['devGroups'].pop()
            if change == 'empty': manifest['folds'][0]['devGroups'] = []
            with self.subTest(change=change), self.assertRaises(ValueError):
                fit_dev_groups(rows, 0, holdout_manifest=manifest, fit_sha256='a' * 64)
        with self.assertRaises(ValueError):
            fit_dev_groups(rows + [{'group': 'sealed', 'split': 'final'}], 0,
                           holdout_manifest=original, fit_sha256='a' * 64)

    def test_explicit_replay_uses_recorded_holdout_and_rejects_changed_input(self):
        rows, manifest = self.explicit_fixture()
        groups = manifest['folds'][0]['devGroups']
        metadata = {'args': {'dev_fold': 0, 'holdout_manifest': 'frozen.json'},
                    'fitSourceSha256': 'a' * 64, 'devGroups': groups,
                    'trainGroups': [r['group'] for r in rows if r['group'] not in groups]}
        self.assertEqual(fit_dev_rows(rows, metadata, source_sha256='a' * 64),
                         [r for r in rows if r['group'] in groups])
        with self.assertRaises(ValueError):
            fit_dev_rows(rows, metadata, source_sha256='b' * 64)
        metadata['trainGroups'].append(groups[0])
        with self.assertRaises(ValueError):
            fit_dev_rows(rows, metadata, source_sha256='a' * 64)

    def test_training_partition_rejects_non_fit_rows_and_uses_requested_fold(self):
        rows = [{'group': str(i), 'split': 'fit'} for i in range(30)]
        expected = {r['group'] for r in rows if int(hashlib.sha256(r['group'].encode()).hexdigest()[:8], 16) % 5 == 2}
        self.assertEqual(fit_dev_groups(rows, 2), expected)
        with self.assertRaises(ValueError):
            validate_fit_rows(rows + [{'group': 'sealed', 'split': 'final'}])
        with self.assertRaises(ValueError):
            fit_dev_groups(rows, 8)

    def test_actual_training_fold_and_group_membership_are_enforced(self):
        rows = [{'group': str(i), 'split': 'fit'} for i in range(30)]
        held = [r for r in rows if int(hashlib.sha256(r['group'].encode()).hexdigest()[:8], 16) % 5 == 1]
        metadata = {'args': {'dev_fold': 1}, 'trainGroups': [r['group'] for r in rows if r not in held]}
        self.assertEqual(fit_dev_rows(rows, metadata), held)
        metadata['trainGroups'].append(held[0]['group'])
        with self.assertRaises(ValueError):
            fit_dev_rows(rows, metadata)

    def test_full_refit_cannot_be_reported_as_fit_dev(self):
        with self.assertRaises(ValueError):
            fit_dev_rows([{'group': 'g', 'split': 'fit'}], {'args': {'fit_all': True}, 'trainGroups': ['g']})


if __name__ == '__main__':
    unittest.main()
