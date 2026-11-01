import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('candidate_heads', Path(__file__).with_name('candidate-heads.py'))
heads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(heads)


def rows():
    return [{'id': f'r{i}', 'group': f'g{i}', 'domain': 'natural', 'split': 'fit',
             'target': {'mode': 'one', 'eligibleIds': ['b'], 'excludedIds': []},
             'candidates': [{'id': 'a', 'values': [float(i), 0.]}, {'id': 'b', 'values': [float(i), 1.]}],
             'references': {'last': ['a']}} for i in range(6)]


class CandidateHeadTests(unittest.TestCase):
    def test_final_and_non_one_or_exclusion_training_rejected(self):
        for change in [{'split': 'final'}, {'target': {'mode': 'all', 'eligibleIds': ['a', 'b'], 'excludedIds': []}},
                       {'target': {'mode': 'one', 'eligibleIds': ['b'], 'excludedIds': ['a']}}]:
            with self.assertRaises(ValueError): heads.validate_fit([{**rows()[0], **change}])

    def test_group_disjoint_folds_keep_every_variant_together(self):
        original = rows(); original.append({**original[0], 'id': 'variant'})
        folds = heads.grouped_folds(original)
        for fold in range(3):
            train = {r['group'] for r, f in zip(original, folds) if f != fold}
            dev = {r['group'] for r, f in zip(original, folds) if f == fold}
            self.assertTrue(train and dev); self.assertFalse(train & dev)
        self.assertEqual(folds[0], folds[-1])

    def test_scaler_never_fits_development_candidates(self):
        train = rows()[:4]; dev = rows()[4:]
        scaler = heads.fit_scaler(train)
        self.assertTrue(np.allclose(scaler['mean'], [1.5, .5]))
        for row in dev:
            for candidate in row['candidates']: candidate['values'][0] = 1e9
        self.assertTrue(np.allclose(heads.fit_scaler(train)['mean'], scaler['mean']))

    def test_shared_scorer_is_id_and_roster_permutation_equivariant(self):
        data = rows(); model, receipt = heads.fit_head(data, 'linear', 41)
        scores = heads.score(model, data[0]['candidates'])
        self.assertGreater(scores[1], scores[0])
        altered = [{**c, 'id': f'new{i}'} for i, c in enumerate(reversed(data[0]['candidates']))]
        self.assertTrue(np.allclose(heads.score(model, altered), scores[::-1]))
        self.assertNotIn('participantIds', model)

    def test_eligible_alternatives_use_marginal_likelihood_and_gradient(self):
        data = rows(); data[0]['target']['eligibleIds'] = ['a', 'b']
        scaler = heads.fit_scaler(data); x, eligible, weights = heads.training_arrays(data, scaler)
        for kind in ('linear', 'relu16'):
            parameters = heads.initial_parameters(x.shape[-1], kind, 41)
            loss, gradient = heads.objective(parameters, x, eligible, weights, kind)
            self.assertTrue(np.isfinite(loss)); self.assertEqual(gradient.shape, parameters.shape)
            for index in [0, len(parameters) // 2, len(parameters) - 1]:
                plus = parameters.copy(); minus = parameters.copy(); plus[index] += 1e-5; minus[index] -= 1e-5
                finite = (heads.objective(plus, x, eligible, weights, kind)[0] - heads.objective(minus, x, eligible, weights, kind)[0]) / 2e-5
                self.assertAlmostEqual(finite, gradient[index], places=5)


if __name__ == '__main__': unittest.main()
