#!/usr/bin/env python3
"""Complete malformed review envelopes, preserving every original attempt and judgment."""
import argparse
from concurrent.futures import ThreadPoolExecutor,as_completed
import json
import os
from pathlib import Path
import subprocess
import time
from generate import split,validate
from verify import label_prompt

def checked(path,cases):
    if not path.exists() or not Path(str(path)+'.receipt.json').exists():return None
    try:
        labels=json.loads(path.read_text())['labels'];expected={c['id']:c for c in cases}
        if len(labels)!=len(cases) or {l['id'] for l in labels}!=set(expected):return None
        for label in labels:
            case=expected[label['id']]
            if case['task'] in label['target']:label['target']=label['target'][case['task']]
            validate(case['task'],{**case,'target':label['target']})
            if not isinstance(label.get('clear'),bool):return None
        receipt=json.loads(Path(str(path)+'.receipt.json').read_text())
        if receipt['effort']!='high':raise ValueError('non-high review')
        return labels,receipt
    except (ValueError,KeyError,AssertionError,TypeError):return None

def repair(args,job):
    root=Path(args.root);folder=root/'verifier'/job;cases=[json.loads(x) for x in (root/'teacher'/job/'cases.jsonl').read_text().splitlines()]
    repaired=folder/'validated-high-v3';repaired.mkdir(exist_ok=True,mode=0o700);labels=[];receipts=[]
    for at in range(0,len(cases),2):
        chunk=cases[at:at+2];old=folder/'bounded-high-v2'/f'{at:02d}.json';new=repaired/f'{at:02d}.json'
        selected=checked(old,chunk) or checked(new,chunk)
        if selected is None:
            if Path(str(new)+'.request.json').exists():return {'job':job,'state':'repair-unsettled','chunk':at}
            old_prompt=old.parent/f'{at:02d}.prompt.txt';log=old.parent/f'{at:02d}.transport.log'
            timed_out=not old.exists() and log.exists() and 'TimeoutError' in log.read_text()
            if Path(str(old)+'.request.json').exists() and not old.exists() and not timed_out:
                return {'job':job,'state':'unresolved-original','chunk':at}
            if timed_out:
                # This is a bounded recovery of a read-only, user-authorized free
                # annotation request, keeping its SAME canonical request identity.
                prompt=old_prompt.read_text();reason='same-request-hash after recorded local timeout; original provider completion remains unknown'
            else:
                shape={'id':'copy exact ID','clear':True,'target':{'level':'low|medium|high|xhigh','acceptableLevels':['include chosen level'],'evidence':'short observable evidence'}} if chunk[0]['task']=='effort' else {'id':'copy exact ID','clear':True,'target':{'mode':'one|set|all|none','eligibleIds':[],'excludedIds':[],'evidenceTurnIds':[],'evidence':'short observable evidence'}}
                prompt=label_prompt(chunk)+'\nStrict output envelope: '+json.dumps({'labels':[shape]})+'\nReturn one entry per supplied ID. clear is REQUIRED next to id and target. Use false if ambiguous. Return only the requested task, not both tasks.\n'
                reason='known malformed completed envelope' if old.exists() else 'previously unattempted chunk'
            promptpath=repaired/f'{at:02d}.prompt.txt';promptpath.write_text(prompt)
            (repaired/f'{at:02d}.recovery.json').write_text(json.dumps({'reason':reason,'originalRequestHash':json.loads(Path(str(old)+'.request.json').read_text())['requestHash'] if Path(str(old)+'.request.json').exists() else None},indent=2))
            command=[os.environ.get('CORRAL_RESEARCH_NODE','node'),str(Path(__file__).with_name('hive.ts')),args.config,str(promptpath),str(new)]
            with (repaired/f'{at:02d}.transport.log').open('w') as output:
                result=subprocess.run(command,stdout=output,stderr=subprocess.STDOUT,timeout=360)
            selected=checked(new,chunk)
            if result.returncode or selected is None:return {'job':job,'state':'repair-invalid','chunk':at}
            if timed_out:
                original=json.loads(Path(str(old)+'.request.json').read_text())
                if selected[1]['requestHash']!=original['requestHash']:raise ValueError('timeout recovery changed request identity')
        chosen,receipt=selected;labels.extend(chosen);receipts.append(receipt)
    (folder/'labels.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in labels))
    receipt={'count':len(labels),'clear':sum(x['clear'] for x in labels),'model':receipts[0]['model'],'effort':'high','requestHashes':[x['requestHash'] for x in receipts],
        'completedAt':time.time(),'repair':'validated-high-v3; original attempts retained'}
    (folder/'receipt.json').write_text(json.dumps(receipt,indent=2))
    for f in folder.rglob('*'):
        if f.is_file():f.chmod(0o600)
    return {'job':job,'state':'complete','count':len(labels)}

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--config',required=True);p.add_argument('--workers',type=int,default=3);a=p.parse_args();jobs=[]
    for source in (Path(a.root)/'teacher').glob('*/receipt.json'):
        r=json.loads(source.read_text());part=split(f"{r['task']}-scene-family-{r['batch']:04d}")
        if r['batch']<30 or part!='fit' or r['batch']%5==0:
            if not (Path(a.root)/'verifier'/source.parent.name/'receipt.json').exists():jobs.append((part=='fit',source.parent.name))
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        futures=[pool.submit(repair,a,job) for _,job in sorted(jobs)]
        for f in as_completed(futures):
            try:print(json.dumps(f.result()),flush=True)
            except Exception as e:print(json.dumps({'state':'invalid','error':str(e)}),flush=True)

if __name__=='__main__':main()
