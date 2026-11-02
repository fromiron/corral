#!/usr/bin/env python3
"""Prepare fresh-team AMI observed-response data; no fitting, inference or teacher calls."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

NS = '{http://nite.sourceforge.net/}'
ELICIT = {'ami_da_5', 'ami_da_8', 'ami_da_11', 'ami_da_13'}
ROLES = {'PM': 'project manager', 'UI': 'user interface designer',
         'ME': 'marketing expert', 'ID': 'industrial designer'}
RELATIONS = {'apt_1': 'support/positive assessment', 'apt_2': 'objection/negative assessment',
             'apt_3': 'uncertain', 'apt_4': 'partial agreement/support', 'apt_5': 'elaboration'}
SOURCE_URL = 'https://groups.inf.ed.ac.uk/ami/download/'
LICENSE_URL = 'https://groups.inf.ed.ac.uk/ami/corpus/license.shtml'
MAX_LINK_DELAY_SECONDS = 60
UNCERTAIN_EVIDENCE = {
    'label': 'apt_3', 'retained': True,
    'meaning': 'The respondent expresses uncertainty or inability to supply the elicited information; not annotator-confidence uncertainty.',
    'source': 'https://groups.inf.ed.ac.uk/ami/corpus/Guidelines/dialogue_acts_manual_1.0.pdf',
    'section': 'Describing Relationships, printed page24',
}


def intent_audit_flags(text):
    # These are conservative review flags, NOT a natural-language intent classifier.
    # An observed positive response cannot establish an all/none product label.
    normalized = re.sub(r'\s+', ' ', text.casefold().replace('’', "'")).strip()
    patterns = {
        'group-response-language': r'\b(?:each of you|everyone|everybody|all of you|one by one|go around)\b',
        'silence-language': r"\b(?:(?:do not|do n't|don't|dont)\s+(?:reply|respond|answer|speak)|(?:nobody|no one)\s+(?:should|must|needs to|has to)\s+(?:reply|respond|answer|speak)|no\s+(?:response|reply|answer)\s+(?:is\s+)?(?:needed|required)|(?:stay|remain|keep)\s+silent)\b",
    }
    return [name for name, pattern in patterns.items() if re.search(pattern, normalized)]


def sha(raw): return hashlib.sha256(raw).hexdigest()


def session_group(meeting): return 'ami-team-' + re.sub(r'[a-z]$', '', meeting)


def pointer_id(element, role):
    pointer = next((item for item in element.findall(NS + 'pointer') if item.get('role') == role), None)
    ids = re.findall(r'id\(([^)]+)\)', pointer.get('href', '')) if pointer is not None else []
    return ids[0] if len(ids) == 1 else None


def completed_turns(acts, current, limit=12):
    # The input depends exclusively on already-completed text. Adding an overlapping
    # or future act cannot change merging boundaries or any visible constituent.
    visible = sorted((item for item in acts if item['id'] != current['id'] and item['end'] <= current['start']),
                     key=lambda item: (item['start'], item['end'], item['id']))
    turns = []
    for item in visible:
        constituent = {key: item[key] for key in ('id', 'start', 'end')}
        if turns and turns[-1]['speaker'] == item['speaker']:
            turns[-1]['text'] += ' ' + item['text']
            turns[-1]['end'] = max(turns[-1]['end'], item['end'])
            turns[-1]['constituents'].append(constituent)
        else:
            turns.append({'speaker': item['speaker'], 'text': item['text'], 'start': item['start'],
                          'end': item['end'], 'constituents': [constituent]})
    return turns[-limit:]


def read_archive(path):
    acts = []; links = []; profiles = {}; groups = defaultdict(lambda: {'meetings': [], 'acts': 0})
    explicit = Counter(); explicit_by_group = Counter(); relation_counts = Counter(); errors = Counter()
    roster_groups = defaultdict(set)
    with zipfile.ZipFile(path) as archive:
        license_text = archive.read('LICENCE.txt').decode('utf8')
        if 'Attribution 4.0' not in license_text: raise ValueError('archive license differs from expected CC BY 4.0')
        for meeting in ET.fromstring(archive.read('corpusResources/meetings.xml')):
            name = meeting.get('observation'); group = session_group(name)
            profiles[name] = {person.get('nxt_agent'): person.get('role', '') for person in meeting}
            groups[group]['meetings'].append(name)
            roster = sorted(person.get('global_name', '') for person in meeting)
            if roster and all(roster): roster_groups[sha(json.dumps(roster).encode())].add(group)
        for path in sorted(archive.namelist()):
            if not path.startswith('dialogueActs/') or not path.endswith('.dialog-act.xml'): continue
            meeting, speaker = Path(path).name.split('.')[:2]; word_cache = {}
            for item in ET.fromstring(archive.read(path)):
                if 'addressee' in item.attrib:
                    explicit[item.get('addressee')] += 1; explicit_by_group[session_group(meeting)] += 1
                selected = []; mismatch = False
                for child in item.findall(NS + 'child'):
                    name, fragment = child.get('href').split('#', 1)
                    if not name.startswith(f'{meeting}.{speaker}.'):
                        mismatch = True; break
                    if name not in word_cache:
                        entries = list(ET.fromstring(archive.read('words/' + name)))
                        word_cache[name] = entries, {word.get(NS + 'id'): index for index, word in enumerate(entries)}
                    entries, indexes = word_cache[name]; ids = re.findall(r'id\(([^)]+)\)', fragment)
                    if not ids or ids[0] not in indexes or ids[-1] not in indexes:
                        mismatch = True; break
                    selected.extend(entries[indexes[ids[0]]:indexes[ids[-1]] + 1])
                text = ' '.join(word.text for word in selected if word.tag == 'w' and word.text)
                timed = [word for word in selected if word.get('starttime') and word.get('endtime')]
                if mismatch or not timed or not text.strip():
                    errors['word-reference-or-empty-text'] += 1; continue
                start = min(float(word.get('starttime')) for word in timed)
                end = max(float(word.get('endtime')) for word in timed)
                if not math.isfinite(start) or not math.isfinite(end) or end < start:
                    errors['invalid-time'] += 1; continue
                acts.append({'id': item.get(NS + 'id'), 'meeting': meeting, 'speaker': speaker,
                             'start': start, 'end': end, 'text': text,
                             'kind': pointer_id(item, 'da-aspect'),
                             'addressees': [value.strip() for value in item.get('addressee', '').split(',') if value.strip()]})
                groups[session_group(meeting)]['acts'] += 1
        for path in sorted(archive.namelist()):
            if not path.startswith('dialogueActs/') or not path.endswith('.adjacency-pairs.xml'): continue
            meeting = Path(path).name.split('.')[0]
            for item in ET.fromstring(archive.read(path)):
                kind = pointer_id(item, 'type'); relation_counts[kind] += 1
                links.append({'id': item.get(NS + 'id'), 'meeting': meeting, 'type': kind,
                              'source': pointer_id(item, 'source'), 'target': pointer_id(item, 'target')})
        participants = ET.fromstring(archive.read('corpusResources/participants.xml'))
        participant_fields = sorted({field for person in participants for field in person.attrib})
    if len({item['id'] for item in acts}) != len(acts): raise ValueError('dialogue-act IDs are not unique')
    return acts, links, profiles, {
        'metadataMeetings': len(profiles), 'metadataGroups': len(groups), 'groups': dict(sorted(groups.items())),
        'parsedActs': len(acts), 'parsedMeetings': len({item['meeting'] for item in acts}),
        'parseExclusions': dict(errors), 'explicitAddresseeAttributes': sum(explicit.values()),
        'explicitAddresseeGroups': dict(sorted(explicit_by_group.items())),
        'explicitAddresseeValues': dict(explicit), 'adjacencyLinks': len(links),
        'adjacencyGroups': len({session_group(item['meeting']) for item in links}),
        'relationLabels': RELATIONS, 'allRelationCounts': dict(relation_counts),
        'participantMetadataFields': participant_fields,
        'crossGroupFullRosterCollisions': [sorted(value) for value in roster_groups.values() if len(value) > 1],
    }, license_text


def collect_rows(acts, links, profiles, exposed):
    by_id = {item['id']: item for item in acts}; by_meeting = defaultdict(list)
    for item in acts: by_meeting[item['meeting']].append(item)
    histories = {}; selected = defaultdict(list); excluded = Counter(); kept_relations = Counter()
    for link in links:
        source, target = by_id.get(link['source']), by_id.get(link['target'])
        if source is None or target is None: reason = 'missing-endpoint'
        elif source['meeting'] != target['meeting'] or source['meeting'] != link['meeting']: reason = 'cross-meeting-link'
        elif session_group(source['meeting']) in exposed: reason = 'exposed-team'
        elif link['type'] not in RELATIONS: reason = 'unknown-relation'
        elif source['kind'] not in ELICIT: reason = 'non-elicitation-source'
        else:
            roster = profiles.get(source['meeting'], {})
            if (not 3 <= len(roster) <= 7 or source['speaker'] not in roster or target['speaker'] not in roster
                    or any(role not in ROLES for role in roster.values())): reason = 'unknown-role-or-roster'
            elif source['speaker'] == target['speaker']: reason = 'self-response'
            elif target['start'] < source['end']: reason = 'overlapping-response'
            elif target['start'] > source['end'] + MAX_LINK_DELAY_SECONDS: reason = 'late-response'
            else:
                if source['id'] not in histories:
                    histories[source['id']] = completed_turns(by_meeting[source['meeting']], source)
                reason = None if histories[source['id']] else 'no-completed-prior-context'
        if reason:
            excluded[reason] += 1; continue
        selected[source['id']].append(link); kept_relations[link['type']] += 1
    rows = []; intent_quarantine = []
    for source_id, evidence in sorted(selected.items()):
        current = by_id[source_id]; roster = profiles[current['meeting']]
        flags = intent_audit_flags(current['text'])
        if flags:
            excluded['intent-compatibility-unreviewed'] += len(evidence)
            intent_quarantine.append({'sourceActId': source_id, 'group': session_group(current['meeting']), 'flags': flags})
            continue
        others = sorted(speaker for speaker in roster if speaker != current['speaker'])
        aliases = {speaker: f'p{index + 1}' for index, speaker in enumerate(others)}
        history = histories[source_id]
        if any(turn['speaker'] not in roster for turn in history):
            excluded['unknown-history-speaker'] += len(evidence); continue
        responders = {by_id[link['target']]['speaker'] for link in evidence}
        x = {'participants': [{'id': aliases[speaker], 'name': speaker, 'role': ROLES[roster[speaker]]} for speaker in others],
             'turns': [{'id': f't{index + 1}', 'speakerId': aliases.get(turn['speaker']), 'text': turn['text']}
                       for index, turn in enumerate(history)], 'message': current['text']}
        rows.append({'id': 'ami-response-' + sha(source_id.encode())[:20], 'group': session_group(current['meeting']),
                     'task': 'meeting', 'language': 'en', 'input': x,
                     'target': {'mode': 'one', 'eligibleIds': [aliases[speaker] for speaker in others if speaker in responders],
                                'excludedIds': [], 'evidence': 'One of the later human-annotated linked responders; alternatives, not an all-must-reply label.'},
                     'source': {'corpus': 'AMI public manual archive', 'license': 'CC-BY-4.0',
                                'annotation': 'human adjacency-pair source/target links',
                                'proxy': 'observed-response selection, not intended-addressee or general dispatch truth',
                                'meeting': current['meeting'], 'sourceActId': source_id,
                                'sourceSpeakerCode': current['speaker'], 'elicitationType': current['kind'],
                                'sourceStart': current['start'], 'sourceEnd': current['end'],
                                'historyCutoff': current['start'],
                                'representation': 'last12 chronological speaker runs of already-completed dialogue acts',
                                'historyTurns': [{'turnId': f't{index + 1}', 'speakerCode': turn['speaker'],
                                                  'start': turn['start'], 'end': turn['end'], 'constituents': turn['constituents']}
                                                 for index, turn in enumerate(history)],
                                'linkedResponses': [{'id': link['id'], 'type': link['type'], 'targetActId': link['target'],
                                                     'speakerCode': by_id[link['target']]['speaker'],
                                                     'start': by_id[link['target']]['start'], 'end': by_id[link['target']]['end']}
                                                    for link in evidence]}})
    fingerprints = defaultdict(list)
    for row in rows:
        fingerprints[sha(unicodedata.normalize('NFC', json.dumps(row['input'], sort_keys=True, ensure_ascii=False)).encode())].append(row)
    collisions = {key for key, members in fingerprints.items() if len({row['group'] for row in members}) > 1}
    quarantined = [row for key in collisions for row in fingerprints[key]]
    rows = [row for key, members in fingerprints.items() if key not in collisions for row in members]
    rows.sort(key=lambda row: (row['group'], row['id']))
    delays = sorted(response['start'] - row['source']['sourceEnd'] for row in rows for response in row['source']['linkedResponses'])
    return rows, {'excludedLinks': dict(excluded), 'eligibleRelationCountsBeforeIntentAndDuplicateQuarantine': dict(kept_relations),
                  'keptRelationCounts': dict(Counter(response['type'] for row in rows for response in row['source']['linkedResponses'])),
                  'intentQuarantinedRows': len(intent_quarantine), 'intentQuarantine': intent_quarantine,
                  'intentQuarantineFlags': dict(Counter(flag for item in intent_quarantine for flag in item['flags'])),
                  'crossGroupExactInputQuarantineRows': len(quarantined),
                  'quarantinedRowIds': [row['id'] for row in quarantined],
                  'rows': len(rows), 'groups': len({row['group'] for row in rows}),
                  'rowsByGroup': dict(sorted(Counter(row['group'] for row in rows).items())),
                  'multipleEligibleResponders': sum(len(row['target']['eligibleIds']) > 1 for row in rows),
                  'shortSourceUtterancesAtMost3Words': sum(len(row['input']['message'].split()) <= 3 for row in rows),
                  'responseDelaySeconds': {'count': len(delays), 'minimum': min(delays) if delays else None,
                                          'median': delays[len(delays) // 2] if delays else None,
                                          'p95': delays[min(len(delays) - 1, int(len(delays) * .95))] if delays else None,
                                          'maximum': max(delays) if delays else None,
                                          'over60Seconds': sum(value > 60 for value in delays)}}


def partition_groups(groups, exposed, seed, final_count=10, calibration_count=3, policy_count=3):
    groups = set(groups)
    if groups & set(exposed): raise ValueError('exposed teams cannot enter a fresh partition')
    if len(groups) < final_count + calibration_count + policy_count + 2:
        raise ValueError('not enough fresh teams for independent F/C/P/H')
    ordered = sorted(groups, key=lambda group: sha(f'ami-observed-response-v1:{seed}:{group}'.encode()))
    return {'final': ordered[:final_count],
            'calibration': ordered[final_count:final_count + calibration_count],
            'policy': ordered[final_count + calibration_count:final_count + calibration_count + policy_count],
            'fit': ordered[final_count + calibration_count + policy_count:]}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--archive', required=True); parser.add_argument('--exposed', required=True)
    parser.add_argument('--out', required=True); parser.add_argument('--seed', type=int, default=41)
    parser.add_argument('--freeze', action='store_true'); args = parser.parse_args()
    output = Path(args.out)
    if output.exists(): raise ValueError('immutable phase2 output directory already exists')
    for parent in (output.resolve(), *output.resolve().parents):
        if (parent / '.git').exists(): raise ValueError('raw natural records must stay outside Git')
    exposed_raw = Path(args.exposed).read_bytes(); exposed = {json.loads(line)['group'] for line in exposed_raw.splitlines() if line.strip()}
    acts, links, profiles, inventory, license_text = read_archive(args.archive)
    rows, audit = collect_rows(acts, links, profiles, exposed)
    inventory['exposedTeamsExcluded'] = sorted(exposed); inventory['observedResponse'] = audit
    inventory['freshExplicitAddresseeActs'] = {group: count for group, count in inventory['explicitAddresseeGroups'].items() if group not in exposed}
    fresh = {row['group'] for row in rows}
    for collision in inventory['crossGroupFullRosterCollisions']:
        if len(set(collision) & fresh) > 1 or (set(collision) & fresh and set(collision) & exposed):
            raise ValueError('the same recorded full team crosses group IDs; grouping requires review')
    # Explicit addressee supervision is kept separate; no substitution with response links.
    by_meeting = defaultdict(list)
    for item in acts: by_meeting[item['meeting']].append(item)
    direct = []
    for item in acts:
        roster = profiles.get(item['meeting'], {})
        if (session_group(item['meeting']) not in exposed and item['kind'] in ELICIT and item['addressees']
                and set(item['addressees']) <= set(roster) - {item['speaker']}
                and all(role in ROLES for role in roster.values()) and completed_turns(by_meeting[item['meeting']], item)):
            direct.append({'id': item['id'], 'group': session_group(item['meeting']), 'addresseeCount': len(set(item['addressees']))})
    inventory['freshExplicitElicitations'] = direct
    inventory['representationLimitations'] = [
        'Recorded personal display names are absent. Name fields use recorded anonymized speaker codes, not invented people.',
        'Role-specific named-entity tags can support an alias audit but are not supplied as privileged input features.',
        'History contains only acts completed before the source elicitation starts, merged by consecutive speaker and limited to last12 runs.',
        'A run may be the completed prefix of an ongoing speaker turn; no later same-speaker continuation is included.',
        'Current text is the elicitation act, not its future continuation; future responder text and annotation types never enter input.',
        'Gaze, prosody and gesture are unavailable. Spoken personal names may not resolve to the recorded speaker-code roster.',
        'This English scenario-meeting response proxy has no normative silence/all-reply/exclusion truth; unlinked people are not proven inappropriate.',
        'Mixed support, objection, uncertainty, partial support and elaboration all signify an observed linked response, not agreement.',
        'Links starting more than60 seconds after the source ends are excluded by a pre-fit validity rule.',
        'Current utterances with explicit group-response or silence language are quarantined for review, not relabeled as one.',
        'Public-corpus foundation-model pretraining overlap is unknown. Exposed phase1 teams are regression only.',
    ]
    inventory['uncertainRelationEvidence'] = UNCERTAIN_EVIDENCE
    partitions = partition_groups(fresh, exposed, args.seed)
    inventory['proposedSplitCounts'] = {split: {'groups': len(groups), 'rows': sum(row['group'] in groups for row in rows)} for split, groups in partitions.items()}
    output.mkdir(parents=True, mode=0o700)
    def write(name, value):
        path = output / name
        with path.open('x') as handle: handle.write(value)
        path.chmod(0o600)
        return sha(value.encode())
    write('inventory.json', json.dumps(inventory, ensure_ascii=False, indent=2))
    write('LICENCE.txt', license_text)
    manifest = {'version': 'ami-observed-response-v1', 'createdAt': datetime.now(timezone.utc).isoformat(),
                'status': 'frozen-before-fitting' if args.freeze else 'inventory-only-no-partitions-written',
                'seed': args.seed, 'archiveSha256': file_digest(args.archive), 'sourceUrl': SOURCE_URL,
                'license': 'CC-BY-4.0', 'licenseUrl': LICENSE_URL, 'licenseSha256': sha(license_text.encode()),
                'exposedInputSha256': sha(exposed_raw), 'excludedExposedTeams': sorted(exposed),
                'generatorSha256': file_digest(__file__), 'representation': 'ami-completed-speaker-runs-last12-v1',
                'maximumResponseDelaySeconds': MAX_LINK_DELAY_SECONDS,
                'uncertainRelationEvidence': UNCERTAIN_EVIDENCE,
                'languages': dict(Counter(row['language'] for row in rows)),
                'intentCompatibilityAudit': {'quarantinedRows': audit['intentQuarantinedRows'], 'flags': audit['intentQuarantineFlags'],
                                             'rule': 'conservative current-utterance flags; no compatible all/none labels invented'},
                'splitRule': 'stable seeded hash order of whole fresh teams; H10/C3/P3/remainderF; no model scores used',
                'counts': inventory['proposedSplitCounts'], 'limitations': inventory['representationLimitations']}
    if args.freeze:
        membership = {group: split for split, groups in partitions.items() for group in groups}
        manifest['groups'] = partitions; manifest['files'] = {}
        for split, groups in partitions.items():
            records = [{**row, 'split': membership[row['group']]} for row in rows if row['group'] in groups]
            text = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in records)
            manifest['files'][f'{split}.raw.jsonl'] = {'rows': len(records), 'sha256': write(f'{split}.raw.jsonl', text)}
    write('generator.py', Path(__file__).read_text())
    write('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({'status': manifest['status'], 'freshResponseRows': len(rows), 'freshResponseGroups': len(fresh),
                      'freshDirectElicitations': len(direct), 'splitCounts': manifest['counts']}))


def file_digest(path):
    with Path(path).open('rb') as handle: return hashlib.file_digest(handle, 'sha256').hexdigest()


if __name__ == '__main__': main()
