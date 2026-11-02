#!/usr/bin/env python3
"""Replay an immutable GGUF candidate, recording actual token-budget and latency evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import runpy
import time
from transformers import AutoTokenizer
from sft import format_case
from native_views import restore_recipients

def main():
    p=argparse.ArgumentParser();p.add_argument('--helper',required=True);p.add_argument('--model',required=True);p.add_argument('--tokenizer',required=True)
    p.add_argument('--input',required=True);p.add_argument('--out',required=True);p.add_argument('--backend',choices=['cpu','gpu'],default='cpu')
    p.add_argument('--tokens',type=int,default=1024);p.add_argument('--context-tokens',type=int,default=2048);p.add_argument('--threads',type=int,default=6);p.add_argument('--unseal-final',action='store_true')
    a=p.parse_args();out=Path(a.out)
    if out.exists():raise ValueError('native predictions exist')
    rows=[json.loads(s) for s in Path(a.input).read_text().splitlines()]
    if any(r['split']=='final' for r in rows) and not a.unseal_final:raise ValueError('final remains sealed')
    sourcehash=hashlib.sha256(Path(a.input).read_bytes()).hexdigest();modelhash=hashlib.file_digest(open(a.model,'rb'),'sha256').hexdigest()
    if a.unseal_final:out.with_suffix(out.suffix+'.exposure.json').write_text(json.dumps({'at':time.time(),'modelSha256':modelhash,'sourceSha256':sourcehash}))
    fingerprint=runpy.run_path(str(Path(__file__).with_name('gguf-helper')/'token_fingerprint.py'))['input_token_fingerprint']
    helper=Path(a.helper).resolve();model=Path(a.model).resolve()
    tok=AutoTokenizer.from_pretrained(a.tokenizer,local_files_only=True);cmd=[str(helper),str(model),str(a.threads),str(a.context_tokens),'--backend',a.backend]
    env={key:os.environ[key] for key in ['PATH','HOME','XDG_CACHE_HOME','TMPDIR'] if key in os.environ}
    env['LD_LIBRARY_PATH']=str(helper.parent)
    log=out.with_suffix(out.suffix+'.stderr.log').open('w');proc=subprocess.Popen(cmd,cwd=helper.parent,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,bufsize=1)
    sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ)
    def receive(timeout=60):
        if not sel.select(timeout):raise TimeoutError('native helper response deadline')
        line=proc.stdout.readline()
        if not line:raise RuntimeError('native helper exited')
        return json.loads(line)
    report={'modelSha256':modelhash,'inputSha256':sourcehash,
        'helperSha256':hashlib.file_digest(open(a.helper,'rb'),'sha256').hexdigest(),
        'tokenizerSha256':hashlib.file_digest(open(Path(a.tokenizer)/'tokenizer.json','rb'),'sha256').hexdigest(),
        'normalizer':str(tok.backend_tokenizer.normalizer),'backend':a.backend,'contextTokens':a.context_tokens,'inputBudget':a.tokens,'predictions':[],'warmup':[]}
    nextid=0
    def call(payload):
        nonlocal nextid
        nextid+=1;start=time.monotonic();proc.stdin.write(json.dumps({'id':nextid,**payload},ensure_ascii=False)+'\n');proc.stdin.flush();answer=receive()
        if answer.get('id')!=nextid:raise ValueError('native response ID mismatch')
        return answer,time.monotonic()-start
    try:
        start=time.monotonic();report['ready']=receive();report['loadSeconds']=time.monotonic()-start
        # Deterministic non-sensitive prefill + multi-recipient decode warmups.
        warmups=[(60,'effort'),(129,'meeting'),(354,'meeting'),(min(1024,a.tokens),'meeting')]
        if a.tokens>1024:warmups.append((a.tokens,'effort'))
        for length,task in warmups:
            prefix='Background notes: ' if task=='effort' else 'Participants: p1, p2, p3, p4, p5, p6. Background notes: '
            suffix='\nCurrent request: fix a typo.' if task=='effort' else '\nCurrent user message: Everyone must reply. Return p1,p2,p3,p4,p5,p6.'
            count=0;prompt=format_case({'task':task,'text':prefix+suffix},tok)
            while True:
                candidate=format_case({'task':task,'text':prefix+'note '*(count+1)+suffix},tok)
                if len(tok.encode(candidate,add_special_tokens=False))>length:break
                count+=1;prompt=candidate
            answer,seconds=call({'op':task,'prompt':prompt,'participantIds':['p1','p2','p3','p4','p5','p6']})
            report['warmup'].append({'task':task,'requestedLength':length,'actualLength':len(tok.encode(prompt,add_special_tokens=False)),'seconds':seconds,'resultType':answer.get('type')})
            if answer.get('type')!='result':raise ValueError('deterministic native warmup failed')
        for row in rows:
            view=row.get('runtimeView')
            payload={'op':row['task'],'prompt':view['prompt'] if view else format_case(row,tok),'inputBudget':a.tokens}
            if row['task']=='meeting':payload['participantIds']=view['participantIds'] if view else [x['id'] for x in row['input']['participants']]
            result,seconds=call(payload)
            if result.get('type')=='result':
                ids=tok.encode(payload['prompt'],add_special_tokens=False)
                used=ids if len(ids)<=a.tokens else ids[:128]+ids[-(a.tokens-128):]
                if (result.get('inputTokenFingerprint')!=fingerprint(used) or result.get('originalPromptTokens')!=len(ids)
                        or result.get('usedPromptTokens')!=len(used)):
                    raise ValueError('native/HF input token parity mismatch')
            result=restore_recipients(row,result)
            report['predictions'].append({'id':row['id'],'group':row['group'],'task':row['task'],'result':result,'seconds':seconds,
                'deadlineMiss':seconds>(3 if row['task']=='effort' else 1.5)})
            out.write_text(json.dumps(report,indent=2));out.chmod(0o600)
        proc.stdin.close();proc.wait(timeout=15);report['complete']=True;out.write_text(json.dumps(report,indent=2))
        print(json.dumps({'count':len(rows),'backend':a.backend,'deadlineMisses':sum(x['deadlineMiss'] for x in report['predictions'])}))
    finally:
        if proc.poll() is None:proc.kill();proc.wait()
        sel.close();log.close()

if __name__=='__main__':main()
