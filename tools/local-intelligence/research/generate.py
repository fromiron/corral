#!/usr/bin/env python3
"""Explicit GPT high synthetic curriculum generation. Private outputs; no training/eval here."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time

MODEL = 'gpt-6.1-sol'
EFFORT = 'high'
VERSION = 'judge-research-v3'
MEETING_DOMAINS = [
    'weekend plans among friends', 'birthday and surprise planning', 'cooking and recipe exchange',
    'travel routes and constraints', 'book club disagreement', 'film and music recommendations',
    'community event ideas', 'moving and household coordination', 'fitness and hobby experiences',
    'learning a language together', 'product brainstorm', 'customer interview interpretation',
    'root causes of an event turnout decline', 'choosing between competing design ideas',
    'school group project planning', 'game night and rules clarification', 'garden care observations',
    'volunteer coordination', 'creative writing workshop', 'small business process improvement',
    'sports club scheduling', 'photography critique', 'household budget discussion',
    'organizing a shared trip album', 'comparing personal experiences', 'resolving a misunderstanding',
    'software debugging discussion', 'software feature planning', 'code review discussion',
    'engineering incident hypotheses',
]
EFFORT_DOMAINS = [
    'small UI copy and style changes', 'single function bugs', 'test failures and follow-up reports',
    'TypeScript type errors', 'API contract changes', 'SQL queries and migrations',
    'authentication boundaries', 'concurrent event ordering', 'cache invalidation',
    'network and retry diagnosis', 'build and dependency failures', 'cross-platform packaging',
    'editor state synchronization', 'refactoring with compatibility', 'performance profiling',
    'accessibility fixes', 'data import and validation', 'cancellation and cleanup',
    'search and filtering behavior', 'date and time handling', 'multilingual text handling',
    'repository navigation and explanation', 'algorithm design', 'distributed persistence',
    'tests already passed: summarize results', 'insufficient information: ask a short question',
    'long log contains one decisive error', 'long request ends in a narrow correction',
    'large assignment but next step is trivial', 'short request but prior context demands deep analysis',
]

def obj(properties):
    return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}

def arr(items):
    return {'type': 'array', 'items': items}

S = {'type': 'string'}
LEVEL = {'type': 'string', 'enum': ['low', 'medium', 'high', 'xhigh']}
EFFORT_SCHEMA = obj({
    'language': {'type': 'string', 'enum': ['ko', 'en', 'ja']},
    'input': obj({'goal': S, 'request': S, 'previousRequest': S, 'previousReply': S,
                  'stage': {'type': 'string', 'enum': ['turn', 'step']}, 'plan': S,
                  'tools': arr(obj({'name': S, 'args': S, 'status': {'type': 'string', 'enum': ['success', 'error', 'unknown']}, 'content': S}))}),
    'target': obj({'level': LEVEL, 'acceptableLevels': arr(LEVEL), 'evidence': S}),
})
MEETING_SCHEMA = obj({
    'language': {'type': 'string', 'enum': ['ko', 'en', 'ja']},
    'input': obj({'participants': arr(obj({'id': S, 'name': S, 'role': S})),
                  'turns': arr(obj({'id': S, 'speakerId': {'type': ['string', 'null']}, 'text': S, 'replyTo': S})), 'message': S}),
    'target': obj({'mode': {'type': 'string', 'enum': ['one', 'set', 'all', 'none']},
                   'eligibleIds': arr(S), 'excludedIds': arr(S), 'evidenceTurnIds': arr(S), 'evidence': S}),
})

def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()

def split(group):
    u = int(sha(f'{VERSION}:{group}')[:8], 16) / 2**32
    return 'fit' if u < .7 else 'calibration' if u < .8 else 'policy' if u < .9 else 'final'

def validate(task, case):
    assert case['language'] in ['ko', 'en', 'ja']
    x, y = case['input'], case['target']
    assert y['evidence'].strip()
    if task == 'effort':
        assert x['request'].strip() and x['stage'] in ['turn', 'step']
        assert y['level'] in ['low', 'medium', 'high', 'xhigh']
        assert y['level'] in y['acceptableLevels']
        if x['stage'] == 'step': assert x['tools']
    else:
        ids = [p['id'] for p in x['participants']]
        assert 2 <= len(ids) <= 6 and len(set(ids)) == len(ids)
        assert 4 <= len(x['turns']) <= 40 and x['message'].strip()
        assert all(t['speakerId'] is None or t['speakerId'] in ids for t in x['turns'])
        turns = [t['id'] for t in x['turns']]
        assert len(set(turns)) == len(turns)
        assert all(t in turns for t in y['evidenceTurnIds'])
        eligible, excluded = set(y['eligibleIds']), set(y['excludedIds'])
        assert eligible <= set(ids) and excluded <= set(ids) and not eligible & excluded
        assert y['mode'] in ['one', 'set', 'all', 'none']
        assert bool(eligible) == (y['mode'] != 'none')
        if y['mode'] == 'all': assert eligible == set(ids) - excluded

def prompt(task, batch, count):
    domain = (MEETING_DOMAINS if task == 'meeting' else EFFORT_DOMAINS)[batch % 30]
    common = f'''You are authoring an ORIGINAL multilingual training/evaluation corpus for Corral.
Do not use tools or read files. Return only JSON matching the supplied schema: {{"cases":[...]}}.
Create exactly {count} distinct scenes in the domain: {domain}. Batch variation seed: {batch}.
Use Korean for 60%, English for 25%, Japanese for 15% (round across this batch).
Use natural informal and formal dialogue, realistic details, and different phrasing in every scene.
Do not mention benchmarks, labels, classifiers, or your generation instructions inside the scene.
Give a short observable evidence justification, never chain-of-thought. Do not copy famous benchmarks.
This is synthetic material. Never claim it is real user data.
'''
    if task == 'meeting':
        return common + '''Each scene has 2–6 participants and 4–12 prior turns, followed by one current USER message.
Participants have arbitrary personal display names, not AI model brands; optional roles can be empty.
speakerId=null means the user. IDs p1...p6 and t1... are local to each scene. replyTo is empty unless explicit.
Goal: determine who SHOULD answer the current message, not merely who is topically similar or who spoke last.
Cover: natural name address without @, response to an earlier NON-LAST proposal, agreement/disagreement,
quoted names versus actual address, 'any one of you', multiple requested views, all, explicit exclusion,
explicit no-response, new topic, and an ambiguous invitation where several people are equally acceptable.
Mix the situations naturally; don't repeat a stock 'please explain' template. Do not always select the last speaker.
mode=one: any ONE eligible participant is valid; list ALL valid alternatives in eligibleIds.
mode=set: eligibleIds is the exact requested set. mode=all: every non-excluded participant.
mode=none: explicit silence/stop, eligibleIds empty. Uncertainty is NOT none.
excludedIds names only explicitly excluded participants, not everyone irrelevant.
evidenceTurnIds points to prior turns needed for the choice; can be empty for current-message-only decisions.
Include at least one none, one all, one multi-person set and two one cases when count >= 6.
'''
    return common + '''Each case is the state BEFORE the NEXT coding assistant response.
Separate the overall goal from the latest user request and already observed tool results.
Half the scenes are turns; half are steps with tools. Tools include status and a short realistic excerpt.
Rate minimum useful reasoning for the NEXT response, not total project size, patch length or previous work.
low: direct lookup/edit/report or routine step with decisive evidence.
medium: a few connected reasoning steps or a localized diagnosis/change.
high: competing explanations, multi-component dependencies or a tricky correctness boundary.
xhigh: substantial algorithmic/architectural exploration or difficult interacting constraints.
Use every class, including low next responses inside complex projects and high/xhigh short follow-ups.
Some requests rely on previous context; some logs have a decisive failure in their middle.
Do not make every error high or every successful tool result low. No source/style-to-label shortcut.
acceptableLevels contains the narrow genuinely defensible range including level; don't mark all four acceptable.
'''

def job(args, task, batch):
    root = Path(args.out) / 'teacher' / f'{task}-{batch:04d}'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt = root / 'receipt.json'
    if receipt.exists(): return {'job': root.name, 'state': 'cached'}
    if (root / 'started.json').exists():
        return {'job': root.name, 'state': 'unsettled', 'reason': 'prior attempt must be inspected before retry'}
    schema = obj({'cases': arr(MEETING_SCHEMA if task == 'meeting' else EFFORT_SCHEMA)})
    (root / 'schema.json').write_text(json.dumps(schema))
    text = prompt(task, batch, args.count)
    (root / 'prompt.txt').write_text(text)
    requested = {'model': MODEL, 'effort': EFFORT, 'task': task, 'batch': batch,
                 'promptSha256': sha(text), 'startedAt': time.time(), 'schemaSha256': sha(json.dumps(schema))}
    (root / 'started.json').write_text(json.dumps(requested))
    argv = ['codex', 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
            '-s', 'read-only', '-C', str(root), '-m', MODEL, '-c', f'model_reasoning_effort="{EFFORT}"',
            '--json', '--output-schema', str(root / 'schema.json'), '-o', str(root / 'answer.json'), '-']
    with (root / 'events.jsonl').open('w') as stdout, (root / 'stderr.log').open('w') as stderr:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                                text=True, start_new_session=True)
        try: proc.communicate(text, timeout=900)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=30)
            return {'job': root.name, 'state': 'timeout'}
    if proc.returncode: return {'job': root.name, 'state': 'failed', 'exitCode': proc.returncode}
    answer = json.loads((root / 'answer.json').read_text())
    cases = answer['cases']
    assert len(cases) == args.count, f'{root.name}: wrong case count'
    group = f'{task}-scene-family-{batch:04d}'
    output = []
    for i, case in enumerate(cases):
        validate(task, case)
        output.append({'id': f'{group}-{i:02d}', 'group': group, 'split': split(group), 'task': task,
                       **case, 'provenance': {'kind': 'synthetic', 'model': MODEL, 'effort': EFFORT,
                                            'promptSha256': sha(text)}})
    (root / 'cases.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in output))
    receipt.write_text(json.dumps({**requested, 'completedAt': time.time(), 'count': len(output),
                                   'answerSha256': sha((root / 'answer.json').read_text())}, indent=2))
    for p in root.iterdir():
        if p.is_file():p.chmod(0o600)
    return {'job': root.name, 'state': 'complete', 'count': len(output), 'split': split(group)}

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out', required=True)
    p.add_argument('--tasks', nargs='+', choices=['effort', 'meeting'], default=['effort', 'meeting'])
    p.add_argument('--start', type=int, default=0)
    p.add_argument('--batches', type=int, default=30)
    p.add_argument('--count', type=int, default=10)
    p.add_argument('--workers', type=int, default=2)
    args = p.parse_args()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = [pool.submit(job, args, task, batch) for batch in range(args.start, args.start + args.batches) for task in args.tasks]
        for future in concurrent.futures.as_completed(jobs):
            try: print(json.dumps(future.result()), flush=True)
            except Exception as e: print(json.dumps({'state': 'invalid', 'error': str(e)}), flush=True)

if __name__ == '__main__':main()
