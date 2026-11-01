#!/usr/bin/env python3
"""Frozen generative candidate replay, with a separate four-label constrained effort readout."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import torch
from peft import PeftModel
from sft import load,evaluate,prompt_ids
from split_eval import fit_dev_rows

LEVELS=['low','medium','high','xhigh']

def main():
    p=argparse.ArgumentParser();p.add_argument('--run',required=True);p.add_argument('--data',required=True);p.add_argument('--out',required=True)
    p.add_argument('--split',choices=['fit-dev','calibration','policy','final'],required=True);p.add_argument('--unseal-final',action='store_true')
    p.add_argument('--task',choices=['meeting','effort','joint'])
    a=p.parse_args();run=Path(a.run);metadata=json.loads((run/'run.json').read_text());args=metadata['args'];task=a.task or args['task']
    if a.split=='final' and not a.unseal_final:raise ValueError('final remains sealed')
    source=Path(a.data)/('fit.jsonl' if a.split=='fit-dev' else a.split+'.jsonl')
    if Path(a.out).exists():raise ValueError('prediction artifact exists')
    if a.split=='final':
        with (Path(a.data)/'final-exposures.jsonl').open('a') as f:f.write(json.dumps({'run':a.run,'at':time.time(),'dataHash':hashlib.sha256(source.read_bytes()).hexdigest()})+'\n')
    rows=[r for line in source.read_text().splitlines() if (r:=json.loads(line))['task']==task or task=='joint']
    if a.split=='fit-dev':rows=fit_dev_rows(rows,metadata,source_sha256=hashlib.sha256(source.read_bytes()).hexdigest())
    model,tokenizer=load(args['models'],args.get('family','qwen35'));model=PeftModel.from_pretrained(model,run/'adapter').cuda().eval();torch.set_num_threads(6)
    if tokenizer.pad_token_id is None:tokenizer.pad_token=tokenizer.eos_token
    report={'split':a.split,'task':task,'run':a.run,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'predictions':[]}
    meeting=[r for r in rows if r['task']=='meeting']
    if meeting:report['predictions']+=evaluate(model,tokenizer,meeting,args['tokens'])['predictions']
    label_tokens=[tokenizer.encode(level,add_special_tokens=False)[0] for level in LEVELS]
    if len(set(label_tokens))!=4:raise ValueError('effort labels need distinct first tokens')
    for row in [r for r in rows if r['task']=='effort']:
        ids=torch.tensor([prompt_ids(row,tokenizer,args['tokens'])],device='cuda');start=time.monotonic()
        with torch.inference_mode():
            logits=model(input_ids=ids,attention_mask=torch.ones_like(ids),use_cache=False,logits_to_keep=1).logits[0,-1,label_tokens].float()
        probabilities=logits.softmax(-1).tolist();level=LEVELS[int(logits.argmax())]
        report['predictions'].append({'id':row['id'],'group':row['group'],'task':'effort','probabilities':probabilities,'logits':logits.tolist(),'prediction':level,'valid':level==row['target']['level'],'seconds':time.monotonic()-start})
    report['labelTokenIds']=label_tokens;Path(a.out).write_text(json.dumps(report,indent=2))
    print(json.dumps({'split':a.split,'counts':{task:sum(x['task']==task for x in report['predictions']) for task in ['effort','meeting']}}))

if __name__=='__main__':main()
