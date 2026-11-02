import json
import unittest

from ami_response_data import completed_turns, collect_rows, partition_groups


def act(key, speaker, start, end, text, kind='ami_da_4', meeting='ES3000a'):
    return {'id': key, 'meeting': meeting, 'speaker': speaker, 'start': start, 'end': end,
            'text': text, 'kind': kind, 'addressees': []}


PROFILES = {'ES3000a': {'A': 'PM', 'B': 'UI', 'C': 'ME', 'D': 'ID'}}


class AmiResponseTests(unittest.TestCase):
    def test_completed_acts_merge_by_speaker_before_the_last12_limit(self):
        acts = [act(f'a{i}', 'A' if i % 2 == 0 else 'B', i * 2, i * 2 + 1, str(i)) for i in range(15)]
        acts.extend([act('b1', 'C', 31, 32, 'first fragment'), act('b2', 'C', 32, 33, 'second fragment')])
        current = act('q', 'A', 40, 41, 'question', 'ami_da_5')
        turns = completed_turns(acts, current)
        self.assertEqual(len(turns), 12)
        self.assertEqual(turns[-1]['text'], 'first fragment second fragment')
        self.assertEqual([item['id'] for item in turns[-1]['constituents']], ['b1', 'b2'])
        self.assertEqual(turns[0]['constituents'][0]['id'], 'a4')

    def test_future_overlap_and_later_same_speaker_continuation_never_change_input(self):
        current = act('q', 'A', 10, 11, 'question', 'ami_da_5')
        prior = [act('a', 'A', 1, 2, 'known'), act('b', 'B', 3, 4, 'known reply')]
        hidden = [current, act('overlap', 'C', 9, 12, 'OVERLAP'),
                  act('later-same', 'A', 11, 12, 'LATER CONTINUATION'),
                  act('reply', 'B', 12, 13, 'FUTURE ANSWER')]
        self.assertEqual(completed_turns(prior, current), completed_turns(prior + hidden, current))

    def test_observed_responders_are_alternatives_not_a_requirement_for_all_to_reply(self):
        acts = [act('before', 'D', 0, 1, 'previous context'),
                act('q', 'A', 2, 3, 'Why?', 'ami_da_5'),
                act('b', 'B', 4, 5, 'FUTURE SUPPORT'),
                act('c', 'C', 6, 7, 'FUTURE OBJECTION'),
                act('self', 'A', 8, 9, 'SELF REPLY'),
                act('overlap', 'D', 2.5, 4, 'OVERLAP')]
        links = [{'id': target, 'meeting': 'ES3000a', 'source': 'q', 'target': target, 'type': kind}
                 for target, kind in [('b', 'apt_1'), ('c', 'apt_2'), ('self', 'apt_5'), ('overlap', 'apt_1')]]
        rows, audit = collect_rows(acts, links, PROFILES, set())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['target']['mode'], 'one')
        self.assertEqual(rows[0]['target']['eligibleIds'], ['p1', 'p2'])
        self.assertEqual(rows[0]['target']['excludedIds'], [])
        self.assertEqual(rows[0]['input']['message'], 'Why?')
        self.assertNotIn('FUTURE', json.dumps(rows[0]))
        self.assertNotIn('OVERLAP', json.dumps(rows[0]['input']))
        self.assertEqual(rows[0]['input']['participants'][0]['name'], 'B')
        self.assertEqual(audit['excludedLinks']['self-response'], 1)
        self.assertEqual(audit['excludedLinks']['overlapping-response'], 1)

    def test_exposed_teams_and_unknown_roles_cannot_enter_fresh_data(self):
        acts = [act('before', 'D', 0, 1, 'context'), act('q', 'A', 2, 3, 'Question?', 'ami_da_5'), act('b', 'B', 4, 5, 'reply')]
        links = [{'id': 'link', 'meeting': 'ES3000a', 'source': 'q', 'target': 'b', 'type': 'apt_5'}]
        self.assertEqual(collect_rows(acts, links, PROFILES, {'ami-team-ES3000'})[0], [])
        profiles = {'ES3000a': {**PROFILES['ES3000a'], 'C': ''}}
        self.assertEqual(collect_rows(acts, links, profiles, set())[0], [])

    def test_maximum_response_delay_is60_seconds_and_uncertain_stance_is_retained(self):
        acts = [act('before', 'D', 0, 1, 'context'), act('q', 'A', 2, 3, 'Why?', 'ami_da_5'),
                act('b', 'B', 63, 64, 'uncertain response'), act('c', 'C', 63.01, 64, 'too late')]
        links = [{'id': 'b-link', 'meeting': 'ES3000a', 'source': 'q', 'target': 'b', 'type': 'apt_3'},
                 {'id': 'c-link', 'meeting': 'ES3000a', 'source': 'q', 'target': 'c', 'type': 'apt_1'}]
        rows, audit = collect_rows(acts, links, PROFILES, set())
        self.assertEqual(rows[0]['target']['eligibleIds'], ['p1'])
        self.assertEqual(rows[0]['source']['linkedResponses'][0]['type'], 'apt_3')
        self.assertEqual(audit['excludedLinks']['late-response'], 1)

    def test_all_or_silence_language_is_quarantined_instead_of_overwritten_with_one(self):
        for question in ['Each of you should answer.', 'Everyone, your thoughts?', 'Everybody?',
                         'All of you, please reply.', 'Answer one by one.', 'Shall we go around?',
                         'Please do not reply.', "Please don't respond.", 'Nobody should answer.',
                         'No response is required.']:
            with self.subTest(question=question):
                acts = [act('before', 'D', 0, 1, 'context'), act('q', 'A', 2, 3, question, 'ami_da_5'),
                        act('b', 'B', 4, 5, 'reply')]
                links = [{'id': 'link', 'meeting': 'ES3000a', 'source': 'q', 'target': 'b', 'type': 'apt_1'}]
                rows, audit = collect_rows(acts, links, PROFILES, set())
                self.assertEqual(rows, [])
                self.assertEqual(audit['intentQuarantinedRows'], 1)

    def test_team_splits_are_deterministic_disjoint_and_do_not_reuse_exposed_teams(self):
        groups = {f'ami-team-ES{n:04}' for n in range(28)}
        result = partition_groups(groups, {'exposed'}, 41)
        self.assertEqual(result, partition_groups(reversed(sorted(groups)), {'exposed'}, 41))
        self.assertEqual({key: len(value) for key, value in result.items()},
                         {'final': 10, 'calibration': 3, 'policy': 3, 'fit': 12})
        values = [group for part in result.values() for group in part]
        self.assertEqual(len(values), len(set(values)))
        with self.assertRaises(ValueError): partition_groups(groups | {'exposed'}, {'exposed'}, 41)
        with self.assertRaises(ValueError): partition_groups({'one'}, set(), 41)


if __name__ == '__main__': unittest.main()
