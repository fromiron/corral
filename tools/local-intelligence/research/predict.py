#!/usr/bin/env python3
"""Replay a frozen candidate; final split requires an explicit exposure receipt."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import torch
from transformers import AutoModel
from modeling import Backbone,EffortHead,MeetingHead
from train import read,evaluate

def load_run(path):
    run=json.loads((Path(path)/'run.json').read_text())
    args=argparse.Namespace(**run['args'])
    if not hasattr(args,'width'):args.width=64
    backbone=Backbone(args.models,args.family)
    if args.tune!='frozen':
        if args.tune=='lora':
            from peft import PeftModel
            backbone.model=PeftModel.from_pretrained(backbone.model,Path(path)/'encoder').cuda()
        else:
            extra={'trust_remote_code':True,'code_revision':(Path(args.models)/'mgte-code-revision.txt').read_text().strip()} if args.family=='mgte' else {}
            backbone.model=AutoModel.from_pretrained(Path(path)/'encoder',dtype=torch.bfloat16,**extra).cuda()
    head=(EffortHead(backbone.dims,args.width) if args.task=='effort' else MeetingHead(backbone.dims,args.width or 64)).cuda()
    head.load_state_dict(torch.load(Path(path)/'head.pt',weights_only=True))
    return backbone,head,args

def main():
    p=argparse.ArgumentParser();p.add_argument('--run',required=True);p.add_argument('--data',required=True)
    p.add_argument('--split',choices=['fit','calibration','policy','final'],required=True)
    p.add_argument('--out',required=True);p.add_argument('--unseal-final',action='store_true')
    opt=p.parse_args()
    if opt.split=='final' and not opt.unseal_final:raise ValueError('final is sealed; freeze candidate and explicitly record exposure')
    source=Path(opt.data)/f'{opt.split}.jsonl'
    if Path(opt.out).exists():raise ValueError('prediction artifact exists; do not overwrite prior evidence')
    if opt.split=='final':
        receipt={'run':opt.run,'dataHash':hashlib.sha256(source.read_bytes()).hexdigest(),'openedAt':time.time()}
        with (Path(opt.data)/'final-exposures.jsonl').open('a') as f:f.write(json.dumps(receipt)+'\n')
    backbone,head,args=load_run(opt.run)
    rows=read(source,args.task)
    start=time.monotonic();report=evaluate(backbone,head,rows,args)
    report.update({'run':opt.run,'split':opt.split,'task':args.task,'dataSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'seconds':time.monotonic()-start})
    Path(opt.out).write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='predictions'}))

if __name__=='__main__':main()
