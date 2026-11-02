"""Pinned, text-only experiment backbones. No product runtime or model selection policy."""
from pathlib import Path
import json
import torch
from torch import nn
from transformers import AutoConfig, AutoModel, AutoTokenizer


class Backbone(nn.Module):
    def __init__(self, model_root, family, device='cuda'):
        super().__init__()
        root = Path(model_root)
        path = (root / f'{family}.path').read_text().strip()
        extra = {}
        if family == 'mgte':
            extra = {'trust_remote_code': True, 'code_revision': (root / 'mgte-code-revision.txt').read_text().strip()}
        config = AutoConfig.from_pretrained(path, **extra)
        if family == 'embeddinggemma2':
            config.vision_config = None
            config.audio_config = None
        if family == 'mgte':
            config.use_memory_efficient_attention = False
            config.unpad_inputs = False
        model = AutoModel.from_pretrained(path, config=config, dtype=torch.bfloat16, **extra)
        self.model = model.language_model if family in ['embeddinggemma2', 'qwen35'] else model
        self.tokenizer = AutoTokenizer.from_pretrained(path, **extra)
        if self.tokenizer.pad_token_id is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        self.tokenizer.padding_side = 'right'
        self.family = family
        self.prefix = 'task: classification | query: ' if family == 'embeddinggemma2' else ''
        self.dims = getattr(self.model.config, 'embedding_dim', self.model.config.hidden_size)
        self.to(device)

    def tokenize(self, texts, max_length, offsets=False):
        return self.tokenizer([self.prefix + t for t in texts], padding=True, truncation=True,
                              max_length=max_length, return_offsets_mapping=offsets, return_tensors='pt')

    def tokens(self, ids, mask):
        return self.model(input_ids=ids, attention_mask=mask).last_hidden_state

    def pool(self, hidden, mask):
        h = hidden.float()
        if self.family == 'embeddinggemma2':
            m = mask.unsqueeze(-1)
            return nn.functional.normalize((h * m).sum(1) / m.sum(1).clamp_min(1), dim=-1)
        if self.family == 'mgte':
            return h[:, 0]
        return h[torch.arange(h.shape[0], device=h.device), mask.sum(1) - 1]

    def forward(self, ids, mask):
        h = self.tokens(ids, mask)
        return self.pool(h, mask)

    def tune(self, mode, rank=8):
        for p in self.model.parameters():p.requires_grad = mode == 'full'
        if mode == 'full':
            # FP32 master parameters/moments; feature computation uses BF16 autocast.
            # Direct BF16 Adam updates can round away a 1e-5 encoder step.
            self.model.float()
            # Keep the large vocabulary table stable; learn contextual representations.
            for name,p in self.model.named_parameters():
                if 'embed_tokens' in name or 'word_embeddings' in name:p.requires_grad=False
            if hasattr(self.model, 'gradient_checkpointing_enable'):
                self.model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
        elif mode == 'lora':
            from peft import LoraConfig, get_peft_model
            names = {name.rsplit('.', 1)[-1] for name,module in self.model.named_modules() if isinstance(module, nn.Linear)}
            targets = [n for n in ['q_proj','k_proj','v_proj','o_proj','query','key','value','Wqkv','in_proj_qkv','out_proj'] if n in names]
            if not targets:raise ValueError('no supported attention projections for LoRA')
            self.model = get_peft_model(self.model, LoraConfig(r=rank, lora_alpha=rank*2, target_modules=targets, lora_dropout=.05, bias='none'))
            if hasattr(self.model, 'gradient_checkpointing_enable'):
                self.model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
        elif mode != 'frozen':raise ValueError('unknown tuning mode')
        if hasattr(self.model.config, 'use_cache'):self.model.config.use_cache=False


class EffortHead(nn.Module):
    def __init__(self, dims, width=64):
        super().__init__()
        self.net=(nn.Sequential(nn.LayerNorm(dims),nn.Linear(dims,4)) if width==0 else
                  nn.Sequential(nn.LayerNorm(dims),nn.Linear(dims,width),nn.GELU(),nn.Dropout(.1),nn.Linear(width,4)))
    def forward(self,x):return self.net(x)


class MeetingHead(nn.Module):
    """Shared participant scorer plus scene mode, not a fixed participant-ID classifier."""
    def __init__(self, dims, width=64):
        super().__init__()
        self.rank=nn.Sequential(nn.LayerNorm(dims*2),nn.Linear(dims*2,width),nn.GELU(),nn.Dropout(.1),nn.Linear(width,2))
        self.mode=EffortHead(dims,width)
    def forward(self, scene, candidates, present):
        context=scene[:,None,:].expand_as(candidates)
        scores=self.rank(torch.cat([context,candidates],dim=-1))
        return {'eligible':scores[:,:,0], 'excluded':scores[:,:,1], 'mode':self.mode(scene), 'present':present}


def smoke(root, output, families):
    results=[]
    import time,gc
    for family in families:
        started=time.monotonic()
        try:
            torch.cuda.reset_peak_memory_stats()
            backbone=Backbone(root,family)
            batch=backbone.tokenize(['현재 오류 원인을 분석해 줘.','Aram proposed the red lantern; ask Aram to explain.'],128)
            with torch.inference_mode():
                vector=backbone(batch['input_ids'].cuda(),batch['attention_mask'].cuda())
            results.append({'family':family,'ok':bool(vector.isfinite().all()),'shape':list(vector.shape),
                            'seconds':time.monotonic()-started,'peakMiB':torch.cuda.max_memory_allocated()/1024**2,
                            'parameters':sum(p.numel() for p in backbone.parameters())})
            del backbone,vector,batch
        except Exception as e:
            results.append({'family':family,'ok':False,'error':str(e)[:1200]})
        gc.collect();torch.cuda.empty_cache()
        Path(output).write_text(json.dumps(results,indent=2))
        print(json.dumps(results[-1]),flush=True)

if __name__=='__main__':
    import sys
    smoke(sys.argv[1],sys.argv[2],sys.argv[3:])
