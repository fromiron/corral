import unittest

import numpy as np

from evaluation import (
    classification_metrics,
    fit_temperature,
    meeting_comparison,
    paired_group_bootstrap,
    paired_outcome_report,
)


def outcome_pairs(n=200):
    return [
        {
            'group': f'g{i}', 'repeat': repeat,
            'candidatePassed': True, 'referencePassed': True,
            'candidateTotalTokens': 80, 'referenceTotalTokens': 100,
        }
        for i in range(n) for repeat in range(2)
    ]


def calibration_data():
    rows = [
        {'id': f'c{i}', 'group': f'g{i}', 'task': 'effort',
         'split': 'calibration', 'target': {'level': 'low' if i < 3 else 'medium'}}
        for i in range(4)
    ]
    predictions = [{'id': r['id'], 'logits': [8, 0, -5, -5]} for r in rows]
    return rows, predictions


class CalibrationTests(unittest.TestCase):
    def test_fitting_rejects_every_non_calibration_split(self):
        for split in ['fit', 'policy', 'final', None]:
            rows, predictions = calibration_data()
            rows[-1]['split'] = split
            with self.subTest(split=split), self.assertRaises(ValueError):
                fit_temperature(rows, predictions)

    def test_fitting_rejects_missing_or_duplicate_predictions(self):
        rows, predictions = calibration_data()
        for invalid in [predictions[:-1], predictions + [predictions[0]]]:
            with self.assertRaises(ValueError):
                fit_temperature(rows, invalid)

    def test_fit_uses_group_weights_and_improves_overconfidence(self):
        rows, predictions = calibration_data()
        original = fit_temperature(rows, predictions)
        rows.append({**rows[0], 'id': 'variant'})
        predictions.append({**predictions[0], 'id': 'variant'})
        repeated = fit_temperature(rows, predictions)
        self.assertGreater(original['temperature'], 1)
        self.assertLess(original['after']['nll'], original['before']['nll'])
        self.assertAlmostEqual(original['temperature'], repeated['temperature'], places=6)
        self.assertEqual(repeated['groups'], 4)

    def test_uniform_four_class_metrics_have_known_values(self):
        report = classification_metrics(np.zeros((4, 4)), [0, 1, 2, 3])
        self.assertAlmostEqual(report['nll'], np.log(4))
        self.assertAlmostEqual(report['brier'], .75)
        self.assertAlmostEqual(report['ece'], 0)
        self.assertEqual(report['accuracy'], .25)

    def test_nonfinite_logits_and_bad_labels_are_rejected(self):
        with self.assertRaises(ValueError):
            classification_metrics([[1, 2, 3, float('nan')]], [0])
        with self.assertRaises(ValueError):
            classification_metrics([[1, 2, 3, 4]], [4])


class BootstrapTests(unittest.TestCase):
    def test_variants_cannot_increase_group_weight_or_independent_n(self):
        original = paired_group_bootstrap(['a', 'b'], [1, 0], [0, 0], resamples=1000)
        variants = paired_group_bootstrap(
            ['a'] * 20 + ['b'], [1] * 20 + [0], [0] * 21, resamples=1000,
        )
        self.assertEqual(variants['groups'], 2)
        self.assertEqual(original['estimate'], .5)
        self.assertEqual(original['estimate'], variants['estimate'])
        self.assertEqual(original['interval'], variants['interval'])

    def test_paired_differences_preserve_candidate_reference_pairing(self):
        report = paired_group_bootstrap(
            ['a', 'b', 'c'], [3, 40, 500], [2, 39, 499], resamples=1000,
        )
        self.assertEqual(report['interval'], [1., 1.])

    def test_token_reduction_is_ratio_of_totals_not_mean_percentages(self):
        report = paired_group_bootstrap(
            ['a', 'b'], [1, 900], [10, 1000], statistic='reduction', resamples=1000,
        )
        self.assertAlmostEqual(report['estimate'], 1 - 901 / 1010)
        self.assertNotAlmostEqual(report['estimate'], .5)
        with self.assertRaises(ValueError):
            paired_group_bootstrap(['a', 'b'], [1, 1], [0, 2], statistic='reduction')

    def test_meeting_alternative_recipient_and_invalid_duplicate_count(self):
        rows = [
            {'id': 'a', 'group': 'a', 'task': 'meeting',
             'input': {'participants': [{'id': 'p1'}, {'id': 'p2'}, {'id': 'p3'}]},
             'target': {'mode': 'one', 'eligibleIds': ['p1', 'p2'], 'excludedIds': ['p3']}},
            {'id': 'b', 'group': 'b', 'task': 'meeting',
             'input': {'participants': [{'id': 'p1'}, {'id': 'p2'}]},
             'target': {'mode': 'none', 'eligibleIds': [], 'excludedIds': ['p1', 'p2']}},
        ]
        result = meeting_comparison(
            rows, {'a': ['p2'], 'b': []}, {'a': ['p1', 'p1'], 'b': ['p1']}, resamples=1000,
        )
        self.assertEqual(result['candidateRate'], 1)
        self.assertEqual(result['referenceRate'], 0)
        self.assertEqual(result['referenceForbidden'], 1)
        with self.assertRaises(ValueError):
            meeting_comparison(rows, {'a': ['p1']}, {'a': ['p1'], 'b': []})


class OutcomeTests(unittest.TestCase):
    def test_no_discordance_retains_uncertainty_and_can_meet_200_family_gate(self):
        report = paired_outcome_report(
            outcome_pairs(), expected_groups=[f'g{i}' for i in range(200)], resamples=1000,
        )
        self.assertEqual(report['families'], 200)
        self.assertEqual(report['pairedTrials'], 400)
        self.assertLess(report['successLower'], 0)
        self.assertGreaterEqual(report['successLower'], -.02)
        self.assertTrue(report['passesStatisticalGate'])

    def test_199_families_never_qualify_despite_398_repeats(self):
        report = paired_outcome_report(
            outcome_pairs(199), expected_groups=[f'g{i}' for i in range(199)], resamples=1000,
        )
        self.assertFalse(report['passesStatisticalGate'])
        self.assertFalse(report['enoughFamilies'])

    def test_lower_confidence_cannot_weaken_the_release_gate(self):
        report = paired_outcome_report(
            outcome_pairs(), expected_groups=[f'g{i}' for i in range(200)],
            confidence=.90, resamples=1000,
        )
        self.assertFalse(report['passesStatisticalGate'])

    def test_missing_duplicate_and_missing_whole_family_fail(self):
        pairs = outcome_pairs()
        expected = [f'g{i}' for i in range(200)]
        for invalid in [pairs[:-1], pairs[:-2], pairs + [pairs[0]]]:
            with self.assertRaises(ValueError):
                paired_outcome_report(invalid, expected_groups=expected, resamples=1000)

    def test_usage_missing_or_zero_never_becomes_a_free_trial(self):
        for value in [None, 0, -1, float('nan'), True]:
            pairs = outcome_pairs()
            pairs[0]['candidateTotalTokens'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                paired_outcome_report(
                    pairs, expected_groups=[f'g{i}' for i in range(200)], resamples=1000,
                )

    def test_many_candidate_only_failures_do_not_pass(self):
        pairs = outcome_pairs()
        for pair in pairs[:40]:
            pair['candidatePassed'] = False
        report = paired_outcome_report(
            pairs, expected_groups=[f'g{i}' for i in range(200)], resamples=1000,
        )
        self.assertAlmostEqual(report['successDelta'], -.1)
        self.assertLess(report['successLower'], -.1)
        self.assertFalse(report['passesStatisticalGate'])

    def test_offsetting_repeats_are_one_zero_difference_family(self):
        pairs = outcome_pairs()
        for pair in pairs:
            pair['candidatePassed'] = pair['repeat'] == 0
            pair['referencePassed'] = pair['repeat'] == 1
        report = paired_outcome_report(
            pairs, expected_groups=[f'g{i}' for i in range(200)], resamples=1000,
        )
        self.assertEqual(report['successDelta'], 0)
        self.assertEqual(report['negativeFamilies'], 0)
        self.assertEqual(report['anyLossFamilies'], 200)
        self.assertGreaterEqual(report['successLower'], -.02)


if __name__ == '__main__':
    unittest.main()
