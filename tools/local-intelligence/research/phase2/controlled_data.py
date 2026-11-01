#!/usr/bin/env python3
"""Static, inspectable controlled predicates; no model or old-holdout dependencies."""
import copy
import hashlib
import json
import random

RESERVED = {
    'accepted-responsibility-transfer', 'superseded-request', 'remaining-assigned-work',
    'conditional-commitment', 'agreed-speaking-order', 'expiring-topic-specific-recusal',
    'topic-scoped-responsibility', 'recorded-alias-change', 'corrected-contribution',
    'stated-evidence-freshness', 'explicit-clarification-owner', 'conditional-silence-after-closure',
}
# Distinct static generator rules, never language/name variants counted as families.
DEFINITIONS = [
    ('range', ['x'], {'lo': 3, 'hi': 7}, 'whose reported box count is between 3 and 7, inclusive'),
    ('closest', ['x'], {'target': 5}, 'whose reported box count is closest to 5; ties all qualify'),
    ('category', ['color'], {'accepted': ['red', 'blue']}, 'whose badge is red or blue'),
    ('intersection', ['a', 'b'], {}, 'who have both a ladder and a cart'),
    ('union', ['a', 'b'], {}, 'who have a ladder, a cart, or both'),
    ('xor', ['a', 'b'], {}, 'who have exactly one of a ladder and a cart, but not both'),
    ('difference', ['a', 'b'], {}, 'who have a ladder but do not have a cart'),
    ('covers', ['items'], {'required': ['red', 'blue']}, 'whose stored ribbon colors include both red and blue'),
    ('disjoint', ['items'], {'forbidden': ['red', 'green']}, 'whose stored ribbon colors include neither red nor green'),
    ('overlap-count', ['items'], {'required': ['red', 'blue', 'green'], 'minimum': 2},
     'who store at least two different colors from red, blue, and green'),
    ('minimum', ['x'], {}, 'whose reported box count is the smallest; ties all qualify'),
    ('weighted', ['x', 'y'], {'limit': 14}, 'whose two-points-per-box plus one-point-per-crate total is at most 14'),
    ('lexicographic', ['x', 'y'], {}, 'with the most boxes; among those tied for most boxes, only those with the fewest crates qualify'),
    ('divisible', ['x'], {'unit': 3}, 'whose box count is a positive multiple of 3'),
    ('interval-overlap', ['start', 'end'], {'start': 3, 'end': 6},
     'whose stated available interval overlaps the interval from 3 to 6 for a positive duration; touching at an endpoint alone does not count'),
    ('ratio', ['x', 'y'], {'numerator': 2}, 'whose box count is at least twice their crate count'),
    ('proper-subset', ['items'], {'universe': ['red', 'blue', 'green']},
     'whose ribbon colors are a proper subset of red, blue, and green: no other colors, and at least one of those three colors missing'),
    ('exact-set', ['items'], {'required': ['red', 'blue']}, 'whose ribbon colors are exactly red and blue, with no other colors'),
    ('symmetric-difference', ['items'], {'required': ['red', 'blue'], 'distance': 1},
     'whose ribbon-color set differs from the set containing red and blue by exactly one added or missing color'),
    ('median', ['x'], {}, 'whose box count equals the median of all reported counts; with an even roster, use the average of the two middle counts'),
    ('residue', ['x'], {'modulus': 4, 'remainder': 1}, 'whose box count leaves remainder 1 when divided by 4'),
    ('balanced', ['x', 'y'], {'difference': 1}, 'whose box and crate counts differ by at most one'),
    ('shared-neighbor', ['links'], {}, 'who list at least one contact also listed by the first person in the contact directory'),
    ('reciprocal', ['links'], {}, 'who list at least one contact who also lists them back'),
    ('two-hop', ['links'], {}, 'who can reach the first person in the contact directory by exactly two directed contact links'),
    ('indegree', ['links'], {'count': 1}, 'who are listed as a contact by exactly one participant'),
    ('isolated', ['links'], {}, 'who list no contacts and are not listed by any participant'),
    ('all-neighbors', ['links', 'a'], {}, 'who list at least one contact and whose every listed contact has a ladder'),
    ('some-neighbor', ['links', 'a'], {}, 'who list at least one contact with a ladder'),
    ('max-mutual', ['links'], {}, 'who have the largest positive number of reciprocal contacts; ties all qualify, and zero never qualifies'),
    ('unique-source', ['links'], {}, 'who list someone that nobody else lists; at least one such uniquely listed contact is sufficient'),
    ('disjoint-neighbors', ['links'], {}, 'who list at least one contact and share none of their listed contacts with the first person in the contact directory'),
]
CATALOGUE = [
    {'family': f'controlled-static-{index + 1:02d}-{item[0]}',
     'split': 'fit' if index < 16 else 'calibration' if index < 24 else 'policy',
     'mechanism': item[0], 'fields': item[1], 'parameters': item[2], 'predicate': item[3],
     'mode': ('one', 'set', 'all-except', 'one-except')[index % 4],
     'rosterCount': (2, 4, 6)[index % 3]}
    for index, item in enumerate(DEFINITIONS)
]
NAMES = ['Ara', 'Bori', 'Cato', 'Dara', 'Eli', 'Faro']


def sha(value): return hashlib.sha256(value).hexdigest()


def canonical(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def validate_catalogue(catalogue):
    families = [item['family'] for item in catalogue]
    mechanisms = [item['mechanism'] for item in catalogue]
    if len(set(families)) != len(families) or len(set(mechanisms)) != len(mechanisms):
        raise ValueError('family/mechanism duplicated across partitions')
    if set(mechanisms) & RESERVED: raise ValueError('reserved final mechanism in static catalogue')
    if any(item['split'] not in {'fit', 'calibration', 'policy'} for item in catalogue):
        raise ValueError('static catalogue cannot enter final')


def evaluate(mechanism, rows, parameters):
    ids = [r['id'] for r in rows]
    if len(set(ids)) != len(ids): raise ValueError('duplicate participant')
    by_id = {r['id']: r for r in rows}
    links = {r['id']: set(r.get('links', [])) for r in rows}
    if any(not value <= set(ids) for value in links.values()): raise ValueError('unregistered contact')
    p = parameters
    def yes(r):
        x, y, items = r.get('x'), r.get('y'), set(r.get('items', []))
        neighbors = links[r['id']]
        if mechanism == 'range': return p['lo'] <= x <= p['hi']
        if mechanism == 'closest': return abs(x - p['target']) == min(abs(t['x'] - p['target']) for t in rows)
        if mechanism == 'category': return r['color'] in p['accepted']
        if mechanism == 'intersection': return r['a'] and r['b']
        if mechanism == 'union': return r['a'] or r['b']
        if mechanism == 'xor': return r['a'] != r['b']
        if mechanism == 'difference': return r['a'] and not r['b']
        if mechanism == 'covers': return set(p['required']) <= items
        if mechanism == 'disjoint': return not (set(p['forbidden']) & items)
        if mechanism == 'overlap-count': return len(set(p['required']) & items) >= p['minimum']
        if mechanism == 'minimum': return x == min(t['x'] for t in rows)
        if mechanism == 'weighted': return 2 * x + y <= p['limit']
        if mechanism == 'lexicographic': return (-x, y) == min((-t['x'], t['y']) for t in rows)
        if mechanism == 'divisible': return x > 0 and x % p['unit'] == 0
        if mechanism == 'interval-overlap': return max(r['start'], p['start']) < min(r['end'], p['end'])
        if mechanism == 'ratio': return x >= p['numerator'] * y
        if mechanism == 'proper-subset': return items < set(p['universe'])
        if mechanism == 'exact-set': return items == set(p['required'])
        if mechanism == 'symmetric-difference': return len(items ^ set(p['required'])) == p['distance']
        if mechanism == 'median':
            ordered = sorted(t['x'] for t in rows)
            return x == (ordered[(len(rows) - 1) // 2] + ordered[len(rows) // 2]) / 2
        if mechanism == 'residue': return x % p['modulus'] == p['remainder']
        if mechanism == 'balanced': return abs(x - y) <= p['difference']
        anchor = p.get('anchor', ids[0])
        if mechanism == 'shared-neighbor': return bool(neighbors & links[anchor])
        if mechanism == 'reciprocal': return any(r['id'] in links[n] for n in neighbors)
        if mechanism == 'two-hop': return any(anchor in links[n] for n in neighbors)
        if mechanism == 'indegree': return sum(r['id'] in value for value in links.values()) == p['count']
        if mechanism == 'isolated': return not neighbors and not any(r['id'] in value for value in links.values())
        if mechanism == 'all-neighbors': return bool(neighbors) and all(by_id[n]['a'] for n in neighbors)
        if mechanism == 'some-neighbor': return any(by_id[n]['a'] for n in neighbors)
        if mechanism == 'max-mutual':
            counts = {i: sum(i in links[n] for n in value) for i, value in links.items()}
            return counts[r['id']] > 0 and counts[r['id']] == max(counts.values())
        if mechanism == 'unique-source': return any(sum(n in value for value in links.values()) == 1 for n in neighbors)
        if mechanism == 'disjoint-neighbors': return bool(neighbors) and not neighbors & links[anchor]
        raise ValueError('unknown static mechanism')
    return [r['id'] for r in rows if yes(r)]


def derive_target(roster, matches, mode):
    if len(set(roster)) != len(roster) or not set(matches) <= set(roster):
        raise ValueError('invalid registered recipients')
    selected = set(matches)
    if mode in {'all-except', 'one-except'}: selected = set(roster) - selected
    if mode == 'none': selected = set()
    if mode not in {'one', 'set', 'all-except', 'one-except', 'none'}: raise ValueError('unknown mode')
    eligible = [i for i in roster if i in selected]
    result_mode = 'none' if not eligible else {'all-except': 'all', 'one-except': 'one'}.get(mode, mode)
    return {'mode': result_mode, 'eligibleIds': eligible,
            'excludedIds': [i for i in roster if i not in selected]}


def verbalize(symbolic, participants):
    names = {p['id']: p['name'] for p in participants}
    events = []
    fields = symbolic['fields']
    for index, event in enumerate(symbolic['events']):
        if event['op'] != 'assert': raise ValueError('state transition forbidden in static family')
        r = event['record']; facts = []
        if 'x' in fields: facts.append(f"I have {r['x']} boxes.")
        if 'y' in fields: facts.append(f"I have {r['y']} crates.")
        if 'a' in fields: facts.append('I have a ladder.' if r['a'] else 'I do not have a ladder.')
        if 'b' in fields: facts.append('I have a cart.' if r['b'] else 'I do not have a cart.')
        if 'color' in fields: facts.append(f"My badge is {r['color']}.")
        if 'items' in fields:
            facts.append('The complete set of ribbon colors I store is: ' + (', '.join(r['items']) or 'none') + '.')
        if 'start' in fields: facts.append(f"My available interval is from {r['start']} to {r['end']} on the same numbered-hour scale.")
        if 'links' in fields:
            facts.append('My complete directed-contact list is: ' + (', '.join(names[i] for i in r['links']) or 'nobody') + '.')
            if symbolic['parameters'].get('anchor') == r['id']:
                facts.append('I am the first person in the fixed contact directory; display roster order does not define this directory.')
        events.append({'id': f't{index + 1}', 'speakerId': r['id'], 'facts': facts})
    return events


def question(predicate, mode):
    if mode == 'one':
        return f'Consider participants {predicate}. Exactly one qualifying participant may reply; any one of them is acceptable. All nonqualifying participants must not reply. If nobody qualifies, nobody should reply.'
    if mode == 'set':
        return f'Consider participants {predicate}. Every qualifying participant must reply, and all nonqualifying participants must not reply. If nobody qualifies, nobody should reply.'
    if mode == 'all-except':
        return f'Everyone must reply except participants {predicate}; those excluded participants must not reply. If that excludes everyone, nobody should reply.'
    if mode == 'one-except':
        return f'Participants {predicate} must not reply. Exactly one of the other participants may reply; any one of those other participants is acceptable. If there are no other participants, nobody should reply.'
    raise ValueError('unsupported question mode')


def build_packets(seed=41):
    validate_catalogue(CATALOGUE)
    packets = []
    for spec in CATALOGUE:
        rng = random.Random(f'{seed}:{spec["family"]}')
        participants = [{'id': f'p{i + 1}', 'name': NAMES[i], 'role': ''}
                        for i in range(spec['rosterCount'])]
        ids = [p['id'] for p in participants]
        states = []; previous = None
        for state_index in range(2):
            for attempt in range(10000):
                rows = []
                for pid in ids:
                    start = rng.randrange(0, 8)
                    rows.append({'id': pid, 'x': rng.randrange(0, 10), 'y': rng.randrange(1, 8),
                                 'a': rng.choice([False, True]), 'b': rng.choice([False, True]),
                                 'color': rng.choice(['red', 'blue', 'green', 'yellow']),
                                 'items': [c for c in ['red', 'blue', 'green', 'yellow'] if rng.choice([False, True])],
                                 'start': start, 'end': start + rng.randrange(1, 5),
                                 'links': [other for other in ids if other != pid and rng.random() < .4]})
                params = {**spec['parameters'], **({'anchor': ids[0]} if 'links' in spec['fields'] else {})}
                matches = evaluate(spec['mechanism'], rows, params)
                target = derive_target(ids, matches, spec['mode'])
                if target != previous: break
            else: raise ValueError('could not construct contrasting static states')
            previous = target
            # The interpreter stores only observable fields, never unused hidden properties.
            records = [{key: row[key] for key in ['id', *spec['fields']]} for row in rows]
            if 'start' in spec['fields']:
                for row, original in zip(records, rows): row['end'] = original['end']
            symbolic = {'mechanism': spec['mechanism'], 'fields': spec['fields'], 'parameters': params,
                        'events': [{'op': 'assert', 'record': row} for row in records], 'mode': spec['mode']}
            events = verbalize(symbolic, participants)
            states.append({'id': f's{state_index}', 'group': spec['family'], 'participants': copy.deepcopy(participants),
                           'events': events, 'question': question(spec['predicate'], spec['mode']),
                           'oracle': {**target, 'evidenceTurnIds': [e['id'] for e in events]}, 'symbolic': symbolic})
        packet = {key: spec[key] for key in ('family', 'split', 'mechanism')}
        packet['states'] = states
        validate_packet(packet); packets.append(packet)
    return packets


def validate_packet(packet):
    if packet['mechanism'] in RESERVED or packet['split'] == 'final':
        raise ValueError('reserved mechanism is not a static family')
    if len(packet['states']) != 2: raise ValueError('two contrasting states required')
    for state in packet['states']:
        if state['group'] != packet['family']: raise ValueError('variant group mismatch')
        symbolic = state['symbolic']; ids = [p['id'] for p in state['participants']]
        if any(e['op'] != 'assert' for e in symbolic['events']): raise ValueError('static assertion required')
        if len(set(ids)) != len(ids) or len({p['name'] for p in state['participants']}) != len(ids):
            raise ValueError('participant ID/name duplicates')
        if state['events'] != verbalize(symbolic, state['participants']):
            raise ValueError('verbalized facts/order differ from symbolic source')
        rows = [e['record'] for e in symbolic['events']]
        if set(ids) != {r['id'] for r in rows}: raise ValueError('missing visible participant facts')
        target = derive_target(ids, evaluate(symbolic['mechanism'], rows, symbolic['parameters']), symbolic['mode'])
        if any(state['oracle'][key] != value for key, value in target.items()): raise ValueError('oracle mismatch')


def remap_packet(packet, id_mapper, name_mapper):
    result = copy.deepcopy(packet)
    for state in result['states']:
        for participant in state['participants']:
            participant['id'] = id_mapper(participant['id']); participant['name'] = name_mapper(participant['name'])
        for event in state['symbolic']['events']:
            row = event['record']; row['id'] = id_mapper(row['id'])
            if 'links' in row: row['links'] = [id_mapper(i) for i in row['links']]
        params = state['symbolic']['parameters']
        if 'anchor' in params: params['anchor'] = id_mapper(params['anchor'])
        state['events'] = verbalize(state['symbolic'], state['participants'])
        for key in ('eligibleIds', 'excludedIds'):
            state['oracle'][key] = [id_mapper(i) for i in state['oracle'][key]]
    return result
