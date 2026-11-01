import hashlib
import unittest
from split_eval import fit_dev_rows, fit_dev_groups, validate_fit_rows


class FitDevBoundaryTests(unittest.TestCase):
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
