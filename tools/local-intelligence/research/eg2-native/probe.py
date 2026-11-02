"""CPU-only F-dev parity/resource evidence. Never opens C/P/H or existing score files."""
import argparse
import gc
import hashlib
import json
from pathlib import Path
import select
import subprocess
import sys
import time
import torch
from transformers import AutoModel, AutoTokenizer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from modeling import EffortHead

PREFIX = 'task: classification | query: '
LABELS = ['low', 'medium', 'high', 'xhigh']


def clipped(ids, budget=1024):
    return ids if len(ids) <= budget else ids[:128] + ids[-(budget - 128):]


def rows_for_fit(root, source):
    run = json.loads((source / 'run.json').read_text())
    groups = set(run['devGroups'])
    fit = (root / 'data/cohort-002-audited/fit.jsonl').read_bytes()
    assert hashlib.sha256(fit).hexdigest() == run['dataset']['splits']['fit']['sha256']
    rows = [r for line in fit.decode().splitlines()
            if (r := json.loads(line))['task'] == 'effort' and r['group'] in groups]
    assert len(rows) == 150
    assert all(r['group'] not in run['trainGroups'] for r in rows)
    return rows


def tensor_result(model, head, ids):
    inputs = torch.tensor([ids], dtype=torch.long)
    start = time.monotonic()
    with torch.inference_mode():
        hidden = model(input_ids=inputs, attention_mask=torch.ones_like(inputs)).last_hidden_state.float()
        embedding = torch.nn.functional.normalize(hidden.mean(1), dim=-1)
        logits = head(embedding)
    return {'embedding': embedding[0].tolist(), 'logits': logits[0].tolist(),
            'prediction': logits[0].argmax().item(), 'elapsedMs': (time.monotonic() - start) * 1000}


def hf(root, source, artifacts, out, count):
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    rows = rows_for_fit(root, source)[:count]
    synthetic = {'id': 'synthetic-overbudget', 'text': 'Inspect the function and report its behavior. ' * 250}
    cases = rows + [synthetic]
    tokenizer = AutoTokenizer.from_pretrained(source / 'encoder', local_files_only=True)
    tokenizer.padding_side = 'right'
    model = AutoModel.from_pretrained(source / 'encoder', dtype=torch.float32, local_files_only=True).eval()
    head = EffortHead(768, 64).eval()
    head.load_state_dict(torch.load(source / 'head.pt', map_location='cpu', weights_only=True))
    results = []
    for i, row in enumerate(cases):
        tokens = tokenizer(PREFIX + row['text'], truncation=False)['input_ids']
        used = clipped(tokens)
        result = tensor_result(model, head, used)
        result.update({'id': row['id'], 'tokens': used, 'originalTokens': len(tokens)})
        if 'target' in row:
            result['gold'] = LABELS.index(row['target']['level'])
        results.append(result)
        if i == 0 or (i + 1) % 10 == 0:
            print(json.dumps({'stage': 'hf', 'done': i + 1, 'lastMs': result['elapsedMs']}), flush=True)
    (out / 'hf.json').write_text(json.dumps(results))
    del model
    gc.collect()
    wrapped = AutoModel.from_pretrained(artifacts / 'wrapped', dtype=torch.float32, local_files_only=True).eval()
    comparisons = []
    for index in sorted(set([0, min(1, count-1), count-1, count])):
        actual = tensor_result(wrapped, head, results[index]['tokens'])
        reference = results[index]
        comparisons.append({'index': index,
                            'embeddingExact': actual['embedding'] == reference['embedding'],
                            'logitsExact': actual['logits'] == reference['logits']})
    report = {'scope': 'F-dev only, CPU float32 HF reference', 'count': count,
              'correct': sum(r['prediction'] == r['gold'] for r in results if 'gold' in r),
              'clippedFitCases': sum(r['originalTokens'] > 1024 for r in results if 'gold' in r),
              'maxFitTokens': max(r['originalTokens'] for r in results if 'gold' in r),
              'wrapperComparisons': comparisons, 'syntheticOriginalTokens': results[-1]['originalTokens'],
              'syntheticUsedTokens': len(results[-1]['tokens']),
              'torch': torch.__version__, 'dtype': 'float32', 'threads': 4}
    assert all(r['embeddingExact'] and r['logitsExact'] for r in comparisons)
    (out / 'hf-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


def read_reply(process, timeout=90):
    if not select.select([process.stdout], [], [], timeout)[0]:
        process.kill()
        raise RuntimeError('native reply timeout')
    line = process.stdout.readline()
    if not line:
        raise RuntimeError('native helper exited')
    result = json.loads(line)
    if result['type'] == 'error':
        raise RuntimeError('native helper returned fixed error')
    return result


def rss(process):
    try:
        return int(next(line.split()[1] for line in Path(f'/proc/{process.pid}/status').read_text().splitlines() if line.startswith('VmHWM:'))) * 1024
    except (FileNotFoundError, StopIteration):
        return 0


def native(root, source, artifacts, out, kind):
    reference = json.loads((out / 'hf.json').read_text())
    rows = rows_for_fit(root, source)[:len(reference)-1]
    rows += [{'id': 'synthetic-overbudget', 'text': 'Inspect the function and report its behavior. ' * 250}]
    head = EffortHead(768, 64).eval()
    head.load_state_dict(torch.load(source / 'head.pt', map_location='cpu', weights_only=True))
    torch.set_num_threads(1)
    helper = root / 'runs/eg2-native/eg2-helper'
    model = artifacts / f'encoder-{kind}.gguf'
    process = subprocess.Popen([str(helper), str(model), str(artifacts / 'head.json'), '4'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    peaks = 0
    try:
        ready = read_reply(process)
        results = []
        request_id = 0
        def request(row):
            nonlocal request_id, peaks
            request_id += 1
            start = time.monotonic()
            process.stdin.write(json.dumps({'id': request_id, 'text': row['text']}, ensure_ascii=False) + '\n')
            process.stdin.flush()
            result = read_reply(process)
            result['wallMs'] = (time.monotonic() - start) * 1000
            peaks = max(peaks, rss(process))
            return result
        first = request(rows[0]); other = request(rows[-1]); repeated = request(rows[0])
        isolation = all(first[k] == repeated[k] for k in ['tokens', 'embedding', 'logits', 'prediction'])
        assert isolation
        assert other['originalTokens'] > 1024 and len(other['tokens']) == 1024
        for i, (row, expected) in enumerate(zip(rows, reference, strict=True)):
            result = request(row)
            assert result['tokens'] == expected['tokens'], f'token mismatch at F index {i}'
            assert result['originalTokens'] == expected['originalTokens'], f'token count mismatch at F index {i}'
            embedding = torch.tensor(result['embedding'])
            ref_embedding = torch.tensor(expected['embedding'])
            ref_logits = torch.tensor(expected['logits'])
            with torch.inference_mode():
                exact_head = head(embedding[None])[0]
            native_logits = torch.tensor(result['logits'])
            result.update({'caseId': row['id'], 'tokenParity': True,
                           'embeddingMaxAbs': (embedding-ref_embedding).abs().max().item(),
                           'embeddingCosine': torch.nn.functional.cosine_similarity(embedding, ref_embedding, dim=0).item(),
                           'headMathMaxAbs': (native_logits-exact_head).abs().max().item(),
                           'logitMaxAbs': (native_logits-ref_logits).abs().max().item(),
                           'hfPrediction': expected['prediction']})
            if 'gold' in expected:
                result['gold'] = expected['gold']
            results.append(result)
            if i == 0 or (i+1) % 25 == 0:
                print(json.dumps({'stage': kind, 'done': i+1, 'lastMs': result['elapsedMs']}), flush=True)
        process.stdin.close()
        process.wait(timeout=15)
        assert process.returncode == 0
        assert not process.stderr.read()
        (out / f'{kind}-results.json').write_text(json.dumps(results))
        fitted = [r for r in results if 'gold' in r]
        times = sorted(r['wallMs'] for r in fitted)
        report = {'kind': kind, 'backend': ready['backend'], 'count': len(fitted),
                  'correct': sum(r['prediction']==r['gold'] for r in fitted),
                  'hfPredictionAgreement': sum(r['prediction']==r['hfPrediction'] for r in fitted),
                  'tokenParityCount': len(results), 'abaExact': isolation, 'cleanEof': True,
                  'maxHeadMathAbs': max(r['headMathMaxAbs'] for r in results),
                  'maxLogitAbs': max(r['logitMaxAbs'] for r in results),
                  'minEmbeddingCosine': min(r['embeddingCosine'] for r in results),
                  'loadMs': ready['loadMs'], 'firstMs': first['wallMs'],
                  'warmP50Ms': times[len(times)//2], 'warmP95Ms': times[min(len(times)-1,int(len(times)*.95))],
                  'warmMaxMs': max(times), 'overbudget1024Ms': other['wallMs'], 'peakRssBytes': peaks,
                  'artifactBytes': model.stat().st_size, 'headBytes': (artifacts/'head.json').stat().st_size,
                  'artifactSha256': hashlib.sha256(model.read_bytes()).hexdigest()}
        (out / f'{kind}-report.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report), flush=True)
    finally:
        if process.poll() is None:
            process.kill();process.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['hf', 'f16', 'q8', 'q4'])
    parser.add_argument('--root', required=True)
    parser.add_argument('--count', type=int, default=150)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    source = root / 'models/encoder-curve-v2/effort-eg2-full-ce'
    artifacts = root / 'models/eg2-native/fold0'
    out = root / 'runs/eg2-native/fold0'
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.stage == 'hf':
        hf(root, source, artifacts, out, args.count)
    else:
        native(root, source, artifacts, out, args.stage)
