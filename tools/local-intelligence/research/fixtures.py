#!/usr/bin/env python3
"""High-effort authored coding snapshots with frozen executable checks, stored outside Git."""
import argparse
from concurrent.futures import ThreadPoolExecutor,as_completed
import json
import os
from pathlib import Path
import subprocess
import time
from generate import MODEL,EFFORT,S,obj,arr,sha

FILE=obj({'path':S,'content':S})
SCHEMA=obj({'cases':arr(obj({'title':S,'family':S,'language':{'type':'string','enum':['python','javascript']},
    'request':S,'context':S,'files':arr(FILE),'referenceFiles':arr(FILE),'tests':arr(FILE),
    'expectedDifficulty':{'type':'string','enum':['low','medium','high','xhigh']},'rationale':S}))})
DOMAINS=['format and validation','state transitions','cache and invalidation','asynchronous cancellation',
 'pagination and cursors','time intervals and scheduling','transaction rollback','graph and dependency resolution',
 'text parsing and escaping','multilingual text processing','event ordering and replay','data migrations',
 'permissions and scope','stream framing','merge and conflict handling','incremental computation',
 'numeric precision','tree transforms','configuration precedence','resource cleanup']

def generate(args,batch):
    folder=Path(args.root)/'outcomes'/'author'/f'{batch:04d}';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    if (folder/'complete.json').exists():return {'batch':batch,'state':'cached'}
    if (folder/'started.json').exists():return {'batch':batch,'state':'unsettled'}
    domain=DOMAINS[batch%len(DOMAINS)]
    prompt=f'''Create {args.count} original, distinct, SELF-CONTAINED coding repair snapshots in {domain}. Seed {batch}.
Do not use tools. Return JSON matching the schema. This corpus measures the NEXT coding response,
with exact same source and tests across low/medium/high/xhigh trials. Never claim these are real user tasks.
Use Python standard library or JavaScript ESM only; no external packages, network, system configuration,
shell commands, external filesystem access, subprocesses or unbounded loops. Keep each case under 250 total code lines.
files holds initially buggy implementation files under src/. referenceFiles holds a corrected version of those same paths.
tests holds deterministic unittest files under tests/test_*.py for Python, or node:test files tests/*.test.mjs for JS.
Python tests import modules as 'from src.module import ...'; JS tests import '../src/module.mjs'.
Each reference must pass ALL checks; each buggy version must fail at least one check. Check observable behavior,
not the spelling of the implementation. Use fake clocks/manual promises for asynchronous behavior, no sleeps.
Include normal, failure and meaningful boundary cases so a narrow hardcoded patch does not pass.
Vary complexity genuinely: one local repair, one interacting-state problem, one multi-component/algorithm problem
when count >=3. Do not simply swap constants or rename a previous task. Prefer 1–3 small source files.
The request is a natural Korean/English/Japanese coding request; mix languages across the cases.
context describes only observed pre-response evidence, never the correct implementation or future results.
The reference and tests will be hidden from the worker; request plus buggy files must fully specify intended behavior.
State every required observable rule explicitly, including error behavior and ordering where relevant.
Check EACH required rule independently: do not let another failing condition mask the condition under test.
If promise return type, object identity, no mutation, cancellation cleanup or incremental complexity is required,
include a check that distinguishes a plausible violation of that precise requirement. Otherwise do not require it.
Do not assert an exact order among equally valid independent operations unless the request specifies that order.
For overlapping parsing/matching rules test the stated precedence, not just non-overlapping examples.
family names the semantic bug family; related variants must use the same family. expectedDifficulty is only an
author hypothesis; actual level labels come later from repeated executions, not this hypothesis.
No credentials, private records, known benchmark copies or personal data.
'''
    (folder/'schema.json').write_text(json.dumps(SCHEMA));(folder/'prompt.txt').write_text(prompt)
    request={'model':MODEL,'effort':EFFORT,'batch':batch,'transport':args.transport,'promptHash':sha(prompt),'startedAt':time.time()}
    (folder/'started.json').write_text(json.dumps(request))
    cmd=['codex','exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','-s','read-only','-C',str(folder),
         '-m',MODEL,'-c',f'model_reasoning_effort="{EFFORT}"','--json','--output-schema',str(folder/'schema.json'),'-o',str(folder/'answer.json'),'-']
    if args.transport=='corral':
        cmd=[os.environ.get('CORRAL_RESEARCH_NODE','node'),str(Path(__file__).resolve().parents[3]/'tools/local-intelligence/research/subscription.ts'),
             str(folder/'prompt.txt'),str(folder/'schema.json'),str(folder/'answer.json'),EFFORT,'teacher']
    with (folder/'events.jsonl').open('w') as stdout,(folder/'stderr.log').open('w') as stderr:
        r=subprocess.run(cmd,input=prompt,text=True,stdout=stdout,stderr=stderr,timeout=1200)
    if r.returncode:return {'batch':batch,'state':'failed','exitCode':r.returncode}
    data=json.loads((folder/'answer.json').read_text());assert len(data['cases'])==args.count
    for i,c in enumerate(data['cases']):
        assert c['language'] in ['python','javascript']
        paths={f['path'] for f in c['files']}
        assert paths=={f['path'] for f in c['referenceFiles']} and len(paths)==len(c['files'])
        for f in c['files']+c['referenceFiles']:
            assert f['path'].startswith('src/') and '..' not in Path(f['path']).parts
        for f in c['tests']:assert f['path'].startswith('tests/') and '..' not in Path(f['path']).parts
        c.update({'id':f'outcome-{batch:04d}-{i:02d}','group':c['family'],'provenance':request})
    (folder/'cases.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
    (folder/'complete.json').write_text(json.dumps({**request,'completedAt':time.time(),'count':len(data['cases']),'answerHash':sha((folder/'answer.json').read_text())},indent=2))
    for p in folder.iterdir():
        if p.is_file():p.chmod(0o600)
    return {'batch':batch,'state':'complete','count':len(data['cases'])}

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--start',type=int,default=0)
    p.add_argument('--batches',type=int,default=10);p.add_argument('--count',type=int,default=3);p.add_argument('--workers',type=int,default=2)
    p.add_argument('--transport',choices=['codex','corral'],default='corral')
    args=p.parse_args()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        tasks=[pool.submit(generate,args,b) for b in range(args.start,args.start+args.batches)]
        for task in as_completed(tasks):
            try:print(json.dumps(task.result()),flush=True)
            except Exception as e:print(json.dumps({'state':'invalid','error':str(e)}),flush=True)

if __name__=='__main__':main()
