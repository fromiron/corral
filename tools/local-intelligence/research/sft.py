#!/usr/bin/env python3
"""Short-answer SFT challenger retaining the pretrained language-model output head."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import re
import time
import unicodedata
import torch
from torch import nn
from transformers import AutoConfig,AutoTokenizer,AutoModelForCausalLM,Qwen3_5ForCausalLM
from peft import LoraConfig,TaskType,get_peft_model
from metrics import valid_dispatch
from split_eval import fit_dev_groups, validate_fit_rows

def load(models,family='qwen35'):
    path=(Path(models)/(family+'.path')).read_text().strip()
    if family!='qwen35':
        model,info=AutoModelForCausalLM.from_pretrained(path,dtype=torch.bfloat16,output_loading_info=True)
        if info.get('missing_keys'):raise ValueError('pretrained causal head has missing checkpoint keys')
        return model,AutoTokenizer.from_pretrained(path)
    config=AutoConfig.from_pretrained(path).text_config
    model,info=Qwen3_5ForCausalLM.from_pretrained(path,config=config,dtype=torch.bfloat16,
        key_mapping={r'^model\.language_model\.':'model.'},output_loading_info=True)
    if info.get('missing_keys'):raise ValueError(f"text checkpoint keys missing: {info['missing_keys'][:5]}")
    return model,AutoTokenizer.from_pretrained(path)

def format_case(row,tokenizer):
    if row['task']=='meeting':
        instruction='Select who should answer the current message. Return ONLY comma-separated participant IDs, or NONE for explicit silence. If any one responder is acceptable or the invitation is ambiguous, choose exactly one appropriate participant. Honor exclusions. Never infer capabilities from names.'
    else:
        instruction='Choose the minimum useful reasoning effort for the NEXT coding response, not the total project. Return ONLY low, medium, high, or xhigh.'
    text = tokenizer.apply_chat_template([{'role':'system','content':instruction},{'role':'user','content':row['text']}],
        tokenize=False,add_generation_prompt=True,enable_thinking=False)
    # HF Qwen3.5 already normalizes NFC during encode. llama.cpp's BPE path does
    # not, so materialize that same normalization before handing it the prompt.
    normalizer = getattr(tokenizer, 'backend_tokenizer', None)
    return unicodedata.normalize('NFC', text) if normalizer and str(normalizer.normalizer) == 'NFC()' else text

def answer(row,rng):
    t=row['target']
    if row['task']=='effort':return t['level']
    if t['mode']=='none':return 'NONE'
    ids=[rng.choice(t['eligibleIds'])] if t['mode']=='one' else t['eligibleIds']
    return ','.join(ids)

def prompt_ids(row,tokenizer,limit):
    text=format_case(row,tokenizer);ids=tokenizer.encode(text,add_special_tokens=False)
    if len(ids)>limit:
        # Record this compression separately from full-input quality.
        ids=ids[:128]+ids[-(limit-128):]
    return ids

def evaluate(model,tokenizer,rows,limit):
    model.eval();results=[];correct=0
    for row in rows:
        ids=torch.tensor([prompt_ids(row,tokenizer,limit)],device='cuda')
        with torch.inference_mode():
            output=model.generate(input_ids=ids,attention_mask=torch.ones_like(ids),max_new_tokens=24,
                do_sample=False,use_cache=True,pad_token_id=tokenizer.pad_token_id,eos_token_id=tokenizer.eos_token_id)
        text=tokenizer.decode(output[0,ids.shape[1]:],skip_special_tokens=True).strip()
        if row['task']=='effort':
            predicted=text.lower();ok=predicted==row['target']['level']
        else:
            predicted=[] if text.upper()=='NONE' else [v.strip() for v in text.split(',')]
            known={p['id'] for p in row['input']['participants']}
            valid=len(set(predicted))==len(predicted) and set(predicted)<=known
            ok=valid and valid_dispatch(predicted,row['target'])
        correct+=ok;results.append({'id':row['id'],'group':row['group'],'task':row['task'],'prediction':predicted,'valid':bool(ok),'raw':text})
    by_task={task:{'count':len(part),'accuracy':sum(x['valid'] for x in part)/len(part)} for task in sorted({r['task'] for r in rows}) if (part:=[x for x in results if x['task']==task])}
    return {'count':len(rows),'accuracy':correct/max(1,len(rows)),'byTask':by_task,'predictions':results}

def main():
    p=argparse.ArgumentParser();p.add_argument('--models',required=True);p.add_argument('--data',required=True);p.add_argument('--out',required=True)
    p.add_argument('--task',choices=['meeting','effort','joint'],default='meeting');p.add_argument('--tokens',type=int,default=1024)
    p.add_argument('--family',choices=['qwen35','lfm25','qwen-reranker'],default='qwen35')
    p.add_argument('--epochs',type=int,default=3);p.add_argument('--lr',type=float,default=3e-5);p.add_argument('--rank',type=int,default=16)
    p.add_argument('--seed',type=int,default=41)
    p.add_argument('--dev-fold',type=int,choices=range(5),default=0)
    p.add_argument('--holdout-manifest',help='explicit F-only group folds bound to exact fit.jsonl bytes')
    p.add_argument('--fit-all',action='store_true',help='refit a previously selected fixed recipe on F only, using the final epoch')
    p.add_argument('--augment',help='fit-only permutation variants; sample one view per step so update counts stay matched')
    args=p.parse_args();out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    if (out/'complete.json').exists():raise ValueError('completed SFT run exists')
    torch.manual_seed(args.seed);rng=random.Random(args.seed);torch.set_num_threads(6)
    source=(Path(args.data)/'fit.jsonl').read_bytes();source_hash=hashlib.sha256(source).hexdigest()
    all_rows=[json.loads(line) for line in source.decode().splitlines()]
    rows=[r for r in all_rows if r['task']==args.task or args.task=='joint']
    validate_fit_rows(rows)
    holdout_hash=None
    if args.holdout_manifest:
        if args.fit_all:raise ValueError('explicit holdout cannot be combined with full-F refit')
        holdout_bytes=Path(args.holdout_manifest).read_bytes();holdout_hash=hashlib.sha256(holdout_bytes).hexdigest()
        devgroups=fit_dev_groups(all_rows,args.dev_fold,holdout_manifest=json.loads(holdout_bytes),fit_sha256=source_hash)&{r['group'] for r in rows}
    else:devgroups=set() if args.fit_all else fit_dev_groups(rows,args.dev_fold)
    train=[r for r in rows if r['group'] not in devgroups];dev=[r for r in rows if r['group'] in devgroups]
    if not train or (not args.fit_all and not dev):raise ValueError('fit and independent fit-dev groups required')
    variants={};augment_rng=random.Random(args.seed+101)
    if args.augment:
        originals={r['id']:r for r in train}
        for line in Path(args.augment).read_text().splitlines():
            r=json.loads(line)
            if r['split']!='fit':raise ValueError('augmentation crossed fit boundary')
            if r['originalId'] in originals:
                if r['group']!=originals[r['originalId']]['group']:raise ValueError('augmentation changed original group')
                variants[r['originalId']]=r
    model,tokenizer=load(args.models,args.family)
    if tokenizer.pad_token_id is None:tokenizer.pad_token=tokenizer.eos_token
    names={name.rsplit('.',1)[-1] for name,m in model.named_modules() if isinstance(m,nn.Linear)}
    targets=[k for k in ['q_proj','v_proj','o_proj','in_proj_qkv','in_proj','out_proj'] if k in names]
    model=get_peft_model(model,LoraConfig(task_type=TaskType.CAUSAL_LM,r=args.rank,lora_alpha=args.rank*2,lora_dropout=.05,target_modules=targets,bias='none')).cuda()
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant':False})
    opt=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=args.lr,weight_decay=.01)
    (out/'run.json').write_text(json.dumps({'args':vars(args),'trainGroups':sorted(set(r['group'] for r in train)),'devGroups':sorted(devgroups),
        'trainCount':len(train),'devCount':len(dev),'format':'pretrained LM head, non-thinking short-answer SFT','targets':targets,
        'fitSourceSha256':source_hash,'holdoutManifestSha256':holdout_hash},indent=2))
    best=-1;history=[];started=time.monotonic()
    if dev:(out/'zero-shot-dev.json').write_text(json.dumps(evaluate(model,tokenizer,dev,args.tokens),indent=2))
    for epoch in range(args.epochs):
        model.train();order=train.copy();rng.shuffle(order);opt.zero_grad();total=0
        for i,row in enumerate(order):
            if row['id'] in variants and augment_rng.random()<.5:row=variants[row['id']]
            prefix=prompt_ids(row,tokenizer,args.tokens-24)
            target=tokenizer.encode(answer(row,rng),add_special_tokens=False)+[tokenizer.eos_token_id]
            ids=torch.tensor([prefix+target[:-1]],device='cuda');labels=torch.tensor(target,device='cuda')
            with torch.autocast('cuda',dtype=torch.bfloat16):
                output=model(input_ids=ids,attention_mask=torch.ones_like(ids),use_cache=False,logits_to_keep=len(target))
                loss=nn.functional.cross_entropy(output.logits[0].float(),labels)
            window_size=min(16,len(order)-(i//16)*16);(loss/window_size).backward();total+=float(loss.detach())
            if (i+1)%16==0 or i+1==len(order):
                nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad],1.);opt.step();opt.zero_grad()
        report=evaluate(model,tokenizer,dev,args.tokens) if dev else {'accuracy':None,'byTask':{},'predictions':[],'count':0}
        score=report.pop('accuracy') if args.task=='joint' else report['accuracy']
        summary={'epoch':epoch+1,'trainLoss':total/len(train),'devAccuracy':None if args.task=='joint' else score,'devByTask':report['byTask'],'seconds':time.monotonic()-started}
        history.append(summary);print(json.dumps(summary),flush=True)
        fixed_epoch=args.fit_all or args.task=='joint'
        if (fixed_epoch and epoch+1==args.epochs) or (not fixed_epoch and score>best):
            best=None if args.task=='joint' else score;model.save_pretrained(out/'adapter');tokenizer.save_pretrained(out/'adapter')
            (out/'dev.json').write_text(json.dumps(report,indent=2))
    (out/'history.json').write_text(json.dumps(history,indent=2));(out/'complete.json').write_text(json.dumps({'bestDevAccuracy':best,'seconds':time.monotonic()-started,'status':'fixed-recipe-all-fit' if args.fit_all else 'fit-dev-only'},indent=2))

if __name__=='__main__':main()
