import copy
import json
from pathlib import Path
import tempfile
import unittest

from controlled_data import build_packets
from controlled_generate import (author_payload, declare_replacement, expand_family, qualify_review, review_prompt,
                                 validate_realization, write_once, known_terminal)


def fake_realization(packet):
    payload = author_payload(packet)
    return {'scenes': [{'id': scene['id'],
                       'turns': [{'id': event['id'], 'speakerId': event['speakerId'],
                                  'text': ' '.join(event['facts'])} for event in scene['events']],
                       'message': scene['question']} for scene in payload['scenes']]}


class ControlledGenerationTests(unittest.TestCase):
    def setUp(self):
        self.packet = build_packets()[0]
        self.answer = fake_realization(self.packet)

    def test_reviewer_is_blind_to_oracle_and_symbolic_facts(self):
        prompt = review_prompt(self.packet, self.answer)
        self.assertNotIn('symbolic', prompt)
        self.assertNotIn('evidenceTurnIds', prompt)
        self.assertNotIn(self.packet['family'], prompt)
        body = json.loads(prompt.split('\nVISIBLE_SCENES\n', 1)[1])
        self.assertEqual(len(body['scenes']), 6)
        self.assertEqual(set(body['scenes'][0]), {'id', 'input'})

    def test_structure_rejects_changed_speaker_missing_state_and_mentions(self):
        validate_realization(self.packet, self.answer)
        changed = copy.deepcopy(self.answer); changed['scenes'][0]['turns'][0]['speakerId'] = 'unregistered'
        with self.assertRaises(ValueError): validate_realization(self.packet, changed)
        changed = copy.deepcopy(self.answer); changed['scenes'].pop()
        with self.assertRaises(ValueError): validate_realization(self.packet, changed)
        changed = copy.deepcopy(self.answer); changed['scenes'][0]['message'] = '@Ara, answer.'
        with self.assertRaises(ValueError): validate_realization(self.packet, changed)

    def test_independent_labels_must_match_all_six_scenes(self):
        labels = []
        for scene in author_payload(self.packet)['scenes']:
            oracle = self.packet['states'][int(scene['id'][1])]['oracle']
            labels.append({'id': scene['id'], 'valid': True, 'mode': oracle['mode'],
                           'eligibleIds': oracle['eligibleIds'], 'excludedIds': oracle['excludedIds'], 'issues': []})
        self.assertTrue(qualify_review(self.packet, {'scenes': labels})['valid'])
        labels[0]['eligibleIds'] = ['not-registered']
        self.assertFalse(qualify_review(self.packet, {'scenes': labels})['valid'])

    def test_expansion_keeps_group_and_language_counts_and_remaps(self):
        rows = expand_family(self.packet, self.answer)
        self.assertEqual(len(rows), 20)
        self.assertEqual([sum(row['language'] == language for row in rows)
                          for language in ('ko', 'en', 'ja')], [12, 5, 3])
        self.assertEqual({row['group'] for row in rows}, {self.packet['family']})
        for row in rows:
            ids = {p['id'] for p in row['input']['participants']}
            self.assertTrue(set(row['target']['eligibleIds']) <= ids)
            self.assertTrue(set(row['target']['excludedIds']) <= ids)
            self.assertEqual(row['target']['mode'], self.packet['states'][row['source']['stateIndex']]['oracle']['mode'])

    def test_immutable_writes_and_unknown_call_are_not_terminal(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'marker.json'
            write_once(path, {'a': 1})
            with self.assertRaises(FileExistsError): write_once(path, {'a': 2})
            answer = Path(temporary) / 'answer.json'
            identity = {'effort': 'high', 'promptHash': 'p', 'schemaHash': 's',
                        'model': 'gpt-6.1-sol', 'provider': 'openai-codex'}
            write_once(Path(str(answer) + '.request.json'), identity)
            self.assertFalse(known_terminal(answer, 'author'))
            write_once(Path(str(answer) + '.incomplete.json'), {**identity, 'completionKnown': True, 'stopReason': 'length'})
            self.assertTrue(known_terminal(answer, 'author'))

    def test_unbound_terminal_marker_is_not_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            answer = Path(temporary) / 'answer.json'
            write_once(Path(str(answer) + '.request.json'), {'effort': 'high'})
            write_once(Path(str(answer) + '.incomplete.json'),
                       {'effort': 'high', 'completionKnown': True, 'stopReason': 'length'})
            self.assertFalse(known_terminal(answer, 'author'))

    def test_all_expanded_inputs_are_distinct_within_family(self):
        for packet in build_packets():
            rows = expand_family(packet, fake_realization(packet))
            self.assertEqual(len({json.dumps(row['input'], sort_keys=True) for row in rows}), 20)

    def test_replacements_are_declared_bounded_and_never_unknown(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); entries = []
            for index in range(10):
                family = f'family-{index}'
                entries.append({'family': family, 'split': 'fit', 'packetSha256': f'hash-{index}'})
                directory = root / 'fitting-attempts' / family / 'initial'
                write_once(directory / 'status.json', {'state': 'author-unknown' if index == 9 else 'structural-invalid', 'reviewCalls': 0})
                write_once(directory / 'author.answer.json.receipt.json', {'effort': 'high'})
            plan = {'families': entries}
            with self.assertRaisesRegex(ValueError, 'unknown'):
                declare_replacement(root, plan, 'family-9', 'initial', 'transport response unknown')
            for index in range(8):
                _, attempt = declare_replacement(root, plan, f'family-{index}', 'initial', 'completed response omitted a required turn')
                self.assertEqual(attempt, f'replacement-{index + 1}')
            with self.assertRaisesRegex(ValueError, 'already'):
                declare_replacement(root, plan, 'family-0', 'initial', 'same rejected attempt')
            with self.assertRaisesRegex(ValueError, 'exhausted'):
                declare_replacement(root, plan, 'family-8', 'initial', 'completed response omitted a required turn')


if __name__ == '__main__': unittest.main()
