"""Bounded CPU-only synthetic lengths and protocol recovery, with no dataset reads."""
import argparse
import json
from pathlib import Path
import subprocess
import time
from transformers import AutoTokenizer
from probe import read_reply, rss, PREFIX

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--kind', choices=['q8', 'q4'], default='q8')
args = parser.parse_args()
root = Path(args.root)
model = root / 'models/eg2-native/fold0'
tokenizer = AutoTokenizer.from_pretrained(model / 'wrapped', local_files_only=True)
p = subprocess.Popen([str(root/'runs/eg2-native/eg2-helper'), str(model/f'encoder-{args.kind}.gguf'), str(model/'head.json'), '4'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
try:
    ready = read_reply(p)
    records = []
    number = 0
    peak = rss(p)
    for target in [64, 128, 256, 512, 1024]:
        words = target
        for _ in range(10):
            text = 'word' + ' word' * (words-1)
            actual = len(tokenizer(PREFIX+text)['input_ids'])
            if actual == target:
                break
            words += target-actual
        assert actual == target
        times = []
        reference = None
        for _ in range(4):
            number += 1
            start = time.monotonic()
            p.stdin.write(json.dumps({'id': number, 'text': text})+'\n');p.stdin.flush()
            result = read_reply(p)
            times.append((time.monotonic()-start)*1000)
            peak = max(peak, rss(p))
            assert len(result['tokens']) == target
            if reference:
                assert reference == result['logits']
            reference = result['logits']
        records.append({'tokens': target, 'firstMs': times[0], 'warmMs': times[1:]})
    # Bad JSON and duplicate IDs must yield a fixed error, then permit the next request.
    for bad in ['{bad-json', json.dumps({'id': number, 'text': 'Inspect the function.'})]:
        p.stdin.write(bad+'\n');p.stdin.flush()
        error = json.loads(p.stdout.readline())
        assert error['type'] == 'error' and error['error'] == 'request_failed'
    number += 1
    p.stdin.write(json.dumps({'id': number, 'text': 'Inspect the function.'})+'\n');p.stdin.flush()
    assert read_reply(p)['type'] == 'result'
    p.stdin.close();p.wait(timeout=15)
    assert p.returncode == 0 and p.stderr.read() == ''
    report = {'kind': args.kind, 'backend': 'cpu', 'threads': 4, 'loadMs': ready['loadMs'], 'peakRssBytes': peak, 'lengths': records, 'repeatedLogitsExact': True, 'invalidAndDuplicateRecovery': True, 'cleanEof': True}
    (root/f'runs/eg2-native/fold0/{args.kind}-latency.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
finally:
    if p.poll() is None:
        p.kill();p.wait()
