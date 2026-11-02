#!/usr/bin/env python3
"""Validate completed authored fixtures and run bounded, resumable worker trials."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import random
import time
from grader import validate_corpus
from trials import trial,LEVELS

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--workers',type=int,default=4)
    p.add_argument('--limit',type=int,default=300);p.add_argument('--repeats',type=int,default=2)
    p.add_argument('--author-batches',type=int,default=100);p.add_argument('--transport',default='corral',choices=['codex','corral'])
    args=p.parse_args();root=Path(args.root);queued=set();pending={};accepted={}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        while True:
            validate_corpus(root)
            paths=sorted((root/'outcomes/validated').glob('*/case.json'))[:args.limit]
            for path in paths:
                case=json.loads(path.read_text());accepted[case['id']]=case
                for repeat in range(args.repeats):
                    levels=LEVELS.copy();random.Random(f"{case['id']}:{repeat}:41").shuffle(levels)
                    for level in levels:
                        key=(case['id'],level,repeat)
                        if key in queued:continue
                        queued.add(key);pending[pool.submit(trial,args,case,level,repeat)]=key
            for future in [f for f in pending if f.done()]:
                key=pending.pop(future)
                try:print(json.dumps(future.result()),flush=True)
                except Exception as e:print(json.dumps({'case':key,'state':'invalid','error':str(e)}),flush=True)
            summary={'validatedCases':len(accepted),'scheduledTrials':len(queued),'pendingTrials':len(pending),'at':time.time()}
            (root/'outcomes/pipeline-status.json').write_text(json.dumps(summary,indent=2))
            completed=len(list((root/'outcomes/author').glob('*/complete.json')))
            if not pending and (completed>=args.author_batches or len(paths)>=args.limit or (root/'outcomes/authoring-complete.json').exists()):break
            time.sleep(10)

if __name__=='__main__':main()
