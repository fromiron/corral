import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('candidate_evaluation', Path(__file__).with_name('candidate-evaluation.py'))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


def meeting():
    return {'id': 'm1', 'group': 'g1', 'task': 'meeting', 'split': 'policy',
            'input': {'participants': [{'id': 'p1'}, {'id': 'p2'}],
                      'turns': [{'id': 't1', 'speakerId': 'p2', 'text': 'visible'}], 'message': 'request'},
            'target': {'mode': 'one', 'eligibleIds': ['p1'], 'excludedIds': ['p2']}}


class CandidateEvaluationTests(unittest.TestCase):
    def test_final_is_rejected_before_reading_without_explicit_unseal_and_freeze(self):
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('must remain sealed')):
            with self.assertRaises(ValueError):
                candidate.read_dataset('final.jsonl', 'final')
            with self.assertRaises(ValueError):
                candidate.read_dataset('final.jsonl', 'final', unseal_final=True)

    def test_baseline_hash_missing_ids_and_duplicates_are_rejected(self):
        rows = [meeting()]
        good = {'inputSha256': 'source', 'predictions': [{'id': 'm1', 'task': 'meeting', 'applied': ['p1']}]}
        candidate.check_report(rows, good, 'source', native=False)
        for report in [
            {**good, 'inputSha256': 'old'}, {**good, 'predictions': []},
            {**good, 'predictions': good['predictions'] * 2},
        ]:
            with self.assertRaises(ValueError):
                candidate.check_report(rows, report, 'source', native=False)

    def test_fallback_never_uses_gold_exclusions_and_timely_none_stays_empty(self):
        row = meeting()
        result = candidate.meeting_decision(row, {'result': {'type': 'error'}, 'seconds': .1, 'deadlineMiss': False})
        self.assertEqual(result['applied'], ['p2'])
        self.assertTrue(result['fallback'])
        none = candidate.meeting_decision(row, {'result': {'type': 'result', 'participantIds': []}, 'seconds': .1, 'deadlineMiss': False})
        self.assertEqual(none['applied'], [])
        self.assertFalse(none['fallback'])

    def test_exact_deadline_discards_a_late_native_selection(self):
        result = candidate.meeting_decision(meeting(), {
            'result': {'type': 'result', 'participantIds': ['p1']}, 'seconds': 1.5, 'deadlineMiss': False,
        })
        self.assertTrue(result['fallback'])
        self.assertEqual(result['applied'], ['p2'])

    def test_core_fallback_priority_and_round_robin_are_preserved(self):
        row = meeting(); prediction = {'result': {'type': 'error'}, 'seconds': .1}
        self.assertEqual(candidate.meeting_decision(row, prediction, {'replyTargetId': 'p1'})['applied'], ['p1'])
        row['input']['turns'] = []
        self.assertEqual(candidate.meeting_decision(row, prediction, {'allRoundCount': 1})['applied'], ['p2'])

    def test_effort_failure_requires_an_explicit_base_fallback(self):
        row = {'id': 'e1', 'group': 'g1', 'task': 'effort', 'split': 'policy',
               'target': {'level': 'low', 'acceptableLevels': ['low']}}
        prediction = {'result': {'type': 'error'}, 'seconds': .1}
        with self.assertRaises(ValueError):
            candidate.effort_decisions([row], [prediction], 1.)
        result = candidate.effort_decisions([row], [prediction], 1., effort_fallback='high')
        self.assertEqual(result[0]['applied'], 'high')
        self.assertIsNone(result[0]['raw'])

    def test_quantization_point_rule_and_uncertainty_are_distinct(self):
        good = {'estimate': 0., 'interval': [-.025, .025], 'groups': 4}
        meeting_good = {'estimate': 0., 'interval': [-.005, .005], 'groups': 25}
        result = candidate.quantization_rule(good, meeting_good)
        self.assertTrue(result['pointRuleSatisfied'])
        self.assertEqual(result['status'], 'point-rule-passes-uncertain')
        self.assertIsNone(result['selectedQuantization'])
        bad = candidate.quantization_rule({'estimate': -.025, 'interval': [-.05, 0], 'groups': 4}, meeting_good)
        self.assertFalse(bad['pointRuleSatisfied'])

    def test_temperature_fit_rejects_policy_rows(self):
        row = {'id': 'e1', 'group': 'g1', 'task': 'effort', 'split': 'policy',
               'target': {'level': 'low', 'acceptableLevels': ['low']}}
        prediction = {'id': 'e1', 'task': 'effort', 'group': 'g1', 'seconds': .1,
                      'result': {'type': 'result', 'logits': [4, 0, 0, 0]}}
        with self.assertRaises(ValueError):
            candidate.calibrate([row], {'predictions': [prediction]})

    def test_quantization_comparison_requires_identical_tokenized_inputs(self):
        first = {'helperSha256': 'h', 'tokenizerSha256': 't', 'backend': 'gpu',
                 'normalizer': 'NFC()', 'contextTokens': 2048, 'inputBudget': 1024,
                 'predictions': [{'id': 'm1', 'result': {'type': 'result', 'inputTokenFingerprint': 'a',
                                                       'originalPromptTokens': 10, 'usedPromptTokens': 10}}]}
        second = json.loads(json.dumps(first))
        candidate.check_native_pair(first, second)
        second['predictions'][0]['result']['inputTokenFingerprint'] = 'changed'
        with self.assertRaises(ValueError):
            candidate.check_native_pair(first, second)

    def test_strongest_reference_is_never_reselected_on_final(self):
        with self.assertRaises(ValueError):
            candidate.select_strongest_reference({'a': {'validDispatch': 1., 'forbiddenRate': 0.}}, 'final')


if __name__ == '__main__':
    unittest.main()
