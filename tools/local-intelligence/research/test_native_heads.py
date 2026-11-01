import importlib.util
from pathlib import Path
import unittest

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

spec = importlib.util.spec_from_file_location('native_heads', Path(__file__).with_name('native-heads.py'))
heads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(heads)


def row(group, split='fit'):
    return {'id': group, 'group': group, 'split': split, 'task': 'effort',
            'inputVersion': 'judge-structured-v2', 'text': 'structured input',
            'target': {'level': 'low', 'acceptableLevels': ['low']}}


class NativeHeadTests(unittest.TestCase):
    def test_only_f_is_accepted_even_when_other_task_is_filtered(self):
        for split in ['calibration', 'policy', 'final']:
            with self.assertRaises(ValueError):
                heads.fit_rows([row('a'), row('b', split)])
            with self.assertRaises(ValueError):
                heads.fit_rows([row('a'), {**row('b', split), 'task': 'meeting'}])

    def test_scaler_never_fits_outer_dev_groups(self):
        development = next(f'g{i}' for i in range(100) if heads.group_fold(f'g{i}') == 0)
        training = [f't{i}' for i in range(100) if heads.group_fold(f't{i}') != 0][:2]
        rows = [row(training[0]), row(training[1]), row(development)]
        scaler, train, dev = heads.fold_scaler(rows, np.array([[0.], [2.], [1000.]]), 0)
        self.assertEqual(scaler.mean_.tolist(), [1.])
        self.assertEqual(train.tolist(), [True, True, False])
        self.assertEqual(dev.tolist(), [False, False, True])

    def test_original_js_relu_and_linear_math_match_folded_scaler(self):
        rng = np.random.default_rng(41)
        x = rng.normal(size=(12, 5)).astype(np.float32).astype(float)
        scaler = StandardScaler().fit(x[:8])
        info = {'dims': 5, 'baseModelSha256': 'a' * 64,
                'preprocessVersion': 'judge-structured-v2:native-litert:1024'}
        linear = LogisticRegression()
        linear.coef_ = rng.normal(size=(4, 5)); linear.intercept_ = rng.normal(size=4)
        linear.classes_ = np.arange(4)
        relu = MLPClassifier(hidden_layer_sizes=(64,), activation='relu')
        relu.coefs_ = [rng.normal(size=(5, 64)), rng.normal(size=(64, 4))]
        relu.intercepts_ = [rng.normal(size=64), rng.normal(size=4)]
        relu.classes_ = np.arange(4)
        for model in (linear, relu):
            weights = heads.export_head(model, scaler, info, 'test-only')
            expected = (scaler.transform(x) @ model.coef_.T + model.intercept_
                        if isinstance(model, LogisticRegression) else
                        np.maximum(0, scaler.transform(x) @ model.coefs_[0] + model.intercepts_[0])
                        @ model.coefs_[1] + model.intercepts_[1])
            np.testing.assert_allclose(heads.logits(weights, x), expected, atol=1e-12)
            self.assertLess(heads.js_parity(weights, x)['maxProbabilityError'], 1e-9)


if __name__ == '__main__':
    unittest.main()
