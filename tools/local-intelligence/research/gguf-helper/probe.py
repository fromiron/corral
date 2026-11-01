#!/usr/bin/env python3
"""Explicit opt-in CPU integration probe; output contains no prompt or model path."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import statistics
import subprocess
import time


def read_line(process, timeout=60):
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout):
            raise AssertionError('helper response timed out')
    line = process.stdout.readline()
    if not line:
        raise AssertionError('helper exited without a reply')
    return json.loads(line)


def memory(pid):
    fields = {}
    for line in Path(f'/proc/{pid}/status').read_text().splitlines():
        if line.startswith(('VmRSS:', 'VmHWM:')):
            key, value, _ = line.split()
            fields[key[:-1] + 'Bytes'] = int(value) * 1024
    return fields


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--helper', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--tokenizer', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--repeats', type=int, default=10)
    args = parser.parse_args()
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer, local_files_only=True)
    instructions = {
        'meeting': 'Select who should answer the current message. Return ONLY comma-separated participant IDs, or NONE for explicit silence. If any one responder is acceptable or the invitation is ambiguous, choose exactly one appropriate participant. Honor exclusions. Never infer capabilities from names.',
        'effort': 'Choose the minimum useful reasoning effort for the NEXT coding response, not the total project. Return ONLY low, medium, high, or xhigh.',
    }

    def prompt(task, text):
        return tokenizer.apply_chat_template([
            {'role': 'system', 'content': instructions[task]},
            {'role': 'user', 'content': text},
        ], tokenize=False, add_generation_prompt=True, enable_thinking=False)

    short = prompt('effort', 'Fix the spelling of a comment. The code and tests already pass.')
    other = prompt('effort', 'Diagnose the failed distributed transaction and prove a consistent recovery protocol across process crashes.')
    meeting = prompt('meeting', 'Participants: p1 (frontend), p2 (database). Current message: p2, please explain the database migration.')
    long_text = 'Review the next coding step using these observed tool results.\n'
    while len(tokenizer.encode(prompt('effort', long_text), add_special_tokens=False)) < 350:
        long_text += 'The unit tests pass; the integration test reports a stale transaction after a reconnect. '
    long = prompt('effort', long_text)
    command = [args.helper, args.model, '6', '1024']
    env = {key: os.environ[key] for key in ['PATH', 'LD_LIBRARY_PATH'] if key in os.environ}
    env.update({'CUDA_VISIBLE_DEVICES': '-1', 'LC_ALL': 'C'})
    report = {'purpose': 'synthetic CPU resource and isolation probe, not model quality', 'checks': {}, 'samples': []}
    started = time.monotonic()
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    next_id = 0

    def request(task, text, **extra):
        nonlocal next_id
        next_id += 1
        payload = {'id': next_id, 'op': task, 'prompt': text, **extra}
        started = time.monotonic()
        process.stdin.write(json.dumps(payload) + '\n')
        process.stdin.flush()
        response = read_line(process)
        assert response['id'] == next_id, 'stale or mismatched reply'
        response['wallMs'] = (time.monotonic() - started) * 1000
        return response

    try:
        report['ready'] = read_line(process)
        assert report['ready']['type'] == 'ready'
        assert report['ready']['backend'] == 'cpu'
        label_tokens = [tokenizer.encode(label, add_special_tokens=False)[0] for label in ['low', 'medium', 'high', 'xhigh']]
        assert len(set(label_tokens)) == 4
        assert report['ready']['labelTokenIds'] == label_tokens
        report['checks']['distinctLabelTokensMatchTrainingTokenizer'] = True
        report['startupWallMs'] = (time.monotonic() - started) * 1000
        report['loadedMemory'] = memory(process.pid)
        cold = request('effort', short)
        assert cold['type'] == 'result'
        report['cold'] = cold
        baseline = None
        for iteration in range(args.repeats):
            a = request('effort', short)
            b = request('effort', other)
            a2 = request('effort', short)
            for response in [a, b, a2]:
                assert response['type'] == 'result'
                probabilities = response['probabilities']
                assert len(probabilities) == 4 and all(math.isfinite(p) and 0 <= p <= 1 for p in probabilities)
                assert abs(sum(probabilities) - 1) < 1e-12
            fingerprint = (a['firstLogitsFingerprint'], a['logits'], a['probabilities'])
            assert fingerprint == (a2['firstLogitsFingerprint'], a2['logits'], a2['probabilities']), 'A/B/A state drift'
            if baseline is None:
                baseline = fingerprint
            assert fingerprint == baseline, 'repeated A state drift'
            for size, text in [('short', short), ('long', long)]:
                response = request('effort', text)
                assert response['type'] == 'result'
                report['samples'].append({'size': size, 'promptTokens': response['promptTokens'], 'totalMs': response['totalMs'], 'wallMs': response['wallMs']})
        report['checks']['effortAbaExact'] = args.repeats
        first = request('meeting', meeting, participantIds=['p1', 'p2'])
        assert first['type'] == 'result', first
        request('effort', other)
        second = request('meeting', meeting, participantIds=['p1', 'p2'])
        assert first['participantIds'] == second['participantIds']
        assert first['firstLogitsFingerprint'] == second['firstLogitsFingerprint']
        report['checks']['meetingAbaExact'] = True
        report['meeting'] = first
        # Wrong output domain must not return unvalidated raw text.
        invalid = request('meeting', meeting, participantIds=['unlisted'])
        assert invalid['type'] == 'error' and invalid['error'] == 'invalid_response'
        assert set(invalid) == {'id', 'type', 'error', 'wallMs', 'originalPromptTokens', 'usedPromptTokens', 'promptTokens', 'inputBudget', 'inputTruncated', 'inputTokenFingerprint', 'inputTokenFingerprintAlgorithm'}
        report['checks']['unknownParticipantRejected'] = True
        invalid = request('effort', 'synthetic-secret-' + ('word ' * 3000))
        assert invalid['type'] == 'error' and invalid['error'] == 'input_too_long'
        process.stdin.write(json.dumps({'id': next_id, 'op': 'effort', 'prompt': 'synthetic-secret'}) + '\n')
        process.stdin.flush()
        invalid = read_line(process)
        assert invalid['error'] == 'stale_id'
        process.stdin.write('{invalid-json-synthetic-secret}\n')
        process.stdin.flush()
        invalid = read_line(process)
        assert invalid == {'type': 'error', 'id': None, 'error': 'invalid_request'}
        after_invalid = request('effort', short)
        assert (after_invalid['firstLogitsFingerprint'], after_invalid['logits'], after_invalid['probabilities']) == baseline
        report['checks']['invalidThenValidIsolated'] = True
        report['checks']['staleIdRejected'] = True
        report['memoryAfterWarm'] = memory(process.pid)
        next_id += 1
        process.stdin.write(json.dumps({'id': next_id, 'op': 'effort', 'prompt': long}) + '\n')
        process.stdin.flush()
        time.sleep(.02)
        started = time.monotonic()
        process.kill()
        output, errors = process.communicate(timeout=5)
        assert process.returncode == -9 and output == '' and errors == ''
        report['checks']['killInFlightNoLateReply'] = True
        report['killMs'] = (time.monotonic() - started) * 1000
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
    early = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    time.sleep(.01)
    early.kill()
    output, errors = early.communicate(timeout=5)
    assert early.returncode == -9 and output == '' and errors == ''
    report['checks']['killDuringStartupNoReady'] = True
    missing = subprocess.run([args.helper, '/nonexistent/synthetic-secret', '6', '1024'], capture_output=True, text=True, env=env, timeout=10)
    assert missing.returncode != 0 and 'synthetic-secret' not in (missing.stdout + missing.stderr)
    assert json.loads(missing.stdout) == {'type': 'error', 'id': None, 'error': 'startup_failed'}
    report['checks']['startupErrorRedacted'] = True
    eof = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    assert read_line(eof)['type'] == 'ready'
    output, errors = eof.communicate(json.dumps({'id': 1, 'op': 'effort', 'prompt': short}) + '\n', timeout=60)
    assert eof.returncode == 0 and errors == ''
    completed = json.loads(output)
    assert completed['id'] == 1 and completed['type'] == 'result'
    assert (completed['firstLogitsFingerprint'], completed['logits'], completed['probabilities']) == baseline
    report['checks']['cleanEofCompletesAcceptedRequest'] = True
    report['latency'] = {}
    for size in ['short', 'long']:
        samples = sorted(row['wallMs'] for row in report['samples'] if row['size'] == size)
        report['latency'][size] = {'count': len(samples), 'medianMs': statistics.median(samples), 'p95Ms': samples[math.ceil(len(samples) * .95) - 1], 'maxMs': max(samples)}
    report['modelBytes'] = Path(args.model).stat().st_size
    report['modelSha256'] = hashlib.file_digest(Path(args.model).open('rb'), 'sha256').hexdigest()
    out = Path(args.out)
    out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ['checks', 'latency', 'memoryAfterWarm']}))


if __name__ == '__main__':
    main()
