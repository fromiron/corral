#!/usr/bin/env python3
"""Compare optional training kernels with the original environment before changing recipes."""
import argparse
import importlib.metadata as metadata
import json
from pathlib import Path
import time
import torch
from peft import PeftModel
from sft import load,prompt_ids

p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--out',required=True);a=p.parse_args();root=Path(a.root)
model,tok=load(root/'models');model=PeftModel.from_pretrained(model,root/'models/joint-qwen35-sft-pilot/adapter',is_trainable=True).cuda().eval()
torch.set_num_threads(4);torch.manual_seed(41)
rows=[json.loads(s) for s in (root/'data/pilot-003/fit.jsonl').read_text().splitlines()]
selected=[next(r for r in rows if r['task']==task) for task in ['effort','meeting']]
logits=[];timings=[]
for row in selected:
    ids=torch.tensor([prompt_ids(row,tok,1024)],device='cuda')
    for repeat in range(3):
        model.zero_grad();torch.cuda.synchronize();start=time.monotonic()
        out=model(input_ids=ids,attention_mask=torch.ones_like(ids),use_cache=False,logits_to_keep=1).logits[0,-1].float()
        loss=-out.log_softmax(-1)[9997];loss.backward();torch.cuda.synchronize()
        timings.append({'task':row['task'],'tokens':ids.shape[1],'repeat':repeat,'seconds':time.monotonic()-start})
    logits.append(out.detach().cpu())
grad=torch.cat([p.grad.flatten().float().cpu() for p in model.parameters() if p.requires_grad and p.grad is not None])
assert grad.isfinite().all() and grad.norm()>0
torch.save({'logits':torch.stack(logits),'gradient':grad},a.out+'.pt')
versions={k:metadata.version(k) for k in ['torch','transformers','peft']}
try:versions['flash-linear-attention']=metadata.version('flash-linear-attention')
except metadata.PackageNotFoundError:versions['flash-linear-attention']=None
report={'versions':versions,'timings':timings,'gradientNorm':float(grad.norm()),'peakMiB':torch.cuda.max_memory_allocated()/1024**2}
Path(a.out+'.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
