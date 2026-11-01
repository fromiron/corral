#!/usr/bin/env python3
"""Merge an experimental adapter in FP32 before export; never publish private run paths."""
import argparse
import hashlib
import json
from pathlib import Path
from peft import PeftModel
from sft import load

p=argparse.ArgumentParser();p.add_argument('--run',required=True);p.add_argument('--out',required=True)
a=p.parse_args();run=Path(a.run);out=Path(a.out)
if out.exists():raise ValueError('merged artifact already exists')
metadata=json.loads((run/'run.json').read_text());args=metadata['args']
model,tokenizer=load(args['models'],args.get('family','qwen35'))
model=PeftModel.from_pretrained(model.float(),run/'adapter').merge_and_unload(safe_merge=True)
model.save_pretrained(out);tokenizer.save_pretrained(out)
(out/'corral-export-source.json').write_text(json.dumps({'task':args['task'],'family':args.get('family','qwen35'),
    'precision':'fp32-merge','adapterSha256':hashlib.file_digest(open(run/'adapter/adapter_model.safetensors','rb'),'sha256').hexdigest(),
    'status':'experimental; no production promotion'},indent=2))
print(json.dumps({'merged':True,'bytes':sum(p.stat().st_size for p in out.iterdir() if p.is_file())}))
