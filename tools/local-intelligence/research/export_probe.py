#!/usr/bin/env python3
"""CPU ONNX feasibility/parity probe, before selecting or shipping tuned weights."""
from pathlib import Path
import json
import time
import numpy as np
import torch
from torch import nn
from modeling import Backbone

class Encoder(nn.Module):
    def __init__(self,backbone):super().__init__();self.backbone=backbone
    def forward(self,input_ids,attention_mask):return self.backbone(input_ids,attention_mask)

def main(root,out):
    torch.set_num_threads(4);out=Path(out);out.mkdir(parents=True,exist_ok=True)
    b=Backbone(root,'embeddinggemma2','cpu');b.float().eval();model=Encoder(b).eval()
    text='task: classification | query: We have finished all tests. Report the verified result briefly.'
    sample=b.tokenizer(text,return_tensors='pt')
    seq=torch.export.Dim('sequence',min=2,max=2048)
    started=time.monotonic()
    torch.onnx.export(model,(sample['input_ids'],sample['attention_mask']),out/'encoder.onnx',
                      input_names=['input_ids','attention_mask'],output_names=['corral_judge_embedding'],
                      dynamic_shapes=({1:seq},{1:seq}),opset_version=23,dynamo=True,
                      external_data=True,report=True,artifacts_dir=str(out))
    import onnxruntime as ort
    options=ort.SessionOptions();options.intra_op_num_threads=4
    session=ort.InferenceSession(str(out/'encoder.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
    parity=[]
    for text in ['현재 실패 원인을 다시 분석해 줘.',' '.join(['Investigate the observed state transition.']*40)]:
        batch=b.tokenizer(b.prefix+text,return_tensors='pt')
        with torch.inference_mode():expected=model(batch['input_ids'],batch['attention_mask']).numpy()
        begin=time.monotonic();actual=session.run(None,{k:v.numpy() for k,v in batch.items() if k in ['input_ids','attention_mask']})[0]
        parity.append({'tokens':int(batch['input_ids'].shape[1]),'maxAbsError':float(np.max(np.abs(expected-actual))),'ortMs':1000*(time.monotonic()-begin)})
    report={'seconds':time.monotonic()-started,'files':{p.name:p.stat().st_size for p in out.glob('encoder.onnx*')},'parity':parity}
    (out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))

if __name__=='__main__':
    import sys
    main(*sys.argv[1:])
