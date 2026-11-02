#!/usr/bin/env python3
"""Bounded high-author/blind-high-review realization of pre-frozen symbolic scenes."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import random
import re
import subprocess

from controlled_data import canonical, sha

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent
NODE = os.environ.get('CORRAL_RESEARCH_NODE', 'node')
LANGUAGES = ['ko', 'en', 'ja']
NAMES = {'ko': ['가람', '나린', '다온', '라온', '마루', '바다'],
         'en': ['Amber', 'Blair', 'Cedar', 'Drew', 'Ellis', 'Finley'],
         'ja': ['彩', '碧', '澪', '凛', '樹', '空']}


def now(): return datetime.now(timezone.utc).isoformat()


def write_once(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    raw = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n'
    with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as output:
        output.write(raw)
    return sha(raw.encode())


def author_payload(packet):
    scenes = []
    for index, state in enumerate(packet['states']):
        for language in LANGUAGES:
            scenes.append({'id': f's{index}-{language}', 'language': language,
                           'participants': state['participants'], 'events': state['events'],
                           'question': state['question']})
    return {'scenes': scenes}


def author_prompt(packet):
    return '''Realize six supplied meeting scenes as natural, concise conversation in the indicated language.
The English facts and question are the complete contract. Express EVERY factual value, negative fact,
identity reference, rule, and state transition explicitly. Preserve all numbers, lists, and logical
conditions. Do not invent additional facts, decisions, future replies, eligibility rules, promises,
or causes. You may smooth wording but must not omit facts or change the question's intended recipients.
Preserve participant names EXACTLY as provided, even in Korean and Japanese. Do not replace explicit
name references with pronouns: later deterministic renaming requires the supplied literal name.
Preserve turn IDs, speaker IDs, and turn order. A null speaker is the human facilitator.
Do not address named people in the current question; retain its relational descriptions. No @mentions.
Return only {"scenes":[{"id":...,"turns":[{"id":...,"speakerId":string or null,"text":...}],"message":...}]}.
Each input event becomes exactly one completed turn. Keep language natural and avoid commentary about
the dataset or task. Return no labels, explanations, hidden reasoning, or extra keys.\n''' + canonical(author_payload(packet))


AUTHOR_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['scenes'],
                 'properties': {'scenes': {'type': 'array', 'items': {
                     'type': 'object', 'additionalProperties': False, 'required': ['id', 'turns', 'message'],
                     'properties': {'id': {'type': 'string'}, 'message': {'type': 'string'},
                                    'turns': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
                                              'required': ['id', 'speakerId', 'text'],
                                              'properties': {'id': {'type': 'string'}, 'speakerId': {'type': ['string', 'null']},
                                                             'text': {'type': 'string'}}}}}}}}}


def validate_realization(packet, answer):
    expected = author_payload(packet)['scenes']
    if not isinstance(answer, dict) or set(answer) != {'scenes'} or len(answer['scenes']) != 6:
        raise ValueError('exactly six realized scenes required')
    if [scene.get('id') for scene in answer['scenes']] != [scene['id'] for scene in expected]:
        raise ValueError('scene/state/language order changed')
    for spec, scene in zip(expected, answer['scenes']):
        if set(scene) != {'id', 'turns', 'message'} or not isinstance(scene['message'], str) or not scene['message'].strip():
            raise ValueError('invalid current question')
        if '@' in scene['message']: raise ValueError('current @mention bypasses selector')
        if len(scene['turns']) != len(spec['events']) or len(scene['turns']) > 12:
            raise ValueError('event count or runtime history bound changed')
        ids = {p['id'] for p in spec['participants']}
        for event, turn in zip(spec['events'], scene['turns']):
            if (set(turn) != {'id', 'speakerId', 'text'} or turn['id'] != event['id']
                    or turn['speakerId'] != event['speakerId']
                    or turn['speakerId'] is not None and turn['speakerId'] not in ids
                    or not isinstance(turn['text'], str) or not turn['text'].strip()):
                raise ValueError('completed turn identity/speaker/content changed')
            for person in spec['participants']:
                if any(person['name'] in fact for fact in event['facts']) and person['name'] not in turn['text']:
                    raise ValueError('literal name reference omitted or translated')
    return True


def visible_scenes(packet, answer):
    validate_realization(packet, answer)
    specs = {scene['id']: scene for scene in author_payload(packet)['scenes']}
    return {'scenes': [{'id': scene['id'], 'input': {'participants': specs[scene['id']]['participants'],
                                                  'turns': scene['turns'], 'message': scene['message']}}
                       for scene in answer['scenes']]}


def review_prompt(packet, answer):
    # This payload intentionally has no source predicates, events, expected labels, or family name.
    exclusions = ('''For this corpus, eligibleIds/mode fully encode who may answer. excludedIds records
separately stated participant-specific exclusions currently active for this topic (for example an
explicit opt-out). Do not infer excludedIds from nonmembership in eligibleIds, from "only the
assignees/qualifying observers answer", or from an obligation being closed. none means eligibleIds=[]
and does not itself imply roster-wide excludedIds.''' if packet['split'] == 'final' else
'''excludedIds includes everyone explicitly prohibited by the current instruction/protocol, including
all nonqualifiers when the message says only qualifiers may answer, or all participants when it
says nobody may reply. Do not infer an exclusion merely from irrelevance or someone else's turn.''')
    return '''Independently label six visible meeting conversations. Use high reasoning.
Use only the participants, completed turns, and current user message provided below.
Determine exactly who is allowed and required to answer now. Do not predict model behavior.
Return only {"scenes":[{"id":...,"valid":true or false,"mode":"one|set|all|none",
"eligibleIds":[...],"excludedIds":[...],"issues":[short concrete evidence if invalid]}]}.
Modes: one means exactly one of the eligible alternatives may answer; set means every member
of a positively specified subset must answer; all means a direct everyone/whole-roster request,
possibly with explicit exclusions; none means nobody should answer. For set/all eligibleIds is
the exact required reply set. If an empty permitted set implies silence, use none and eligibleIds[].
''' + exclusions + '''
Mark valid=false when information is missing, contradictory, unnatural to the point of changing
meaning, or insufficient to identify the allowed set. Give short observable evidence, no hidden
reasoning. Do not use outside information. Evaluate all six scenes independently.\nVISIBLE_SCENES\n''' + canonical(visible_scenes(packet, answer))


def qualify_review(packet, answer):
    expected = {f's{i}-{language}': state['oracle']
                for i, state in enumerate(packet['states']) for language in LANGUAGES}
    rows = answer.get('scenes', []) if isinstance(answer, dict) else []
    if len(rows) != 6 or {row.get('id') for row in rows} != set(expected):
        return {'valid': False, 'issues': [{'kind': 'review-schema', 'detail': 'six unique independent labels required'}]}
    issues = []
    for row in rows:
        oracle = expected[row['id']]
        if row.get('valid') is not True:
            issues.append({'scene': row['id'], 'kind': 'semantic-invalid', 'detail': row.get('issues', [])})
        if row.get('mode') != oracle['mode']:
            issues.append({'scene': row['id'], 'kind': 'mode-mismatch'})
        for key in ('eligibleIds', 'excludedIds'):
            values = row.get(key)
            if not isinstance(values, list) or len(values) != len(set(values)) or set(values) != set(oracle[key]):
                issues.append({'scene': row['id'], 'kind': key + '-mismatch'})
    return {'valid': not issues, 'issues': issues, 'checkedScenes': 6}


def expand_family(packet, answer, seed=41, _nonce=0):
    validate_realization(packet, answer)
    scenes = {scene['id']: scene for scene in answer['scenes']}
    rows = []
    languages = ['ko'] * 12 + ['en'] * 5 + ['ja'] * 3
    for index, language in enumerate(languages):
        state_index = index % 2; state = packet['states'][state_index]
        scene = scenes[f's{state_index}-{language}']; rng = random.Random(f'{seed}:{packet["family"]}:{index}:{_nonce}')
        original = state['participants']; new_ids = [f'p{i + 1}' for i in range(len(original))]
        new_names = list(NAMES[language]); rng.shuffle(new_ids); rng.shuffle(new_names)
        id_map = {p['id']: new_ids[i] for i, p in enumerate(original)}
        name_map = {p['name']: new_names[i] for i, p in enumerate(original)}
        # Simultaneous substitution avoids cascading e.g. Ara -> Bori -> another name.
        pattern = re.compile('|'.join(re.escape(name) for name in sorted(name_map, key=len, reverse=True)))
        rename = lambda text: pattern.sub(lambda match: name_map[match.group()], text)
        participants = [{'id': id_map[p['id']], 'name': name_map[p['name']], 'role': rename(p.get('role', ''))} for p in original]
        rng.shuffle(participants)
        target = {key: copy.deepcopy(value) for key, value in state['oracle'].items()}
        for key in ('eligibleIds', 'excludedIds', 'requiredIds'):
            if key in target: target[key] = [id_map[pid] for pid in target[key]]
        rows.append({'id': f'{packet["family"]}-{language}-{index:02d}', 'group': packet['family'],
                     'task': 'meeting', 'language': language, 'split': packet['split'],
                     'inputVersion': 'judge-structured-v2',
                     'input': {'participants': participants,
                               'turns': [{**turn, 'speakerId': id_map.get(turn['speakerId']), 'text': rename(turn['text'])}
                                         for turn in scene['turns']], 'message': rename(scene['message'])},
                     'target': target,
                     'source': {'corpus': 'controlled normative rules v1', 'labelSource': 'mechanical symbolic interpreter',
                                'languageRealization': 'gpt-6.1-sol high subscription', 'independentVerifier': 'Hive high blind visible-only labels',
                                'stateIndex': state_index, 'baseSceneId': scene['id'], 'variant': index, 'expansionNonce': _nonce,
                                'idMap': id_map, 'nameMap': name_map, 'familyPacketSha256': sha(canonical(packet).encode())}})
    if len({canonical(row['input']) for row in rows}) != len(rows):
        if _nonce >= 100: raise ValueError('could not construct distinct name/order variants')
        return expand_family(packet, answer, seed, _nonce + 1)
    return rows


def known_terminal(answer, role):
    request_path = Path(str(answer) + '.request.json'); incomplete_path = Path(str(answer) + '.incomplete.json')
    if not request_path.exists() or not incomplete_path.exists(): return False
    request = json.loads(request_path.read_text()); incomplete = json.loads(incomplete_path.read_text())
    if request.get('effort') != 'high' or incomplete.get('effort') != 'high': return False
    keys = ('promptHash', 'schemaHash', 'model', 'provider') if role == 'author' else ('requestHash', 'model', 'transport')
    if any(not isinstance(request.get(key), str) or not request[key] or request[key] != incomplete.get(key) for key in keys):
        return False
    if role == 'author': return incomplete.get('completionKnown') is True and incomplete.get('stopReason') == 'length'
    budget = incomplete.get('maxCompletionTokens')
    return (type(budget) is int and budget > 0 and incomplete.get('finishReason') in ('stop', 'length')
            and incomplete.get('hasContent') is False and incomplete.get('usage', {}).get('completion_tokens') == budget)


def freeze_plan(root, holdout_manifest, holdout_packets):
    root = Path(root); static = json.loads((root / 'static-catalogue.freeze.json').read_text())
    packets = json.loads(Path(static['packetPath']).read_text())
    if sha(Path(static['packetPath']).read_bytes()) != static['packetSha256']: raise ValueError('static packet hash changed')
    if sha((HERE / 'controlled_data.py').read_bytes()) != static['sourceSha256']: raise ValueError('static source hash changed')
    final_packets = json.loads(Path(holdout_packets).read_text())
    if isinstance(final_packets, dict): final_packets = final_packets['packets']
    if len(final_packets) == 24 and all('states' not in packet for packet in final_packets):
        grouped = {}
        for state in final_packets:
            if state['split'] != 'final': raise ValueError('holdout state has nonfinal split')
            grouped.setdefault(state['family'], []).append(state)
        final_packets = [{'family': family, 'split': 'final', 'mechanism': family,
                          'states': sorted(states, key=lambda state: state['id'])}
                         for family, states in sorted(grouped.items())]
    if len(final_packets) != 12 or any(packet['split'] != 'final' for packet in final_packets):
        raise ValueError('twelve independent final families required')
    all_packets = packets + final_packets
    if len({packet['family'] for packet in all_packets}) != 44: raise ValueError('split family collision')
    if set(packet['mechanism'] for packet in packets) & set(packet['mechanism'] for packet in final_packets):
        raise ValueError('static/final mechanism collision')
    entries = []
    for packet in all_packets:
        payload = author_payload(packet)
        if len(payload['scenes']) != 6: raise ValueError('six scenes per family required')
        directory = root / ('holdout-packets' if packet['split'] == 'final' else 'fitting-packets')
        destination = directory / f'{packet["family"]}.json'
        packet_hash = write_once(destination, packet)
        entries.append({'family': packet['family'], 'split': packet['split'], 'packetPath': str(destination),
                        'packetSha256': packet_hash})
    source_paths = [HERE / name for name in ('controlled_data.py', 'controlled_generate.py', 'controlled_plan.md',
                                            'controlled_data_test.py', 'controlled_generate_test.py')]
    source_paths += [RESEARCH / 'subscription.ts', RESEARCH / 'hive.ts', RESEARCH / 'teacher-result.ts']
    plan = {'version': 'controlled-generation-v1', 'frozenAt': now(), 'seed': 41,
            'staticCatalogueSha256': sha((root / 'static-catalogue.freeze.json').read_bytes()),
            'holdoutManifestPath': str(holdout_manifest), 'holdoutManifestSha256': sha(Path(holdout_manifest).read_bytes()),
            'holdoutPacketsSha256': sha(Path(holdout_packets).read_bytes()),
            'maxInitialAuthorCalls': 44, 'maxInitialReviewCalls': 44, 'maxReplacementRealizations': 8,
            'author': {'model': 'gpt-6.1-sol', 'effort': 'high', 'transport': 'subscription.ts', 'maxTokens': 32768, 'timeoutSeconds': 300},
            'reviewer': {'effort': 'high', 'transport': 'hive.ts', 'maxTokens': 65536, 'timeoutSeconds': 600},
            'independentReviewInput': 'six visible scenes only; no symbolic facts or oracle targets',
            'exclusionAnnotation': {'static': 'explicit positive qualifier complement/silence prohibitions included',
                                    'final': 'separately stated active participant-specific exclusions; eligibility still fully binds dispatch'},
            'unknownCallRetry': False, 'sources': {str(path): sha(path.read_bytes()) for path in source_paths},
            'families': entries}
    for path in source_paths: write_once(root / 'source-snapshot' / path.name, path.read_text())
    write_once(root / 'generation-plan.json', plan)
    return plan


def invoke(command, log_path, timeout):
    with Path(log_path).open('x') as log:
        Path(log_path).chmod(0o600)
        try:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            return result.returncode
        except subprocess.TimeoutExpired: return 'outer-timeout-unknown'


def run_family(root, plan, entry, config, attempt='initial'):
    family = entry['family']; root = Path(root)
    if attempt != 'initial' and not re.fullmatch(r'replacement-[1-8]', attempt):
        raise ValueError('invalid attempt name')
    directory = root / ('holdout-attempts' if entry['split'] == 'final' else 'fitting-attempts') / family / attempt
    if attempt != 'initial':
        declaration = json.loads((root / 'replacements' / f'{attempt}.json').read_text())
        if declaration['family'] != family or declaration['packetSha256'] != entry['packetSha256']:
            raise ValueError('replacement declaration does not bind this frozen family')
    status_path = directory / 'status.json'
    if status_path.exists(): return json.loads(status_path.read_text())
    if (directory / 'started.json').exists():
        return {'family': family, 'split': entry['split'], 'state': 'unsettled-no-replay'}
    packet_path = Path(entry['packetPath'])
    if sha(packet_path.read_bytes()) != entry['packetSha256']: raise ValueError('frozen packet changed')
    packet = json.loads(packet_path.read_text()); directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_once(directory / 'started.json', {'startedAt': now(), 'family': family,
               'planSha256': sha((root / 'generation-plan.json').read_bytes()), 'packetSha256': entry['packetSha256']})
    status = {'family': family, 'split': entry['split'], 'attempt': attempt,
              'state': 'unknown', 'authorCalls': 0, 'reviewCalls': 0}
    try:
        author_prompt_path = directory / 'author.prompt.txt'; schema_path = directory / 'author.schema.json'
        author_answer = directory / 'author.answer.json'
        prompt = author_prompt(packet)
        if attempt != 'initial':
            prompt += ('\nThis is a separately declared replacement realization. Keep the exact supplied facts and question, '
                       'but use short, explicit sentences and no elaboration. Previous quality/terminal issue: ' + declaration['reason'])
        write_once(author_prompt_path, prompt); write_once(schema_path, AUTHOR_SCHEMA)
        status['authorCalls'] = 1
        code = invoke([NODE, str(RESEARCH / 'subscription.ts'), str(author_prompt_path), str(schema_path),
                       str(author_answer), 'high', 'teacher'], directory / 'author.transport.log', 360)
        if code != 0:
            status.update(state='author-known-terminal' if known_terminal(author_answer, 'author') else 'author-unknown', exitCode=code)
        else:
            author_receipt = json.loads(Path(str(author_answer) + '.receipt.json').read_text())
            if (author_receipt['effort'] != 'high' or author_receipt['wire']['value'] != 'high'
                    or author_receipt['provider'] != 'openai-codex' or author_receipt['model'] != 'gpt-6.1-sol'):
                raise ValueError('author effort/transport receipt invalid')
            answer = json.loads(author_answer.read_text()); validate_realization(packet, answer)
            review_prompt_path = directory / 'review.prompt.txt'; review_answer = directory / 'review.answer.json'
            write_once(review_prompt_path, review_prompt(packet, answer)); status['reviewCalls'] = 1
            code = invoke([NODE, str(RESEARCH / 'hive.ts'), config, str(review_prompt_path), str(review_answer),
                           '65536', '600'], directory / 'review.transport.log', 720)
            if code != 0:
                status.update(state='review-known-terminal' if known_terminal(review_answer, 'reviewer') else 'review-unknown', exitCode=code)
            else:
                receipt = json.loads(Path(str(review_answer) + '.receipt.json').read_text())
                if receipt['effort'] != 'high': raise ValueError('review effort receipt invalid')
                qualification = qualify_review(packet, json.loads(review_answer.read_text()))
                write_once(directory / 'qualification.json', qualification)
                status.update(state='qualified' if qualification['valid'] else 'rejected', checkedScenes=6,
                              qualificationSha256=sha((directory / 'qualification.json').read_bytes()))
                if qualification['valid']:
                    rows = expand_family(packet, answer)
                    target = root / ('sealed-final' if packet['split'] == 'final' else packet['split']) / f'{family}.jsonl'
                    rows_hash = write_once(target, ''.join(canonical(row) + '\n' for row in rows))
                    status.update(rows=20, rowsPath=str(target), rowsSha256=rows_hash)
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        status.update(state='structural-invalid', errorType=type(error).__name__)
    status['completedAt'] = now()
    status['artifacts'] = {path.name: sha(path.read_bytes()) for path in sorted(directory.iterdir()) if path.is_file()}
    write_once(status_path, status)
    return status


def declare_replacement(root, plan, family, prior_attempt, reason):
    # Exclusive numbered declarations enforce a shared global eight-attempt ceiling.
    root = Path(root)
    entry = next(item for item in plan['families'] if item['family'] == family)
    if not reason.strip(): raise ValueError('concrete replacement reason required')
    prior = root / ('holdout-attempts' if entry['split'] == 'final' else 'fitting-attempts') / family / prior_attempt
    status = json.loads((prior / 'status.json').read_text())
    if status['state'] not in {'rejected', 'structural-invalid', 'author-known-terminal', 'review-known-terminal'}:
        raise ValueError('unknown, qualified, or unsettled calls cannot be replaced')
    if status['state'] == 'author-known-terminal' and not known_terminal(prior / 'author.answer.json', 'author'):
        raise ValueError('author terminal proof missing')
    if status['state'] == 'review-known-terminal' and not known_terminal(prior / 'review.answer.json', 'reviewer'):
        raise ValueError('review terminal proof missing')
    if status['state'] in {'rejected', 'structural-invalid'}:
        if not Path(str(prior / 'author.answer.json') + '.receipt.json').exists():
            raise ValueError('completed author proof missing')
        if status['reviewCalls'] and not Path(str(prior / 'review.answer.json') + '.receipt.json').exists():
            raise ValueError('completed review proof missing')
    existing = list((root / 'replacements').glob('replacement-*.json'))
    if any((saved := json.loads(path.read_text()))['family'] == family
           and saved['priorStatusSha256'] == sha((prior / 'status.json').read_bytes()) for path in existing):
        raise ValueError('prior attempt already has a declared replacement')
    for number in range(1, 9):
        attempt = f'replacement-{number}'
        declaration = {'declaredAt': now(), 'family': family, 'attempt': attempt, 'priorAttempt': prior_attempt,
                       'priorStatusSha256': sha((prior / 'status.json').read_bytes()), 'reason': reason,
                       'packetSha256': entry['packetSha256'], 'maximumAdditionalAuthorCalls': 1,
                       'maximumAdditionalReviewCalls': 1, 'symbolicStateChanged': False,
                       'unknownCallsRetried': False, 'modelOutcomesUsed': False}
        try:
            write_once(root / 'replacements' / f'{attempt}.json', declaration)
            return entry, attempt
        except FileExistsError: continue
    raise ValueError('eight declared replacement realizations exhausted')


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('command', choices=['freeze', 'run', 'summary', 'replace'])
    parser.add_argument('--root', required=True); parser.add_argument('--holdout-manifest'); parser.add_argument('--holdout-packets')
    parser.add_argument('--config'); parser.add_argument('--split', choices=['fit', 'calibration', 'policy', 'final'])
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--family'); parser.add_argument('--prior-attempt', default='initial'); parser.add_argument('--reason')
    args = parser.parse_args(); root = Path(args.root)
    if args.command == 'freeze':
        plan = freeze_plan(root, args.holdout_manifest, args.holdout_packets)
        print(json.dumps({'families': len(plan['families']), 'planSha256': sha((root / 'generation-plan.json').read_bytes())})); return
    plan = json.loads((root / 'generation-plan.json').read_text())
    if args.command in {'run', 'replace'}:
        if not args.config or not 1 <= args.workers <= 3: raise ValueError('config and 1..3 workers required')
        for path, expected_hash in plan['sources'].items():
            if sha(Path(path).read_bytes()) != expected_hash: raise ValueError('frozen generation source changed')
        if args.command == 'replace':
            if not args.family or not args.reason: raise ValueError('family and reason required')
            entry, attempt = declare_replacement(root, plan, args.family, args.prior_attempt, args.reason)
            result = run_family(root, plan, entry, args.config, attempt)
            print(json.dumps({'settled': 1, 'states': {result['state']: 1}, 'familyHash': sha(args.family.encode())[:16]})); return
        if not args.split: raise ValueError('explicit split required')
        entries = [entry for entry in plan['families'] if entry['split'] == args.split]
        counts = Counter()
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(run_family, root, plan, entry, args.config) for entry in entries]
            for future in as_completed(futures):
                result = future.result(); counts[result['state']] += 1
                print(json.dumps({'settled': sum(counts.values()), 'states': dict(counts),
                                  'familyHash': sha(result['family'].encode())[:16]}), flush=True)
    else:
        statuses = [json.loads(path.read_text()) for area in ('fitting-attempts', 'holdout-attempts')
                    for path in (root / area).glob('*/*/status.json')]
        print(json.dumps({'settledFamilies': len(statuses), 'states': dict(Counter(s['state'] for s in statuses)),
                          'qualifiedRows': sum(s.get('rows', 0) for s in statuses),
                          'authorCalls': sum(s['authorCalls'] for s in statuses), 'reviewCalls': sum(s['reviewCalls'] for s in statuses)}))


if __name__ == '__main__': main()
