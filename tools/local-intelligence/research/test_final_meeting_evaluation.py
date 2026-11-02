import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('final_meeting', Path(__file__).with_name('final-meeting-evaluation.py'))
final = importlib.util.module_from_spec(spec)
spec.loader.exec_module(final)


def row(key, group, excluded=True):
    return {'id': key, 'group': group, 'split': 'final', 'task': 'meeting', 'language': 'en',
            'input': {'participants': [{'id': 'p1'}, {'id': 'p2'}], 'message': 'PRIVATE TEXT', 'turns': []},
            'target': {'mode': 'one', 'eligibleIds': ['p1'], 'excludedIds': ['p2'] if excluded else []}}


def reports(rows):
    native = {'inputSha256': 'input', 'modelSha256': 'model', 'helperSha256': 'helper',
              'tokenizerSha256': 'tokenizer', 'normalizer': 'NFC()', 'inputBudget': 1024,
              'contextTokens': 2048, 'backend': 'gpu', 'complete': True, 'predictions': []}
    baseline = {'inputSha256': 'input', 'sourceSha256': 'baseline', 'baselineInputsSha256': 'views',
                'predictions': []}
    for item in rows:
        native['predictions'].append({'id': item['id'], 'group': item['group'], 'task': 'meeting',
            'seconds': .01, 'deadlineMiss': False, 'result': {'type': 'result', 'participantIds': ['p1'],
            'originalPromptTokens': 20, 'usedPromptTokens': 20, 'inputTruncated': False}})
        baseline['predictions'].append({'id': item['id'], 'task': 'meeting', 'selected': None,
            'applied': ['p1', 'p2'], 'milliseconds': 20, 'references': {
                'roleHistoryCosine_0.25': ['p2'], 'better_diagnostic': ['p1'],
                'shippedWithOneFallback': ['p2']}})
    return native, baseline


GATE = {'minimumDelta': .05, 'groupConfidence': .95, 'positiveLowerBound': True,
        'noNaturalExclusionRegression': True, 'explicitConstraintTestsRequired': True}
FREEZE = {'modelSha256': 'model', 'nativeHelperSha256': 'helper', 'backend': 'gpu',
          'inputBudget': 1024, 'contextTokens': 2048}


class FinalMeetingTests(unittest.TestCase):
    def test_identity_checks_reject_changed_model_helper_input_code_and_duplicate_ids(self):
        rows = [row('a', 'g1'), row('b', 'g2')]
        native, baseline = reports(rows)
        expected = {'sourceSha256': 'baseline', 'baselineInputsSha256': 'views'}
        final.validate_reports(rows, native, baseline, FREEZE, 'input', expected, 'tokenizer')
        for field in ['modelSha256', 'helperSha256', 'inputSha256', 'tokenizerSha256']:
            with self.assertRaises(ValueError):
                final.validate_reports(rows, {**native, field: 'changed'}, baseline, FREEZE, 'input', expected, 'tokenizer')
        with self.assertRaises(ValueError):
            final.validate_reports(rows, native, {**baseline, 'sourceSha256': 'changed'}, FREEZE, 'input', expected, 'tokenizer')
        with self.assertRaises(ValueError):
            final.validate_reports(rows, {**native, 'predictions': native['predictions'] * 2}, baseline, FREEZE, 'input', expected, 'tokenizer')

    def test_restored_ids_must_match_the_exact_runtime_alias_mapping(self):
        rows = [row('a', 'g1'), row('b', 'g2')]
        rows[0]['runtimeView'] = {'participantIds': ['p1', 'p2'], 'modelToOriginalIds': {'p1': 'p2', 'p2': 'p1'}}
        native, baseline = reports(rows)
        native['predictions'][0]['result']['modelParticipantIds'] = ['p1']
        with self.assertRaisesRegex(ValueError, 'restor'):
            final.validate_reports(rows, native, baseline, FREEZE, 'input', {}, 'tokenizer')

    def test_final_diagnostics_never_replace_the_frozen_primary_reference(self):
        rows = [row('a', 'g1'), row('b', 'g2')]
        native, baseline = reports(rows)
        result = final.score_population(rows, native, baseline, 'roleHistoryCosine_0.25', GATE)
        self.assertEqual(result['primaryComparison']['reference'], 'roleHistoryCosine_0.25')
        self.assertEqual(result['primaryComparison']['delta']['estimate'], 1.)
        self.assertEqual(result['diagnostics']['better_diagnostic']['validDispatch'], 1.)
        self.assertEqual(result['diagnostics']['shippedRaw']['validCount'], 0)
        self.assertTrue(result['gates']['observedMetricRequirementsMet'])
        self.assertIsNone(result['gates']['explicitConstraintTestsPassed'])

    def test_groups_not_variants_determine_accuracy_and_absent_exclusions_are_not_evidence(self):
        rows = [row('a', 'g1', False), row('b', 'g1', False), row('c', 'g1', False), row('d', 'g2', False)]
        native, baseline = reports(rows)
        for item in native['predictions'][:3]: item['result']['participantIds'] = ['p2']
        result = final.score_population(rows, native, baseline, 'roleHistoryCosine_0.25', GATE)
        self.assertEqual(result['candidateApplied']['validDispatch'], .5)
        self.assertEqual(result['candidateApplied']['rowValidRate'], .25)
        self.assertIsNone(result['gates']['noExclusionRegression'])
        self.assertFalse(result['gates']['observedMetricRequirementsMet'])

    def test_silence_and_failed_inference_remain_distinct(self):
        rows = [row('a', 'g1'), row('b', 'g2')]
        native, baseline = reports(rows)
        native['predictions'][0]['result']['participantIds'] = []
        native['predictions'][1]['result'] = {'type': 'error'}
        result = final.score_population(rows, native, baseline, 'roleHistoryCosine_0.25', GATE)
        self.assertEqual(result['candidateApplied']['none']['falseSilence'], 1)
        self.assertEqual(result['runtime']['fallbacks'], 1)
        self.assertEqual(result['runtime']['nativeErrors'], 1)

    def test_semantic_agreement_ignores_equivalent_mode_names_but_retains_exclusions(self):
        first = {'mode': 'one', 'eligibleIds': ['p1'], 'excludedIds': ['p2']}
        self.assertTrue(final.label_agreement(first, {**first, 'mode': 'set'})['semantic'])
        self.assertFalse(final.label_agreement(first, {**first, 'excludedIds': []})['semantic'])

    def test_review_receipt_must_be_explicit_high_and_bind_the_visible_response(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); (folder / 'bounded-high-v2').mkdir()
            label = {'id': 'a', 'target': row('a', 'g1')['target'], 'clear': True}
            answer = json.dumps({'labels': [label]}); request = 'request-hash'
            receipt = {'effort': 'high', 'model': 'independent-model', 'requestHash': request,
                       'responseHash': final.sha(answer.encode())}
            path = folder / 'bounded-high-v2/00.json'; path.write_text(answer)
            Path(str(path) + '.receipt.json').write_text(json.dumps(receipt))
            aggregate = {'effort': 'high', 'model': 'independent-model', 'requestHashes': [request]}
            final.verify_review_binding(folder, aggregate, [label], {})
            with self.assertRaises(ValueError):
                final.verify_review_binding(folder, {**aggregate, 'effort': 'medium'}, [label], {})
            path.write_text(json.dumps({'labels': []}))
            with self.assertRaises(ValueError):
                final.verify_review_binding(folder, aggregate, [label], {})

    def test_aggregate_excludes_private_rows_paths_and_message_text(self):
        full = {'version': 'v1', 'createdAt': 'now', 'model': {}, 'reference': {},
                'populations': {'teacher': {'count': 2, 'privateRows': [{'message': 'PRIVATE TEXT'}]}},
                'sources': {'/home/private': 'hash'}}
        text = json.dumps(final.sanitized_report(full))
        self.assertNotIn('PRIVATE TEXT', text)
        self.assertNotIn('/home/private', text)
        self.assertNotIn('privateRows', text)


if __name__ == '__main__': unittest.main()
