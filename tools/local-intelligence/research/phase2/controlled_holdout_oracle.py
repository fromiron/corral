"""Prospective state-only oracle. No model, training, scoring, or previous holdout imports.

Events are assertions already spoken before the query. Every interpreter rule is
rendered by packet() as an earlier protocol utterance. Actual cases live privately.
"""
import copy


VERSION = 'controlled-holdout-state-v1'
FAMILIES = (
    'accepted-responsibility-transfer', 'superseded-request', 'remaining-assigned-work',
    'conditional-commitment', 'agreed-speaking-order', 'expiring-topic-specific-recusal',
    'topic-scoped-responsibility', 'recorded-alias-change', 'corrected-contribution',
    'stated-evidence-freshness', 'explicit-clarification-owner',
    'conditional-silence-after-closure',
)

# Declarative field schema is exported into the private manifest; no instance text here.
EVENT_FIELDS = {
    'assign': {'topic': 'text', 'participants': 'participants'},
    'offer_transfer': {'topic': 'text', 'from': 'participant', 'to': 'participant', 'transfer': 'text'},
    'accept_transfer': {'transfer': 'text', 'participant': 'participant'},
    'decline_transfer': {'transfer': 'text', 'participant': 'participant'},
    'request': {'request': 'text', 'topic': 'text', 'participant': 'participant'},
    'replace_request': {'old': 'text', 'request': 'text', 'topic': 'text', 'participant': 'participant'},
    'cancel_request': {'request': 'text'}, 'complete_request': {'request': 'text'},
    'commit': {'topic': 'text', 'participant': 'participant', 'condition': 'condition'},
    'fact': {'fact': 'text'}, 'order': {'topic': 'text', 'participants': 'participants'},
    'contributed': {'topic': 'text', 'participant': 'participant'},
    'skip': {'topic': 'text', 'participant': 'participant'},
    'resume': {'topic': 'text', 'participant': 'participant'},
    'recuse': {'topic': 'text', 'participant': 'participant', 'until': 'integer'},
    'return': {'topic': 'text', 'participant': 'participant'}, 'tick': {'value': 'integer'},
    'focus': {'topic': 'text'}, 'alias': {'participant': 'participant', 'alias': 'text'},
    'rename_alias': {'participant': 'participant', 'old': 'text', 'new': 'text'},
    'assign_alias': {'topic': 'text', 'alias': 'text'},
    'claim': {'topic': 'text', 'claim': 'text', 'participant': 'participant'},
    'propose_correction': {'old': 'text', 'claim': 'text', 'participant': 'participant'},
    'acknowledge_correction': {'claim': 'text', 'participant': 'participant'},
    'observation': {'topic': 'text', 'participant': 'participant', 'epoch': 'integer'},
    'freshness': {'topic': 'text', 'minimum': 'integer'},
    'clarifier': {'topic': 'text', 'participant': 'participant'},
    'attribute': {'participant': 'participant', 'key': 'text', 'value': 'text'},
}
QUERY_FIELDS = {
    'owners': {'topic': 'text'}, 'focused_owners': {}, 'pending': {'topic': 'text'},
    'commitments': {'topic': 'text'}, 'next_speaker': {'topic': 'text'},
    'available': {'topic': 'text'}, 'current_claim': {'topic': 'text'},
    'fresh_observers': {'topic': 'text'},
    'matching': {'topic': 'text', 'key': 'text', 'value': 'text'},
    'obligation': {'request': 'text'},
}

PROTOCOLS = {
    'owners': 'Only the currently assigned responsible people for the named topic must answer; each of them answers. If there is no current assignee, nobody answers. Topic assignments replace previous assignments only within that topic.',
    'focused_owners': 'Only the currently assigned responsible people for the most recently focused topic must answer, each once. Assignments to other topics remain separate.',
    'pending': 'Each person with an open request on the named topic must answer, and nobody else. Completion, cancellation or replacement closes that specific request; unrelated requests stay open. If none remain open, nobody replies.',
    'commitments': 'Each person whose stated condition for this topic is already met must now fulfill their commitment, and nobody else. Conditions use only facts already posted. ALL requires every named fact; ANY requires at least one. If no condition is met, nobody replies.',
    'next_speaker': 'Exactly the first unfinished, unskipped person in the recorded topic speaking order takes the next turn. A skip lasts until an explicit resume. Completed positions stay completed. If no position is eligible, nobody replies.',
    'available': 'Any exactly one person may volunteer on the named topic, except people with an active recusal for that topic. A recusal until checkpoint N applies while the current checkpoint is less than N. Explicit return ends that topic recusal immediately; other-topic recusals do not exclude a person. If all are excluded, nobody replies.',
    'current_claim': 'The author of the currently acknowledged claim on the named topic must explain it. A proposed correction replaces that claim and its response responsibility only when the current claim author explicitly accepts it. Unaccepted corrections do not replace anything.',
    'fresh_observers': 'Only people with already-posted observations on this topic at or above the most recently agreed minimum evidence checkpoint must answer; each qualifies separately and each answers once. Older observations stay in the record but do not qualify. If no posted observation qualifies, nobody replies.',
    'matching': 'Use the latest posted attribute value for each person. If exactly one person matches the requested attribute, that person answers. If zero or several match, only the designated topic clarification owner answers to resolve it.',
    'obligation': 'This is a record-only repeat of an existing request, not a new request. Its assigned person replies only if that exact request remains open. Completion or cancellation closes it; closed requests require silence.',
}
TRANSFER_RULE = 'An offered responsibility transfer changes the assignee only when its intended recipient explicitly accepts that still-open offer. Declining ends the offer without changing responsibility. Mere mention or an unacknowledged offer does not transfer responsibility.'
ALIAS_RULE = 'Aliases identify people only; names imply no skills. An explicit alias change replaces that person\'s old alias, retaining their identity. Only the current unique alias can be used in a later assignment.'


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _validate_fields(value, fields, roster, event=False):
    _require(set(value) == set(fields) | ({'id', 'type'} if event else {'type'}),
             'missing or unknown symbolic field')
    for key, kind in fields.items():
        x = value[key]
        if kind == 'participant':
            _require(x in roster, 'unregistered participant')
        elif kind == 'participants':
            _require(isinstance(x, list) and bool(x) and len(set(x)) == len(x)
                     and all(p in roster for p in x), 'invalid participant list')
        elif kind == 'integer':
            _require(type(x) is int and x >= 0, 'invalid checkpoint')
        elif kind == 'condition':
            _require(isinstance(x, dict) and len(x) == 1 and next(iter(x)) in ('all', 'any'),
                     'invalid condition operator')
            facts = next(iter(x.values()))
            _require(isinstance(facts, list) and bool(facts) and len(set(facts)) == len(facts)
                     and all(isinstance(f, str) and f for f in facts), 'invalid condition facts')
        else:
            _require(isinstance(x, str) and bool(x.strip()), 'invalid symbolic text')


def _result(case, ids, one=False, excluded=()):
    roster = case['participants']
    selected = [p for p in roster if p in set(ids)]
    forbidden = [p for p in roster if p in set(excluded)]
    _require(not set(selected) & set(forbidden), 'selected explicit exclusion')
    mode = ('none' if not selected else 'one' if one or len(selected) == 1
            else 'all' if set(selected) == set(roster) else 'set')
    return {'mode': mode, 'eligibleIds': selected,
            'requiredIds': [] if mode == 'one' else selected,
            'excludedIds': forbidden,
            'evidenceTurnIds': ['protocol'] + [e['id'] for e in case['events']]}


def evaluate(case):
    roster = case['participants']
    _require(isinstance(roster, list) and 2 <= len(roster) <= 6
             and all(isinstance(p, str) and p for p in roster)
             and len(set(roster)) == len(roster), 'invalid roster')
    events = case['events']
    _require(len({e['id'] for e in events}) == len(events)
             and all(isinstance(e['id'], str) and e['id'] and e['id'] != 'protocol' for e in events),
             'invalid event IDs')
    owners, transfers, requests, orders, skipped, completed = {}, {}, {}, {}, {}, {}
    commitments, facts, recusals, aliases, claims, corrections = [], set(), {}, {}, {}, {}
    observations, freshness, clarifiers, attributes = [], {}, {}, {}
    current_claims, focus, checkpoint = {}, None, 0
    for event in events:
        kind = event['type']
        _require(kind in EVENT_FIELDS, 'unknown event')
        _validate_fields(event, EVENT_FIELDS[kind], roster, event=True)
        topic, person = event.get('topic'), event.get('participant')
        if kind == 'assign':
            owners[topic] = list(event['participants'])
        elif kind == 'offer_transfer':
            token = event['transfer']
            _require(token not in transfers and event['from'] in owners.get(topic, [])
                     and event['from'] != event['to'], 'invalid transfer offer')
            transfers[token] = dict(event, open=True)
        elif kind in ('accept_transfer', 'decline_transfer'):
            transfer = transfers.get(event['transfer'])
            _require(transfer is not None and transfer['open'] and transfer['to'] == person,
                     'no matching open offer')
            transfer['open'] = False
            if kind == 'accept_transfer':
                t = transfer['topic']
                _require(transfer['from'] in owners.get(t, []), 'superseded transfer owner')
                owners[t] = list(dict.fromkeys(person if p == transfer['from'] else p for p in owners[t]))
        elif kind in ('request', 'replace_request'):
            token = event['request']
            _require(token not in requests, 'duplicate request')
            if kind == 'replace_request':
                old = requests.get(event['old'])
                _require(old is not None and old['open'], 'replacement has no open source')
                old['open'] = False
            requests[token] = {'topic': topic, 'participant': person, 'open': True}
        elif kind in ('cancel_request', 'complete_request'):
            request = requests.get(event['request'])
            _require(request is not None and request['open'], 'no open request to close')
            request['open'] = False
        elif kind == 'commit':
            commitments.append(event)
        elif kind == 'fact':
            facts.add(event['fact'])
        elif kind == 'order':
            _require(topic not in orders, 'speaking order already recorded')
            orders[topic] = list(event['participants'])
            skipped[topic], completed[topic] = set(), set()
        elif kind in ('contributed', 'skip', 'resume'):
            _require(person in orders.get(topic, []), 'speaker absent from topic order')
            if kind == 'contributed':
                _require(person not in completed[topic], 'position already completed')
                completed[topic].add(person)
            elif kind == 'skip':
                _require(person not in completed[topic], 'cannot skip completed position')
                skipped[topic].add(person)
            else:
                _require(person in skipped[topic], 'position was not skipped')
                skipped[topic].remove(person)
        elif kind == 'recuse':
            _require(event['until'] > checkpoint, 'recusal already expired')
            recusals[(topic, person)] = event['until']
        elif kind == 'return':
            _require((topic, person) in recusals, 'no topic recusal to end')
            del recusals[(topic, person)]
        elif kind == 'tick':
            _require(event['value'] >= checkpoint, 'checkpoint moved backwards')
            checkpoint = event['value']
        elif kind == 'focus':
            focus = topic
        elif kind == 'alias':
            _require(event['alias'] not in aliases and person not in aliases.values(), 'ambiguous initial alias')
            aliases[event['alias']] = person
        elif kind == 'rename_alias':
            _require(aliases.get(event['old']) == person and event['new'] not in aliases,
                     'invalid or ambiguous alias change')
            del aliases[event['old']]
            aliases[event['new']] = person
        elif kind == 'assign_alias':
            _require(event['alias'] in aliases, 'unknown or retired alias')
            owners[topic] = [aliases[event['alias']]]
        elif kind == 'claim':
            _require(event['claim'] not in claims and topic not in current_claims, 'duplicate initial claim')
            claims[event['claim']] = {'topic': topic, 'participant': person}
            current_claims[topic] = event['claim']
        elif kind == 'propose_correction':
            old = claims.get(event['old'])
            _require(old is not None and current_claims.get(old['topic']) == event['old']
                     and event['claim'] not in claims and event['claim'] not in corrections,
                     'correction source is not current')
            corrections[event['claim']] = dict(event, topic=old['topic'], open=True)
        elif kind == 'acknowledge_correction':
            proposal = corrections.get(event['claim'])
            _require(proposal is not None and proposal['open'], 'no unacknowledged correction')
            old = claims[proposal['old']]
            _require(person == old['participant'] and current_claims[old['topic']] == proposal['old'],
                     'correction acknowledgement is not by current claim owner')
            proposal['open'] = False
            claims[event['claim']] = {'topic': proposal['topic'], 'participant': proposal['participant']}
            current_claims[proposal['topic']] = event['claim']
        elif kind == 'observation':
            observations.append(event)
        elif kind == 'freshness':
            freshness[topic] = event['minimum']
        elif kind == 'clarifier':
            clarifiers[topic] = person
        elif kind == 'attribute':
            attributes[(person, event['key'])] = event['value']
    query = case['query']
    kind, topic = query['type'], query.get('topic')
    _require(kind in QUERY_FIELDS, 'unknown query')
    _validate_fields(query, QUERY_FIELDS[kind], roster)
    ids, one, excluded = [], False, []
    if kind in ('owners', 'focused_owners'):
        if kind == 'focused_owners':
            _require(focus is not None, 'no recorded focus')
            topic = focus
        ids = owners.get(topic, [])
    elif kind == 'pending':
        ids = [r['participant'] for r in requests.values() if r['topic'] == topic and r['open']]
    elif kind == 'commitments':
        for commitment in commitments:
            condition = commitment['condition']
            op, required = next(iter(condition.items()))
            satisfied = (all if op == 'all' else any)(f in facts for f in required)
            if commitment['topic'] == topic and satisfied:
                ids.append(commitment['participant'])
    elif kind == 'next_speaker':
        _require(topic in orders, 'no recorded topic order')
        ids = [p for p in orders[topic] if p not in completed[topic] and p not in skipped[topic]][:1]
    elif kind == 'available':
        excluded = [p for p in roster if recusals.get((topic, p), -1) > checkpoint]
        ids, one = [p for p in roster if p not in excluded], True
    elif kind == 'current_claim':
        token = current_claims.get(topic)
        ids = [claims[token]['participant']] if token else []
    elif kind == 'fresh_observers':
        _require(topic in freshness, 'no agreed evidence freshness')
        ids = [r['participant'] for r in observations
               if r['topic'] == topic and r['epoch'] >= freshness[topic]]
    elif kind == 'matching':
        _require(topic in clarifiers, 'no designated clarification owner')
        matches = [p for p in roster if attributes.get((p, query['key'])) == query['value']]
        ids = matches if len(matches) == 1 else [clarifiers[topic]]
    elif kind == 'obligation':
        _require(query['request'] in requests, 'no recorded obligation')
        r = requests[query['request']]
        ids = [r['participant']] if r['open'] else []
    return _result(case, ids, one, excluded)


def remap(case, mapping, order=None):
    """Only structural participant fields change; semantic body/alias tokens never change."""
    roster = case['participants']
    _require(set(mapping) == set(roster) and len(set(mapping.values())) == len(roster)
             and all(isinstance(p, str) and p for p in mapping.values()), 'remapping must be bijective')
    value = copy.deepcopy(case)
    value['participants'] = list(order) if order is not None else [mapping[p] for p in roster]
    _require(set(value['participants']) == set(mapping.values())
             and len(value['participants']) == len(roster), 'remapped roster differs')
    for event in value['events']:
        for key, kind in EVENT_FIELDS[event['type']].items():
            if kind == 'participant':
                event[key] = mapping[event[key]]
            elif kind == 'participants':
                event[key] = [mapping[p] for p in event[key]]
    evaluate(value)
    return value


def _event_text(e):
    t = e['type']
    if t == 'assign': return f"For topic {e['topic']}, the currently assigned responsible people are {', '.join(e['participants'])}."
    if t == 'offer_transfer': return f"Offer {e['transfer']}: {e['from']} offers their responsibility for topic {e['topic']} to {e['to']}; acceptance has not yet occurred."
    if t == 'accept_transfer': return f"{e['participant']} explicitly accepts still-open transfer offer {e['transfer']}."
    if t == 'decline_transfer': return f"{e['participant']} explicitly declines transfer offer {e['transfer']}, closing that offer."
    if t == 'request': return f"Open request {e['request']} on topic {e['topic']} is assigned to {e['participant']}."
    if t == 'replace_request': return f"Cancel old request {e['old']} and replace it with new open request {e['request']} on topic {e['topic']}, assigned to {e['participant']}. Other requests are unaffected."
    if t == 'cancel_request': return f"Request {e['request']} is explicitly cancelled and closed. Other requests are unaffected."
    if t == 'complete_request': return f"Request {e['request']} has been completed and is closed. Other requests are unaffected."
    if t == 'commit':
        op, facts = next(iter(e['condition'].items()))
        return f"{e['participant']} commits to respond on topic {e['topic']} once {op.upper()} of these facts have been posted: {', '.join(facts)}."
    if t == 'fact': return f"Confirmed and posted now: {e['fact']}."
    if t == 'order': return f"The agreed speaking order for topic {e['topic']} is {', '.join(e['participants'])}, from first to last."
    if t == 'contributed': return f"{e['participant']} has finished their contribution on topic {e['topic']}."
    if t == 'skip': return f"Skip {e['participant']}'s unfinished position on topic {e['topic']} until an explicit resume."
    if t == 'resume': return f"Resume {e['participant']}'s previously skipped position on topic {e['topic']} at its original place in the order."
    if t == 'recuse': return f"{e['participant']} explicitly opts out of responses on topic {e['topic']} until checkpoint {e['until']}; this does not affect other topics."
    if t == 'return': return f"{e['participant']} explicitly returns to responses on topic {e['topic']}, ending that recusal."
    if t == 'tick': return f"The current checkpoint is now {e['value']}."
    if t == 'focus': return f"The active agenda topic is now {e['topic']}."
    if t == 'alias': return f"{e['participant']}'s current discussion alias is {e['alias']}."
    if t == 'rename_alias': return f"{e['participant']} changes their alias from {e['old']} to {e['new']}; the person is unchanged and the old alias is retired."
    if t == 'assign_alias': return f"The person currently using alias {e['alias']} is assigned sole responsibility for topic {e['topic']}."
    if t == 'claim': return f"The current acknowledged claim on topic {e['topic']} is {e['claim']}, authored by {e['participant']}."
    if t == 'propose_correction': return f"{e['participant']} proposes corrected claim {e['claim']} to replace claim {e['old']}; it has not yet been accepted."
    if t == 'acknowledge_correction': return f"{e['participant']} explicitly accepts correction {e['claim']} as replacing the current claim and its response responsibility."
    if t == 'observation': return f"{e['participant']} already posted an observation on topic {e['topic']} collected at evidence checkpoint {e['epoch']}."
    if t == 'freshness': return f"For topic {e['topic']}, we agree that qualifying observations must have been collected at evidence checkpoint {e['minimum']} or later."
    if t == 'clarifier': return f"{e['participant']} is the designated clarification owner for topic {e['topic']} when the matching rule has zero or several matches."
    if t == 'attribute': return f"{e['participant']}'s latest recorded value for {e['key']} is {e['value']}."
    raise ValueError('unrenderable event')


def packet(case):
    oracle = evaluate(case)
    query, roster = case['query'], case['participants']
    kind, topic = query['type'], query.get('topic')
    rules = [PROTOCOLS[kind]]
    if any(e['type'] == 'offer_transfer' for e in case['events']): rules.append(TRANSFER_RULE)
    if any(e['type'] in ('alias', 'rename_alias') for e in case['events']): rules.append(ALIAS_RULE)
    questions = {
        'owners': f"Please answer the pending matter on topic {topic} under our responsibility rule.",
        'focused_owners': 'Please answer the pending matter for the active agenda topic under our responsibility rule.',
        'pending': f"Please fulfill the still-open requests on topic {topic}, under our agreed rule.",
        'commitments': f"Please fulfill any commitments whose conditions are already met on topic {topic}.",
        'next_speaker': f"Continue topic {topic} with the next eligible turn under our agreed order.",
        'available': f"Could any one available person volunteer on topic {topic}, respecting our recorded opt-outs?",
        'current_claim': f"Please explain the currently acknowledged claim on topic {topic} under our correction rule.",
        'fresh_observers': f"Please report the qualifying already-posted observations for topic {topic} under our freshness rule.",
        'matching': f"For topic {topic}, please handle the match for {query.get('key')} equal to {query.get('value')} under our clarification rule.",
        'obligation': f"Record-only repeat for request {query.get('request')}; follow our closure rule without opening a new request.",
    }
    return {'id': case['id'], 'family': case['family'], 'split': 'final',
            'participants': [{'id': p, 'name': p, 'role': ''} for p in roster],
            'keepRosterCounts': [len(roster)],
            'events': [{'id': 'protocol', 'speakerId': None, 'facts': rules}] +
                      [{'id': e['id'], 'speakerId': None, 'facts': [_event_text(e)]} for e in case['events']],
            'question': questions[kind], 'oracle': oracle, 'symbolic': copy.deepcopy(case)}


def schema():
    """Machine-readable discriminators and field types consumed by case builders."""
    return {'version': VERSION, 'families': list(FAMILIES),
            'caseRequired': ['id', 'family', 'participants', 'events', 'query'],
            'eventRequired': ['id', 'type'], 'eventFields': copy.deepcopy(EVENT_FIELDS),
            'queryRequired': ['type'], 'queryFields': copy.deepcopy(QUERY_FIELDS),
            'condition': {'oneOf': [{'all': 'nonempty unique fact strings'}, {'any': 'nonempty unique fact strings'}]},
            'target': {'mode': ['one', 'set', 'all', 'none'],
                       'eligibleIds': 'registered participant IDs; one means any exactly one',
                       'requiredIds': 'empty for one, otherwise identical to eligibleIds',
                       'excludedIds': 'explicit active topic recusal only, not irrelevant people',
                       'evidenceTurnIds': 'protocol and already-posted event IDs'},
            'variantRule': 'language, participant ID, name, roster order, and state variants keep family unchanged'}
