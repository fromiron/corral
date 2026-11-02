import copy
import unittest

from controlled_holdout_oracle import evaluate, packet, remap


def case(events, query):
    return {'id': 'test', 'family': 'unit-fixture',
            'participants': ['a', 'b', 'c', 'd'],
            'events': [dict(id=f'e{i}', **event) for i, event in enumerate(events)],
            'query': query}


class InterpreterTests(unittest.TestCase):
    def test_transfer_requires_matching_acceptance_and_decline_is_final(self):
        rows = [{'type': 'assign', 'topic': 'x', 'participants': ['a']},
                {'type': 'offer_transfer', 'topic': 'x', 'from': 'a', 'to': 'b', 'transfer': 'h'}]
        query = {'type': 'owners', 'topic': 'x'}
        self.assertEqual(evaluate(case(rows, query))['eligibleIds'], ['a'])
        accepted = rows + [{'type': 'accept_transfer', 'transfer': 'h', 'participant': 'b'}]
        self.assertEqual(evaluate(case(accepted, query))['eligibleIds'], ['b'])
        declined = rows + [{'type': 'decline_transfer', 'transfer': 'h', 'participant': 'b'}]
        self.assertEqual(evaluate(case(declined, query))['eligibleIds'], ['a'])
        with self.assertRaises(ValueError):
            evaluate(case(declined + accepted[-1:], query))
        with self.assertRaises(ValueError):
            evaluate(case(rows + [{'type': 'accept_transfer', 'transfer': 'h', 'participant': 'c'}], query))

    def test_replacement_cancellation_completion_preserve_other_obligations(self):
        rows = [{'type': 'request', 'request': 'r1', 'topic': 'x', 'participant': 'a'},
                {'type': 'request', 'request': 'r2', 'topic': 'x', 'participant': 'b'},
                {'type': 'request', 'request': 'r3', 'topic': 'y', 'participant': 'd'},
                {'type': 'replace_request', 'old': 'r1', 'request': 'r4', 'topic': 'x', 'participant': 'c'},
                {'type': 'complete_request', 'request': 'r2'}]
        query = {'type': 'pending', 'topic': 'x'}
        self.assertEqual(evaluate(case(rows, query))['eligibleIds'], ['c'])
        rows += [{'type': 'cancel_request', 'request': 'r4'}]
        self.assertEqual(evaluate(case(rows, query))['mode'], 'none')
        self.assertEqual(evaluate(case(rows, {'type': 'pending', 'topic': 'y'}))['eligibleIds'], ['d'])

    def test_commitments_use_posted_conjunction_disjunction_only(self):
        rows = [{'type': 'commit', 'topic': 'x', 'participant': 'a', 'condition': {'all': ['f1', 'f2']}},
                {'type': 'commit', 'topic': 'x', 'participant': 'b', 'condition': {'any': ['f1', 'f2']}},
                {'type': 'fact', 'fact': 'f1'}]
        query = {'type': 'commitments', 'topic': 'x'}
        self.assertEqual(evaluate(case(rows, query))['eligibleIds'], ['b'])
        self.assertEqual(evaluate(case(rows + [{'type': 'fact', 'fact': 'f2'}], query))['eligibleIds'], ['a', 'b'])

    def test_order_skip_resume_and_completed_positions(self):
        rows = [{'type': 'order', 'topic': 'x', 'participants': ['a', 'b', 'c', 'd']},
                {'type': 'contributed', 'topic': 'x', 'participant': 'a'},
                {'type': 'skip', 'topic': 'x', 'participant': 'b'}]
        query = {'type': 'next_speaker', 'topic': 'x'}
        self.assertEqual(evaluate(case(rows, query))['eligibleIds'], ['c'])
        self.assertEqual(evaluate(case(rows + [{'type': 'resume', 'topic': 'x', 'participant': 'b'}], query))['eligibleIds'], ['b'])

    def test_recusal_scope_expiry_and_explicit_return(self):
        rows = [{'type': 'recuse', 'topic': 'x', 'participant': 'a', 'until': 3},
                {'type': 'recuse', 'topic': 'y', 'participant': 'b', 'until': 8},
                {'type': 'tick', 'value': 2}]
        query = {'type': 'available', 'topic': 'x'}
        self.assertEqual(evaluate(case(rows, query))['excludedIds'], ['a'])
        self.assertEqual(evaluate(case(rows + [{'type': 'tick', 'value': 3}], query))['excludedIds'], [])
        self.assertEqual(evaluate(case(rows + [{'type': 'return', 'topic': 'x', 'participant': 'a'}], query))['excludedIds'], [])

    def test_interleaved_topic_assignments_do_not_leak(self):
        rows = [{'type': 'assign', 'topic': 'x', 'participants': ['a', 'c']},
                {'type': 'assign', 'topic': 'y', 'participants': ['b']},
                {'type': 'focus', 'topic': 'x'}]
        self.assertEqual(evaluate(case(rows, {'type': 'focused_owners'}))['eligibleIds'], ['a', 'c'])

    def test_alias_update_preserves_identity_rejects_collision_and_stale_alias(self):
        rows = [{'type': 'alias', 'participant': 'a', 'alias': 'red'},
                {'type': 'alias', 'participant': 'b', 'alias': 'blue'},
                {'type': 'rename_alias', 'participant': 'a', 'old': 'red', 'new': 'green'},
                {'type': 'assign_alias', 'topic': 'x', 'alias': 'green'}]
        self.assertEqual(evaluate(case(rows, {'type': 'owners', 'topic': 'x'}))['eligibleIds'], ['a'])
        for event in [{'type': 'assign_alias', 'topic': 'x', 'alias': 'red'},
                      {'type': 'rename_alias', 'participant': 'b', 'old': 'blue', 'new': 'green'}]:
            with self.assertRaises(ValueError):
                evaluate(case(rows + [event], {'type': 'owners', 'topic': 'x'}))

    def test_correction_requires_acknowledgement_of_current_claim(self):
        rows = [{'type': 'claim', 'topic': 'x', 'claim': 'c1', 'participant': 'a'},
                {'type': 'propose_correction', 'old': 'c1', 'claim': 'c2', 'participant': 'b'}]
        query = {'type': 'current_claim', 'topic': 'x'}
        self.assertEqual(evaluate(case(rows, query))['eligibleIds'], ['a'])
        rows += [{'type': 'acknowledge_correction', 'claim': 'c2', 'participant': 'a'}]
        self.assertEqual(evaluate(case(rows, query))['eligibleIds'], ['b'])
        with self.assertRaises(ValueError):
            evaluate(case(rows + [{'type': 'acknowledge_correction', 'claim': 'c2', 'participant': 'a'}], query))

    def test_freshness_threshold_is_inclusive_without_future_observations(self):
        rows = [{'type': 'observation', 'topic': 'x', 'participant': 'a', 'epoch': 1},
                {'type': 'observation', 'topic': 'x', 'participant': 'b', 'epoch': 2},
                {'type': 'freshness', 'topic': 'x', 'minimum': 2}]
        query = {'type': 'fresh_observers', 'topic': 'x'}
        self.assertEqual(evaluate(case(rows, query))['eligibleIds'], ['b'])
        self.assertEqual(evaluate(case(rows + [{'type': 'freshness', 'topic': 'x', 'minimum': 3}], query))['mode'], 'none')

    def test_zero_multiple_matches_use_clarifier_single_match_uses_owner(self):
        rows = [{'type': 'clarifier', 'topic': 'x', 'participant': 'd'}]
        query = {'type': 'matching', 'topic': 'x', 'key': 'k', 'value': 'yes'}
        self.assertEqual(evaluate(case(rows, query))['eligibleIds'], ['d'])
        rows += [{'type': 'attribute', 'participant': 'a', 'key': 'k', 'value': 'yes'}]
        self.assertEqual(evaluate(case(rows, query))['eligibleIds'], ['a'])
        rows += [{'type': 'attribute', 'participant': 'b', 'key': 'k', 'value': 'yes'}]
        self.assertEqual(evaluate(case(rows, query))['eligibleIds'], ['d'])

    def test_closure_silence_and_remap_are_derived_without_mutation(self):
        rows = [{'type': 'request', 'request': 'r', 'topic': 'x', 'participant': 'a'}]
        value = case(rows, {'type': 'obligation', 'request': 'r'})
        before = copy.deepcopy(value)
        renamed = remap(value, {'a': 'd', 'b': 'c', 'c': 'b', 'd': 'a'}, ['b', 'c', 'd', 'a'])
        self.assertEqual(evaluate(renamed)['eligibleIds'], ['d'])
        self.assertEqual(value, before)
        value['events'] += [{'id': 'closed', 'type': 'complete_request', 'request': 'r'}]
        self.assertEqual(evaluate(value)['mode'], 'none')
        self.assertEqual(packet(value)['oracle']['mode'], 'none')
        self.assertTrue(all(event['facts'] for event in packet(value)['events']))

    def test_all_set_one_none_and_explicit_exclusion_have_distinct_semantics(self):
        rows = [{'type': 'assign', 'topic': 'x', 'participants': ['a', 'b', 'c', 'd']}]
        target = evaluate(case(rows, {'type': 'owners', 'topic': 'x'}))
        self.assertEqual(target['mode'], 'all')
        self.assertEqual(target['requiredIds'], ['a', 'b', 'c', 'd'])
        rows += [{'type': 'assign', 'topic': 'x', 'participants': ['a', 'c']}]
        target = evaluate(case(rows, {'type': 'owners', 'topic': 'x'}))
        self.assertEqual(target['mode'], 'set')
        self.assertEqual(target['requiredIds'], ['a', 'c'])
        self.assertEqual(target['excludedIds'], [])  # Unassigned is not explicitly forbidden.
        opt_outs = [{'type': 'recuse', 'topic': 'x', 'participant': p, 'until': 4}
                    for p in ['a', 'b', 'c', 'd']]
        target = evaluate(case(opt_outs[:-1], {'type': 'available', 'topic': 'x'}))
        self.assertEqual(target['mode'], 'one')
        self.assertEqual(target['eligibleIds'], ['d'])
        self.assertEqual(target['requiredIds'], [])
        target = evaluate(case(opt_outs, {'type': 'available', 'topic': 'x'}))
        self.assertEqual(target['mode'], 'none')
        self.assertEqual(target['excludedIds'], ['a', 'b', 'c', 'd'])

    def test_packets_expose_every_rule_before_query_and_reject_unknown_states(self):
        value = case([{'type': 'assign', 'topic': 'x', 'participants': ['a']},
                      {'type': 'offer_transfer', 'topic': 'x', 'from': 'a', 'to': 'b', 'transfer': 'h'}],
                     {'type': 'owners', 'topic': 'x'})
        rendered = packet(value)
        self.assertEqual(rendered['oracle']['evidenceTurnIds'], [e['id'] for e in rendered['events']])
        self.assertTrue(any('accepts' in f for f in rendered['events'][0]['facts']))
        self.assertEqual(rendered['symbolic'], value)
        with self.assertRaises(ValueError):
            evaluate(case([{'type': 'invented', 'participant': 'a'}], {'type': 'owners', 'topic': 'x'}))
        with self.assertRaises(ValueError):
            remap(value, {'a': 'x', 'b': 'x', 'c': 'z', 'd': 'w'})


if __name__ == '__main__':
    unittest.main()
