#!/usr/bin/env python3
"""Frozen user-supplied rp model comparison; missing step formatter is never invented."""
import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


def reference_request(value):
    # Match baseline.ts/render-records.ts: old formats have one request field,
    # but must still receive both pieces of the same supplied semantic input.
    return '\n'.join(part for part in [value.get('goal'), value['request']] if part)


def rp_text(request, previous_reply):
    # JS String.slice counts UTF-16 code units. Replacement matches UTF-8 transport
    # for a cut surrogate; exact parity with the unavailable compact loader is unproven.
    head = request.encode('utf-16-le', errors='surrogatepass')[:3000]
    tail = previous_reply.encode('utf-16-le', errors='surrogatepass')[-2000:]
    return 'request: ' + head.decode('utf-16-le', errors='replace') + '\nprevious reply: ' + tail.decode('utf-16-le', errors='replace')


def main():
    parser = argparse.ArgumentParser()
    for name in ['model', 'tokenizer', 'calibration', 'input', 'out']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--unseal-final', action='store_true')
    args = parser.parse_args()
    out = Path(args.out)
    if out.exists():
        raise ValueError('reference predictions already exist')
    all_rows = [json.loads(line) for line in Path(args.input).read_text().splitlines()]
    rows = [row for row in all_rows if row['task'] == 'effort' and row['input']['stage'] == 'turn']
    final = any(row['split'] == 'final' for row in all_rows)
    if final and not args.unseal_final:
        raise ValueError('final remains sealed')
    hashes = {key: hashlib.file_digest(open(getattr(args, key), 'rb'), 'sha256').hexdigest()
              for key in ['model', 'tokenizer', 'calibration', 'input']}
    if final:
        out.with_suffix(out.suffix + '.exposure.json').write_text(json.dumps({'at': time.time(), **hashes}))
    config = json.loads(Path(args.calibration).read_text())
    if config['inputFormat'] != 'rp' or config['maxTokens'] != 256 or config['temperature'] <= 0:
        raise ValueError('only the supplied fixed rp256 calibration is supported')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    model = ort.InferenceSession(args.model, options, providers=['CPUExecutionProvider'])
    tokenizer = Tokenizer.from_file(args.tokenizer)

    def predict(request, previous=''):
        ids = [2] + tokenizer.encode(rp_text(request, previous), add_special_tokens=False).ids[:254] + [1]
        logits = model.run(['logits'], {'input_ids': np.array([ids], dtype=np.int64),
                                     'attention_mask': np.ones((1, len(ids)), dtype=np.int64)})[0][0].astype(np.float64)
        scaled = logits / config['temperature']
        probabilities = np.exp(scaled - scaled.max())
        return {'logits': logits.tolist(), 'probabilities': (probabilities / probabilities.sum()).tolist(), 'tokens': len(ids)}

    predict('warm up')
    predictions = []
    for row in rows:
        start = time.monotonic()
        result = predict(reference_request(row['input']), row['input'].get('previousReply', ''))
        predictions.append({'id': row['id'], 'group': row['group'], **result, 'seconds': time.monotonic() - start})
    out.write_text(json.dumps({'hashes': hashes, 'temperature': config['temperature'], 'labels': ['low', 'medium', 'high', 'xhigh'],
                             'scope': 'turn-only rp; request is goal+current request like legacy Corral; HF tokenizers loader, compact-loader parity unproven; step formatter unavailable',
                             'inputRows': len(all_rows), 'predictions': predictions}, indent=2))
    out.chmod(0o600)
    print(json.dumps({'comparedTurnRows': len(predictions), 'inputRows': len(all_rows)}))


if __name__ == '__main__':
    main()
