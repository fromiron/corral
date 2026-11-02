#!/usr/bin/env python3
"""Build judge inputs from exactly worker-visible source; never use tests/reference/difficulty."""
import argparse
import hashlib
import json
from pathlib import Path

def judge_input(case):
    return {'goal':'','request':case['request']+'\nObserved context:\n'+case['context'],'previousRequest':'','previousReply':'','stage':'step','plan':'',
        'tools':[{'name':'read_file','args':f['path'],'status':'success','content':f['content']} for f in case['files']]}

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--out',required=True);p.add_argument('--cohort',choices=['development','final'],required=True);a=p.parse_args()
    out=Path(a.out)
    if out.exists():raise ValueError('outcome input snapshot exists')
    rows=[]
    for path in sorted((Path(a.root)/'outcomes/validated').glob('*/case.json')):
        case=json.loads(path.read_text());development=int(case['id'].split('-')[1])<20
        if development!=(a.cohort=='development'):continue
        rows.append({'id':case['id'],'group':case['group'],'task':'effort','language':'mixed','split':'policy' if development else 'final',
            'input':judge_input(case),'target':None,'source':{'kind':'executable-snapshot','fixtureSha256':hashlib.sha256(json.dumps(case,sort_keys=True).encode()).hexdigest(),
                'mapping':'v2: observed context attached to request, source supplied as completed reads; no invented assistant reply or test/reference/difficulty metadata'}})
    out.parent.mkdir(parents=True,exist_ok=True,mode=0o700);out.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows));out.chmod(0o600)
    print(json.dumps({'cohort':a.cohort,'count':len(rows)}))

if __name__=='__main__':main()
