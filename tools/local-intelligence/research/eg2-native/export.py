"""Research-only text wrapper and exact FP32 head export; never edits source tensors."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
import torch
from safetensors.torch import load_file, save_file


def wrapped_config(text_config):
    if text_config.get('architectures') != ['EmbeddingGemma2TextModel']:
        raise ValueError('expected the tuned EG2 text-only checkpoint')
    text = copy.deepcopy(text_config)
    # The original composite checkpoint has no sub-config architectures override.
    text.pop('architectures')
    # Preserve version metadata: Transformers otherwise misidentifies this local BPE
    # tokenizer as an old Mistral tokenizer. No tokenizer patch is appropriate here.
    return {'architectures': ['EmbeddingGemma2Model'], 'model_type': 'embedding_gemma2',
            'vision_config': None, 'audio_config': None, 'text_config': text,
            'dtype': text.get('dtype', 'float32'),
            'transformers_version': text.get('transformers_version')}


def wrapped_tensors(tensors):
    if any(k.startswith('language_model.') for k in tensors):
        raise ValueError('checkpoint is already wrapped')
    return {'language_model.' + k: v for k, v in tensors.items()}


def export(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    if output.exists():
        raise ValueError('output must be new')
    output.mkdir(parents=True, mode=0o700)
    config = wrapped_config(json.loads((source / 'encoder/config.json').read_text()))
    (output / 'config.json').write_text(json.dumps(config, indent=2) + '\n')
    original = load_file(source / 'encoder/model.safetensors')
    renamed = wrapped_tensors(original)
    save_file(renamed, output / 'model.safetensors', metadata={'format': 'pt'})
    loaded = load_file(output / 'model.safetensors')
    for name, tensor in original.items():
        assert torch.equal(tensor.view(torch.int32), loaded['language_model.' + name].view(torch.int32))
    for name in ['tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja']:
        if (source / 'encoder' / name).exists():
            shutil.copyfile(source / 'encoder' / name, output / name)
    (output / '1_Pooling').mkdir()
    (output / 'modules.json').write_text(json.dumps([{'idx': 1, 'path': '1_Pooling', 'type': 'sentence_transformers.models.Pooling'}]))
    (output / '1_Pooling/config.json').write_text(json.dumps({'pooling_mode': 'mean', 'include_prompt': True, 'embedding_dimension': 768}))
    head = torch.load(source / 'head.pt', map_location='cpu', weights_only=True)
    assert set(head) == {'net.0.weight', 'net.0.bias', 'net.1.weight', 'net.1.bias', 'net.4.weight', 'net.4.bias'}
    (output.parent / 'head.json').write_text(json.dumps({'format': 1, 'dimensions': 768, 'width': 64, 'epsilon': 1e-5, 'activation': 'gelu_erf', 'labels': ['low', 'medium', 'high', 'xhigh'], 'weights': {k: v.float().tolist() for k, v in head.items()}}, separators=(',', ':')))
    report = {'tensorCount': len(original), 'allTensorBitsIdentical': True,
              'sourceSha256': hashlib.sha256((source / 'encoder/model.safetensors').read_bytes()).hexdigest(),
              'wrappedSha256': hashlib.sha256((output / 'model.safetensors').read_bytes()).hexdigest()}
    (output.parent / 'wrapper-receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    export(args.source, args.output)
