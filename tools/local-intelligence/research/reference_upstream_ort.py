#!/usr/bin/env python3
"""CPU inference on exact compact IDs. Prints counts/timing only; never reads labels/outcomes."""
import argparse
import hashlib
import json
from pathlib import Path
import time
from datetime import datetime, timezone
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


def digest(path):
    with open(path, 'rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def record_final_exposure(data, prepared, output, unseal_final):
    final = data['metadata'].get('finalInputPresent') is True or any(row.get('split') == 'final' for row in data['records'])
    if final and not unseal_final:
        raise ValueError('final reference inference requires explicit --unseal-final')
    if final:
        ledger = Path(str(output) + '.exposure.json')
        ledger.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with ledger.open('x') as handle:
            json.dump({'at': datetime.now(timezone.utc).isoformat(), 'scope': 'final local reference inference only',
                       'unsealFinal': True, 'workerOutcomesRead': False, 'preparedSha256': digest(prepared),
                       'sourceSha256': digest(__file__), 'temperature': 1.55, 'intraOpThreads': 4,
                       'assets': data['metadata'].get('assets', [])}, handle, indent=2)
        ledger.chmod(0o600)
    return final


def run(assets, prepared, output, *, unseal_final=False):
    assets, prepared, output = Path(assets), Path(prepared), Path(output)
    if output.exists() or output.with_suffix('.summary.json').exists():
        raise ValueError('reference outputs must be new')
    data = json.loads(prepared.read_text())
    record_final_exposure(data, prepared, output, unseal_final)
    metadata = data['metadata']
    if metadata['upstreamCommit'] != '7e6abe16b9ed9c0947661d843d64b96e5b22d981' or not metadata['compactTokenizerAuthority']:
        raise ValueError('prepared input authority differs')
    for asset in metadata['assets']:
        if digest(assets / asset['name']) != asset['sha256']:
            raise ValueError('prepared model assets differ')
    config = metadata['calibration']
    assert config['temperature'] == 1.55 and config['inputFormat'] == 'rp' and config['maxTokens'] == 256
    records = data['records']
    assert records and all('target' not in row and 'probabilities' not in row for row in records)
    # This is a diagnostic only. Actual compact IDs remain the inference authority.
    tokenizer = Tokenizer.from_file(str(assets / 'tokenizer.json'))
    prefix, suffix = metadata['prefix'], metadata['suffix']
    room = 256-len(prefix)-len(suffix)
    diagnostic = []
    for row in records:
        hf_ids = prefix + tokenizer.encode(row['hfDiagnosticText'], add_special_tokens=False).ids[:room] + suffix
        diagnostic.append({'id': row['id'], 'equal': hf_ids == row['tokenIds'], 'hfIds': hf_ids})
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    start = time.monotonic()
    session = ort.InferenceSession(str(assets / 'model.onnx'), options, providers=['CPUExecutionProvider'])
    load_ms = (time.monotonic()-start)*1000
    assert session.get_providers() == ['CPUExecutionProvider']

    def infer(ids):
        assert 2 <= len(ids) <= 256 and all(isinstance(token, int) and token >= 0 for token in ids)
        logits = session.run(['logits'], {'input_ids': np.asarray([ids], dtype=np.int64),
                                         'attention_mask': np.ones((1, len(ids)), dtype=np.int64)})[0][0].astype(np.float64)
        assert logits.shape == (4,) and np.isfinite(logits).all()
        scaled = logits / 1.55
        exp = np.exp(scaled-scaled.max())
        return logits, exp/exp.sum()

    start = time.monotonic();infer(data['warmupIds']);warm_ms = (time.monotonic()-start)*1000
    first, _ = infer(records[0]['tokenIds']);infer(records[-1]['tokenIds']);again, _ = infer(records[0]['tokenIds'])
    aba_exact = bool(np.array_equal(first, again))
    predictions = []
    for row in records:
        start = time.monotonic();logits, probabilities = infer(row['tokenIds']);elapsed = (time.monotonic()-start)*1000
        predictions.append({'id': row['id'], 'group': row['group'], 'kind': row['kind'],
                            'logits': logits.tolist(), 'probabilities': probabilities.tolist(),
                            'tokens': len(row['tokenIds']), 'milliseconds': elapsed})
    elapsed = sorted(row['milliseconds'] for row in predictions)
    runtime = {'engine': 'onnxruntime-python', 'version': ort.__version__, 'providers': session.get_providers(),
               'originalNodeOrtVersion': metadata['originalOrtVersion'],
               'boundary': 'Python ORT runtime differs from upstream Node worker build; no Node runtime parity claim',
               'intraOpThreads': 4, 'interOpThreads': 1, 'temperature': 1.55}
    summary = {'count': len(predictions), 'turns': sum(row['kind']=='turn' for row in records),
               'steps': sum(row['kind']=='step' for row in records),
               'compactHfIdMatches': sum(row['equal'] for row in diagnostic),
               'loadMs': load_ms, 'warmupMs': warm_ms, 'warmP50Ms': elapsed[len(elapsed)//2],
               'warmP95Ms': elapsed[min(len(elapsed)-1,int(len(elapsed)*.95))], 'warmMaxMs': max(elapsed),
               'runtime': runtime, 'abaExact': aba_exact, 'inferenceCalls': len(records)+4,
               'preparedSha256': digest(prepared), 'assets': metadata['assets']}
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.write_text(json.dumps({'metadata': metadata, 'runtime': runtime, 'preparedSha256': digest(prepared),
                                 'predictions': predictions}, indent=2)+'\n')
    output.chmod(0o600)
    output.with_suffix('.summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    output.with_suffix('.summary.json').chmod(0o600)
    output.with_suffix('.token-diagnostic.json').write_text(json.dumps(diagnostic)+'\n')
    output.with_suffix('.token-diagnostic.json').chmod(0o600)
    print(json.dumps({key: value for key, value in summary.items() if key not in ['assets', 'preparedSha256']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', required=True)
    parser.add_argument('--prepared', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--unseal-final', action='store_true')
    args = parser.parse_args()
    run(args.assets, args.prepared, args.out, unseal_final=args.unseal_final)
