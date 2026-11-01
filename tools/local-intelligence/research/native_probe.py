#!/usr/bin/env python3
"""Native LiteRT generation/scoring feasibility, with repeated fresh sessions."""
import argparse
import json
from pathlib import Path
import resource
import time
import litert_lm
from litert_lm.interfaces import CPU,GPU

p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--out',required=True)
p.add_argument('--backend',choices=['cpu','gpu'],default='cpu');p.add_argument('--threads',type=int,default=4)
a=p.parse_args()
prompt='<|im_start|>system\nReply only with one participant ID. Pick the person who proposed the red lantern.<|im_end|>\n<|im_start|>user\np1: I propose blue flowers.\np2: I propose a red lantern.\np3: I like both.\nWho should explain the red lantern?<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
start=time.monotonic();engine=litert_lm.Engine(model_path=a.model,backend=CPU(thread_count=a.threads) if a.backend=='cpu' else GPU(),max_num_tokens=2048)
load=time.monotonic()-start;rows=[]
for mode in ['decode','score']:
    for repeat in range(3):
        session=engine.create_session(apply_prompt_template=False,sampler_config=litert_lm.SamplerConfig(top_k=1,temperature=0,seed=41),max_output_tokens=12)
        start=time.monotonic();session.run_prefill([prompt]);prefill=time.monotonic()-start
        result=session.run_decode() if mode=='decode' else session.run_text_scoring(['p2'],store_token_lengths=True)
        rows.append({'mode':mode,'repeat':repeat,'prefillSeconds':prefill,'seconds':time.monotonic()-start,'texts':result.texts,'scores':result.scores,'lengths':result.token_lengths})
        session.close()
        Path(a.out).write_text(json.dumps({'status':'running','rows':rows},indent=2))
engine.close()
report={'scope':'native feasibility; not quality promotion','backend':a.backend,'loadSeconds':load,'peakRssMiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,'rows':rows}
Path(a.out).write_text(json.dumps(report,indent=2));print(json.dumps(report))
