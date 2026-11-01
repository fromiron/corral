#!/usr/bin/env python3
"""Sequential GPU pilot matrix; freezes source and data, records failures without hiding them."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time

def matrix():
    jobs=[]
    def add(task,family,tune,representation,tokens=1024,lr=1e-5,width=64,objective='ce'):
        name=f'{task}-{family}-{tune}-{representation}-{tokens}-lr{lr}-w{width}-{objective}'
        jobs.append({'name':name,'task':task,'family':family,'tune':tune,'representation':representation,
                     'tokens':tokens,'lr':lr,'width':width,'objective':objective})
    for width in [0,32,64]:add('effort','embeddinggemma2','frozen','legacy',256,width=width)
    for tokens in [512,1024]:
        add('effort','embeddinggemma2','frozen','structured',tokens)
        for lr in [1e-5,3e-5]:add('effort','embeddinggemma2','full','structured',tokens,lr)
        for tune in ['frozen','full']:add('meeting','embeddinggemma2',tune,'joint',tokens)
    add('effort','embeddinggemma2','lora','structured')
    add('effort','embeddinggemma2','full','structured',objective='ordinal')
    for tune in ['frozen','full']:add('meeting','embeddinggemma2',tune,'pair',512)
    for family,tuning in [('mgte','full'),('qwen-reranker','lora'),('qwen35','lora'),('lfm25','lora')]:
        for task,representation in [('effort','structured'),('meeting','joint')]:
            for tune in ['frozen',tuning]:add(task,family,tune,representation)
    add('meeting','mgte','full','pair',512)
    add('meeting','qwen-reranker','lora','pair',512)
    return jobs

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--data',required=True);p.add_argument('--name',required=True)
    args=p.parse_args();root=Path(args.root);out=root/'runs'/args.name;out.mkdir(parents=True,exist_ok=True)
    code=out/'code'
    if not code.exists():
        code.mkdir()
        for file in Path(__file__).parent.glob('*.py'):shutil.copyfile(file,code/file.name)
        (out/'manifest.json').write_text(json.dumps({'jobs':matrix(),'dataset':json.loads((Path(args.data)/'manifest.json').read_text()),
             'source':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in code.glob('*.py')}},indent=2))
    jobs=json.loads((out/'manifest.json').read_text())['jobs']
    for job in jobs:
        resultdir=root/'models'/args.name/job['name']
        resultdir.parent.mkdir(parents=True,exist_ok=True)
        if (resultdir/'complete.json').exists():print(json.dumps({'job':job['name'],'state':'cached'}),flush=True);continue
        if (resultdir/'run.json').exists():print(json.dumps({'job':job['name'],'state':'unfinished-prior-attempt'}),flush=True);continue
        env='.venv-mgte' if job['family']=='mgte' else '.venv'
        cmd=[str(root/env/'bin/python'),str(code/'train.py'),'--data',args.data,'--models',str(root/'models'),'--out',str(resultdir)]
        for k,v in job.items():
            if k!='name':cmd+=['--'+k,str(v)]
        start=time.monotonic()
        with (out/(job['name']+'.log')).open('w') as log:
            try:
                r=subprocess.run(cmd,stdout=log,stderr=log,timeout=1800)
                status={'job':job['name'],'state':'complete' if r.returncode==0 else 'failed','exitCode':r.returncode,'seconds':time.monotonic()-start}
            except subprocess.TimeoutExpired:status={'job':job['name'],'state':'timeout','seconds':time.monotonic()-start}
        with (out/'status.jsonl').open('a') as f:f.write(json.dumps(status)+'\n')
        print(json.dumps(status),flush=True)

if __name__=='__main__':main()
