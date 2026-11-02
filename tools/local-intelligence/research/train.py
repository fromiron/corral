#!/usr/bin/env python3
"""Task-specific frozen/full/LoRA experiments. Never reads final.jsonl."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import random
import time
import numpy as np
import torch
from torch import nn
from modeling import Backbone, EffortHead, MeetingHead
from split_eval import fit_dev_groups

LEVELS=['low','medium','high','xhigh']
MODES=['one','set','all','none']

def read(path,task):
    return [r for line in Path(path).read_text().splitlines() if (r:=json.loads(line))['task']==task]

def pack(backbone, rows, args):
    texts=[]; spans=[]; owners=[]
    for n,r in enumerate(rows):
        if args.task=='effort':
            texts.append(r['oldText'] if args.representation=='legacy' else r['text']);spans.append([]);owners.append(n)
        elif args.representation=='pair':
            for text in r['pairTexts']:texts.append(text);spans.append([]);owners.append(n)
        else:
            texts.append(r['jointText']);spans.append(r['candidateSpans']);owners.append(n)
    encoded=backbone.tokenizer([backbone.prefix+t for t in texts],return_offsets_mapping=True,truncation=False)
    sequences=[]; positions=[]; clipped=[]
    for ids,offsets,anchors in zip(encoded['input_ids'],encoded['offset_mapping'],spans):
        keep=list(range(len(ids)))
        if len(ids)>args.tokens:
            # An explicitly measured compression variant; report lost tokens, never pretend lossless.
            if args.representation=='legacy':keep=keep[:args.tokens]
            else:
                front=min(128,args.tokens//4)
                keep=keep[:front]+keep[-(args.tokens-front):]
        clipped.append(len(ids)-len(keep));sequences.append([ids[i] for i in keep])
        one=[]
        for anchor in anchors:
            start,end=anchor['start']+len(backbone.prefix),anchor['end']+len(backbone.prefix)
            matches=[j for j,i in enumerate(keep) if offsets[i][1]>start and offsets[i][0]<end]
            if not matches:raise ValueError('candidate anchor lost to token budget')
            one.append(matches)
        positions.append(one)
    length=max(map(len,sequences));ids=torch.full((len(sequences),length),backbone.tokenizer.pad_token_id,dtype=torch.long)
    mask=torch.zeros_like(ids)
    for n,seq in enumerate(sequences):ids[n,:len(seq)]=torch.tensor(seq);mask[n,:len(seq)]=1
    return ids.cuda(),mask.cuda(),positions,owners,clipped

def features(backbone, rows, args):
    ids,mask,positions,owners,clipped=pack(backbone,rows,args)
    with torch.autocast('cuda',dtype=torch.bfloat16):
        hidden=backbone.tokens(ids,mask)
    pooled=backbone.pool(hidden,mask)
    if args.task=='effort':return {'scene':pooled,'clipped':clipped}
    candidates=torch.zeros((len(rows),6,backbone.dims),device='cuda')
    present=torch.zeros((len(rows),6),device='cuda',dtype=torch.bool)
    if args.representation=='pair':
        at=[0]*len(rows)
        for i,owner in enumerate(owners):
            candidates[owner,at[owner]]=pooled[i];present[owner,at[owner]]=True;at[owner]+=1
        scene=(candidates*present.unsqueeze(-1)).sum(1)/present.sum(1,keepdim=True)
    else:
        scene=pooled
        for i,anchors in enumerate(positions):
            for j,indices in enumerate(anchors):
                v=hidden[i,indices].float().mean(0)
                if backbone.family=='embeddinggemma2':v=nn.functional.normalize(v,dim=-1)
                candidates[i,j]=v;present[i,j]=True
    return {'scene':scene,'candidates':candidates,'present':present,'clipped':clipped}

def targets(rows,args):
    if args.task=='effort':
        y=torch.zeros((len(rows),4),device='cuda')
        for i,r in enumerate(rows):
            votes=[r['target']]+([r['verifier']] if r.get('verifierClear') else [])
            for vote in votes:y[i,LEVELS.index(vote['level'])]+=1/len(votes)
        return y
    eligible=torch.zeros((len(rows),6),device='cuda');excluded=eligible.clone();mode=torch.zeros((len(rows),4),device='cuda')
    for i,r in enumerate(rows):
        votes=[r['target']]+([r['verifier']] if r.get('verifierClear') else [])
        for vote in votes:
            mode[i,MODES.index(vote['mode'])]+=1/len(votes)
            for j,p in enumerate(r['input']['participants']):
                eligible[i,j]+=float(p['id'] in vote['eligibleIds'])/len(votes)
                excluded[i,j]+=float(p['id'] in vote['excludedIds'])/len(votes)
    return {'eligible':eligible,'excluded':excluded,'mode':mode}

def forward(head,f,args):
    if args.task=='effort':return head(f['scene'])
    return head(f['scene'],f['candidates'],f['present'])

def loss(pred,y,args):
    if args.task=='effort':
        ce=-(y*pred.log_softmax(-1)).sum(-1).mean()
        if args.objective=='ordinal':ce=ce+.5*(pred.softmax(-1).cumsum(-1)-y.cumsum(-1)).square().mean()
        return ce
    present=pred['present'].float()
    binary=sum((nn.functional.binary_cross_entropy_with_logits(pred[k],y[k],reduction='none')*present).sum()/present.sum() for k in ['eligible','excluded'])
    return binary-(y['mode']*pred['mode'].log_softmax(-1)).sum(-1).mean()

def evaluate(backbone,head,rows,args,cache=None):
    backbone.eval();head.eval();output=[];total=0.;clipped=0
    with torch.inference_mode():
        for start in range(0,len(rows),args.batch):
            batch=rows[start:start+args.batch]
            f=features(backbone,batch,args) if cache is None else cached(cache,start,min(start+args.batch,len(rows)))
            p=forward(head,f,args);total+=float(loss(p,targets(batch,args),args))*len(batch)
            clipped+=sum(v>0 for v in f['clipped'])
            for i,r in enumerate(batch):
                result={'id':r['id'],'group':r['group'],'language':r['language']}
                if args.task=='effort':result['probabilities']=p[i].softmax(-1).cpu().tolist()
                else:
                    n=len(r['input']['participants'])
                    result.update({'ids':[x['id'] for x in r['input']['participants']],
                                   'eligible':p['eligible'][i,:n].sigmoid().cpu().tolist(),
                                   'excluded':p['excluded'][i,:n].sigmoid().cpu().tolist(),
                                   'mode':p['mode'][i].softmax(-1).cpu().tolist()})
                output.append(result)
    return {'loss':total/max(1,len(rows)),'count':len(rows),'clippedSequences':clipped,'predictions':output}

def cached(cache,start,end):
    return {k:(v[start:end].cuda() if isinstance(v,torch.Tensor) else v[start:end]) for k,v in cache.items()}

def freeze_features(backbone,rows,args):
    chunks={};backbone.eval()
    with torch.inference_mode():
        for start in range(0,len(rows),args.batch):
            f=features(backbone,rows[start:start+args.batch],args)
            for k,v in f.items():chunks.setdefault(k,[]).append(v.detach().cpu() if isinstance(v,torch.Tensor) else v)
    return {k:torch.cat(v) if isinstance(v[0],torch.Tensor) else sum(v,[]) for k,v in chunks.items()}

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--data',required=True);p.add_argument('--models',required=True);p.add_argument('--out',required=True)
    p.add_argument('--task',choices=['effort','meeting'],required=True)
    p.add_argument('--family',default='embeddinggemma2');p.add_argument('--tune',choices=['frozen','full','lora'],default='frozen')
    p.add_argument('--representation',choices=['legacy','structured','joint','pair'],default='structured')
    p.add_argument('--objective',choices=['ce','ordinal'],default='ce')
    p.add_argument('--tokens',type=int,default=1024);p.add_argument('--seed',type=int,default=41)
    p.add_argument('--dev-fold',type=int,choices=range(5),default=0)
    p.add_argument('--holdout-manifest',help='explicit F-only group folds bound to exact fit.jsonl bytes')
    p.add_argument('--lr',type=float,default=1e-5);p.add_argument('--epochs',type=int,default=3)
    p.add_argument('--rank',type=int,default=8);p.add_argument('--batch',type=int,default=2)
    p.add_argument('--width',type=int,default=64)
    p.add_argument('--accumulation',type=int,default=8)
    args=p.parse_args();out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    if (out/'complete.json').exists():raise ValueError('run is already complete; do not overwrite it')
    torch.manual_seed(args.seed);random.seed(args.seed);np.random.seed(args.seed)
    torch.set_num_threads(6)
    source=(Path(args.data)/'fit.jsonl').read_bytes();source_hash=hashlib.sha256(source).hexdigest()
    all_rows=[json.loads(line) for line in source.decode().splitlines()]
    allfit=[r for r in all_rows if r['task']==args.task]
    groups=sorted({r['group'] for r in allfit})
    if len(groups)<3:raise ValueError('at least three independent fit groups required')
    holdout_hash=None
    if args.holdout_manifest:
        holdout_bytes=Path(args.holdout_manifest).read_bytes();holdout_hash=hashlib.sha256(holdout_bytes).hexdigest()
        devgroups=fit_dev_groups(all_rows,args.dev_fold,holdout_manifest=json.loads(holdout_bytes),fit_sha256=source_hash)&{r['group'] for r in allfit}
    else:devgroups=fit_dev_groups(allfit,args.dev_fold)
    train=[r for r in allfit if r['group'] not in devgroups];dev=[r for r in allfit if r['group'] in devgroups]
    if not train or not dev:raise ValueError('empty fit or dev subset')
    manifest=json.loads((Path(args.data)/'manifest.json').read_text())
    (out/'run.json').write_text(json.dumps({'args':vars(args),'dataset':manifest,'trainGroups':sorted(set(r['group'] for r in train)),'devGroups':sorted(devgroups),
        'fitSourceSha256':source_hash,'holdoutManifestSha256':holdout_hash},indent=2))
    backbone=Backbone(args.models,args.family);backbone.tune('frozen')
    head=(EffortHead(backbone.dims,args.width) if args.task=='effort' else MeetingHead(backbone.dims,args.width or 64)).cuda()
    frozen=args.tune=='frozen'
    effective_batch=args.batch*args.accumulation
    trcache=freeze_features(backbone,train,args)
    decache=freeze_features(backbone,dev,args)
    if not frozen:
        warm_optimizer=torch.optim.AdamW(head.parameters(),lr=1e-3,weight_decay=.01)
        warm_best=float('inf');warm_stale=0;warm_history=[]
        for epoch in range(30):
            head.train();order=list(range(len(train)));random.shuffle(order)
            for start in range(0,len(order),effective_batch):
                ix=order[start:start+effective_batch]
                f={k:v[ix].cuda() if isinstance(v,torch.Tensor) else [v[i] for i in ix] for k,v in trcache.items()}
                value=loss(forward(head,f,args),targets([train[i] for i in ix],args),args)
                warm_optimizer.zero_grad();value.backward();nn.utils.clip_grad_norm_(head.parameters(),1.);warm_optimizer.step()
            score=evaluate(backbone,head,dev,args,decache)['loss']
            warm_history.append({'epoch':epoch+1,'devLoss':score})
            if score<warm_best-1e-5:
                warm_best=score;warm_stale=0;torch.save(head.state_dict(),out/'warm-head.pt')
            else:warm_stale+=1
            if warm_stale>=4:break
        (out/'warm-history.json').write_text(json.dumps(warm_history,indent=2))
        head.load_state_dict(torch.load(out/'warm-head.pt',weights_only=True))
        del warm_optimizer,trcache,decache
        trcache=decache=None
        backbone.tune(args.tune,args.rank)
    params=[{'params':head.parameters(),'lr':1e-3 if frozen else 1e-4}, {'params':[p for p in backbone.parameters() if p.requires_grad],'lr':args.lr}]
    optimizer=torch.optim.AdamW(params,weight_decay=.01)
    epochs=30 if frozen else args.epochs;best=float('inf');stale=0;history=[]
    started=time.monotonic()
    for epoch in range(epochs):
        backbone.train(not frozen);head.train();order=list(range(len(train)));random.shuffle(order)
        running=0
        step_batch=effective_batch if frozen else args.batch
        optimizer.zero_grad()
        for start in range(0,len(order),step_batch):
            indices=order[start:start+step_batch];batch=[train[i] for i in indices]
            if frozen:
                f={k:v[indices].cuda() if isinstance(v,torch.Tensor) else [v[i] for i in indices] for k,v in trcache.items()}
            else:f=features(backbone,batch,args)
            value=loss(forward(head,f,args),targets(batch,args),args)
            window=(start//effective_batch)*effective_batch
            window_size=min(effective_batch,len(order)-window)
            (value*(len(batch)/window_size)).backward()
            if frozen or (start+len(batch))%effective_batch==0 or start+len(batch)==len(order):
                if not frozen and epoch==0 and start<effective_batch:
                    norm=sum(float(p.grad.detach().float().square().sum()) for p in backbone.parameters() if p.requires_grad and p.grad is not None)**.5
                    if not np.isfinite(norm) or norm==0:raise ValueError('encoder tuning has no finite nonzero gradient')
                    print(json.dumps({'encoderGradientNorm':norm,'trainableEncoderParameters':sum(p.numel() for p in backbone.parameters() if p.requires_grad)}),flush=True)
                nn.utils.clip_grad_norm_(list(head.parameters())+[p for p in backbone.parameters() if p.requires_grad],1.)
                optimizer.step();optimizer.zero_grad()
            running+=float(value.detach())*len(batch)
        evaluation=evaluate(backbone,head,dev,args,decache)
        stats={'epoch':epoch+1,'trainLoss':running/len(train),'devLoss':evaluation['loss'],'seconds':time.monotonic()-started}
        history.append(stats);print(json.dumps(stats),flush=True)
        if evaluation['loss']<best-1e-5:
            best=evaluation['loss'];stale=0
            torch.save(head.state_dict(),out/'head.pt')
            if not frozen:
                backbone.model.save_pretrained(out/'encoder');backbone.tokenizer.save_pretrained(out/'encoder')
        else:stale+=1
        if stale>=4:break
    # Final H is deliberately not opened; this run produces only fit-dev evidence.
    (out/'history.json').write_text(json.dumps(history,indent=2))
    head.load_state_dict(torch.load(out/'head.pt',weights_only=True))
    if not frozen:
        if args.tune=='lora':
            from peft import PeftModel
            backbone.model=backbone.model.unload()
            backbone.model=PeftModel.from_pretrained(backbone.model,out/'encoder').cuda()
        else:
            from transformers import AutoModel
            extra={'trust_remote_code':True,'code_revision':(Path(args.models)/'mgte-code-revision.txt').read_text().strip()} if args.family=='mgte' else {}
            backbone.model=AutoModel.from_pretrained(out/'encoder',dtype=torch.bfloat16,**extra).cuda()
    (out/'dev.json').write_text(json.dumps(evaluate(backbone,head,dev,args,decache),indent=2))
    (out/'complete.json').write_text(json.dumps({'bestDevLoss':best,'epochs':len(history),'seconds':time.monotonic()-started,'trainCount':len(train),'devCount':len(dev),'status':'exploratory-fit-only'},indent=2))

if __name__=='__main__':main()
