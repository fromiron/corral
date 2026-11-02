import copy
import unittest

from controlled_data import (CATALOGUE, RESERVED, build_packets, derive_target,
                             evaluate, remap_packet, validate_catalogue, validate_packet)


class ControlledDataTests(unittest.TestCase):
    def test_fixed_group_partition_and_languages(self):
        packets = build_packets()
        self.assertEqual(len(packets), 32)
        self.assertEqual([sum(p['split'] == s for p in packets)
                          for s in ('fit', 'calibration', 'policy')], [16, 8, 8])
        groups = set()
        for packet in packets:
            validate_packet(packet)
            self.assertNotIn(packet['family'], groups)
            groups.add(packet['family'])
            rows = packet['states']
            self.assertEqual(len(rows), 2)
            self.assertEqual({r['group'] for r in rows}, {packet['family']})
            self.assertEqual(len({len(r['participants']) for r in rows}), 1)
            self.assertNotEqual(rows[0]['oracle'], rows[1]['oracle'])
        self.assertEqual({len(p['states'][0]['participants']) for p in packets}, {2, 4, 6})

    def test_boolean_and_set_counterexamples(self):
        rows = [{'id': 'a', 'a': True, 'b': True, 'items': ['red', 'blue']},
                {'id': 'b', 'a': True, 'b': False, 'items': ['red']},
                {'id': 'c', 'a': False, 'b': False, 'items': []}]
        self.assertEqual(evaluate('intersection', rows, {}), ['a'])
        self.assertEqual(evaluate('xor', rows, {}), ['b'])
        self.assertEqual(evaluate('difference', rows, {}), ['b'])
        self.assertEqual(evaluate('covers', rows, {'required': ['red', 'blue']}), ['a'])
        self.assertEqual(evaluate('disjoint', rows, {'forbidden': ['red']}), ['c'])

    def test_state_changes_are_forbidden_in_static_families(self):
        packet = build_packets()[0]
        packet['states'][0]['symbolic']['events'][0]['op'] = 'transfer'
        with self.assertRaisesRegex(ValueError, 'static'):
            validate_packet(packet)

    def test_empty_all_set_and_one_alternatives(self):
        roster = ['a', 'b', 'c']
        one = derive_target(roster, ['a', 'b'], 'one')
        self.assertEqual(one, {'mode': 'one', 'eligibleIds': ['a', 'b'], 'excludedIds': ['c']})
        self.assertEqual(derive_target(roster, [], 'one')['mode'], 'none')
        self.assertEqual(derive_target(roster, ['a', 'b'], 'set')['mode'], 'set')
        self.assertEqual(derive_target(roster, ['a'], 'all-except'),
                         {'mode': 'all', 'eligibleIds': ['b', 'c'], 'excludedIds': ['a']})
        self.assertEqual(derive_target(roster, ['a'], 'none')['eligibleIds'], [])
        with self.assertRaises(ValueError):
            derive_target(roster, ['not-registered'], 'one')

    def test_id_and_name_remapping_preserves_labels_and_group(self):
        packet = build_packets()[23]
        mapped = remap_packet(packet, lambda pid: 'new-' + pid,
                              lambda name: 'Alias-' + name)
        validate_packet(mapped)
        for before, after in zip(packet['states'], mapped['states']):
            self.assertEqual(before['group'], after['group'])
            self.assertEqual(after['oracle']['eligibleIds'],
                             ['new-' + pid for pid in before['oracle']['eligibleIds']])
            self.assertEqual(after['oracle']['excludedIds'],
                             ['new-' + pid for pid in before['oracle']['excludedIds']])
            self.assertEqual([p['name'] for p in after['participants']],
                             ['Alias-' + p['name'] for p in before['participants']])

    def test_reserved_mechanisms_and_split_clones_are_rejected(self):
        catalog = copy.deepcopy(CATALOGUE)
        catalog[0]['mechanism'] = sorted(RESERVED)[0]
        with self.assertRaises(ValueError): validate_catalogue(catalog)
        catalog = copy.deepcopy(CATALOGUE)
        catalog[-1]['mechanism'] = catalog[0]['mechanism']
        with self.assertRaises(ValueError): validate_catalogue(catalog)

    def test_facts_and_order_cannot_be_silently_changed(self):
        packet = build_packets()[0]
        packet['states'][0]['events'][0]['facts'] = ['A fact was omitted.']
        with self.assertRaisesRegex(ValueError, 'verbal'):
            validate_packet(packet)
        packet = build_packets()[0]
        packet['states'][0]['events'].reverse()
        with self.assertRaises(ValueError): validate_packet(packet)

    def test_static_graph_direction_and_roster_order(self):
        rows = [{'id': 'a', 'links': ['b'], 'a': True},
                {'id': 'b', 'links': ['a', 'c'], 'a': False},
                {'id': 'c', 'links': [], 'a': True}]
        self.assertEqual(evaluate('reciprocal', rows, {}), ['a', 'b'])
        self.assertEqual(evaluate('all-neighbors', rows, {}), ['b'])
        self.assertEqual(set(evaluate('reciprocal', list(reversed(rows)), {})), {'a', 'b'})


if __name__ == '__main__': unittest.main()
