#!/usr/bin/env python3
"""Export Qwen using decomposed operations compatible with the released runtime."""
import argparse
from litert_torch.generative.export_hf.export import export
from litert_torch.generative.export_hf.core.exportable_module_config import register_extra_kwargs_keys

p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--out',required=True)
a=p.parse_args()
# The Qwen extension consumes this option, but 49af1228 omits it from its
# declared keys. Use the exporter's extension registration API explicitly.
register_extra_kwargs_keys(['use_fused_gdn'])
export(model=a.model,output_dir=a.out,prefill_lengths=[128],cache_length=2048,
       quantization_recipe='dynamic_wi8_afp32',use_jinja_template=True,model_dtype='float32',
       extra_kwargs={'use_fused_gdn':False})
