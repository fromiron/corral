#!/usr/bin/env python3
"""CPU replay contract regression: explicit truncation, token parity, and isolation."""
import argparse
import json
import os
from pathlib import Path
import subprocess

from probe import read_line
from token_fingerprint import input_token_fingerprint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--helper', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--tokenizer', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer, local_files_only=True)
    command = [args.helper, args.model, '6', '1024']
    env = {key: os.environ[key] for key in ['PATH', 'LD_LIBRARY_PATH'] if key in os.environ}
    env.update({'CUDA_VISIBLE_DEVICES': '-1', 'LC_ALL': 'C'})
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    serial = 0
    report = {'checks': {}, 'parity': []}

    def formatted(task, text):
        instruction = ('Choose the minimum useful reasoning effort for the NEXT coding response, not the total project. Return ONLY low, medium, high, or xhigh.'
                       if task == 'effort' else 'Select who should answer the current message. Return ONLY comma-separated participant IDs, or NONE for explicit silence. If any one responder is acceptable or the invitation is ambiguous, choose exactly one appropriate participant. Honor exclusions. Never infer capabilities from names.')
        return tokenizer.apply_chat_template([{'role': 'system', 'content': instruction}, {'role': 'user', 'content': text}], tokenize=False, add_generation_prompt=True, enable_thinking=False)

    def request(text, op='effort', **extra):
        nonlocal serial
        serial += 1
        process.stdin.write(json.dumps({'id': serial, 'op': op, 'prompt': text, **extra}) + '\n')
        process.stdin.flush()
        result = read_line(process)
        assert result['id'] == serial
        return result

    def assert_parity(result, text, budget=None):
        ids = tokenizer.encode(text, add_special_tokens=False)
        expected = ids if budget is None or len(ids) <= budget else ids[:128] + ids[-(budget - 128):]
        assert result['originalPromptTokens'] == len(ids)
        assert result['usedPromptTokens'] == result['promptTokens'] == len(expected)
        assert result['inputBudget'] == budget
        assert result['inputTruncated'] == (len(expected) != len(ids))
        assert result['inputTokenFingerprintAlgorithm'] == 'fnv1a64-le-u32'
        assert result['inputTokenFingerprint'] == input_token_fingerprint(expected)
        if len(expected) != len(ids):
            assert expected[:128] == ids[:128] and expected[128:] == ids[-(budget - 128):]
            assert input_token_fingerprint(expected) != input_token_fingerprint(ids[:budget])
            assert input_token_fingerprint(expected) != input_token_fingerprint(ids[-budget:])
        report['parity'].append({key: result[key] for key in ['originalPromptTokens', 'usedPromptTokens', 'inputBudget', 'inputTruncated', 'inputTokenFingerprint']})

    try:
        ready = read_line(process)
        assert ready['type'] == 'ready' and ready['backend'] == 'cpu'
        short = formatted('effort', 'Fix a comment. 한국어 설명, 日本語説明, tabs\tand newlines.\r\nKeep the trailing context.')
        long = formatted('effort', 'Inspect the first instruction and preserve the final tool state.\n' + ''.join(f'Tool result {index}: file module_{index}.ts passed test {index % 7}; inspect dependency {index % 11}.\n' for index in range(180)) + 'Final tool state: failing integration test after reconnect; evaluate only the next coding step.')
        assert len(tokenizer.encode(long, add_special_tokens=False)) > 1024
        first_cut = request(long, inputBudget=256)
        assert first_cut['type'] == 'result', 'explicit budget must allow an over-context original input'
        assert_parity(first_cut, long, 256)
        normal = request(short)
        assert normal['type'] == 'result'
        assert_parity(normal, short)
        unchanged = request(short, inputBudget=256)
        assert_parity(unchanged, short, 256)
        assert unchanged['firstLogitsFingerprint'] == normal['firstLogitsFingerprint']
        report['checks']['defaultAndUnderBudgetDoNotTruncate'] = True
        clipped = request(long, inputBudget=256)
        assert clipped['type'] == 'result'
        assert_parity(clipped, long, 256)
        request(formatted('effort', 'Design a consistent distributed recovery protocol.'))
        repeated = request(long, inputBudget=256)
        assert_parity(repeated, long, 256)
        for key in ['firstLogitsFingerprint', 'logits', 'probabilities', 'inputTokenFingerprint']:
            assert clipped[key] == repeated[key]
        report['checks']['clippedAbaIsolated'] = True
        for budget in [129, 1024]:
            result = request(long, inputBudget=budget)
            assert result['type'] == 'result'
            assert_parity(result, long, budget)
        report['checks']['prefixAndTailMatchTrainingCut'] = True
        invalid = request(long)
        assert invalid == {'type': 'error', 'id': serial, 'error': 'input_too_long'}
        report['checks']['noImplicitTruncation'] = True
        for budget in [0, 128, -1, 256.0, True, None, '256', 1025]:
            invalid = request(short, inputBudget=budget)
            assert invalid == {'type': 'error', 'id': serial, 'error': 'invalid_budget'}
        report['checks']['invalidBudgetsRejected'] = True
        meeting = formatted('meeting', 'Participants: p1 (frontend), p2 (database). Current message: p2, please explain the database migration.')
        # Output remains invalid even though the accepted model input is fully auditable.
        invalid = request(meeting, op='meeting', participantIds=['unlisted'], inputBudget=1000)
        assert invalid['type'] == 'error' and invalid['error'] == 'invalid_response'
        assert_parity(invalid, meeting, 1000)
        assert 'raw' not in invalid and 'participantIds' not in invalid
        too_large = request(meeting, op='meeting', participantIds=['p1', 'p2'], inputBudget=1001)
        assert too_large == {'type': 'error', 'id': serial, 'error': 'invalid_budget'}
        report['checks']['meetingOutputReserveEnforced'] = True
        after_invalid = request(short)
        assert after_invalid['firstLogitsFingerprint'] == normal['firstLogitsFingerprint']
        assert_parity(after_invalid, short)
        report['checks']['failedRequestDoesNotChangeNextInput'] = True
        process.stdin.close()
        process.stdin = None
        output, errors = process.communicate(timeout=5)
        assert process.returncode == 0 and output == '' and errors == ''
        report['checks']['cleanEof'] = True
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
    explicit_cpu = subprocess.run(command + ['--backend', 'cpu'], input='', capture_output=True, text=True, env=env, timeout=30)
    assert explicit_cpu.returncode == 0 and explicit_cpu.stderr == ''
    assert json.loads(explicit_cpu.stdout)['backend'] == 'cpu'
    report['checks']['legacyAndExplicitCpuCli'] = True
    Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['checks']))


if __name__ == '__main__':
    main()
