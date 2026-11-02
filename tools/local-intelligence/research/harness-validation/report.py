#!/usr/bin/env python3
"""Summarize only this harness slice; never inspect other experiments or final sets."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics

from run import CASES, EFFORTS, save


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve() / 'outcomes/harness'
    rows = []
    for case_id in CASES:
        for effort in EFFORTS:
            path = root / 'trials' / case_id / effort / 'receipt.json'
            receipt = json.loads(path.read_text())
            harness = receipt['harness']
            usage = harness['usage']
            sums = {}
            for key in ('inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens'):
                values = [row['normalized'][key] for row in usage]
                sums[key] = sum(values) if all(value is not None for value in values) else None
            rows.append({
                'id': case_id, 'effort': effort, 'passed': receipt['passed'],
                'status': harness['status'], 'runId': harness['runId'],
                'wallSeconds': harness['wallMs'] / 1000,
                'physicalProviderRequests': harness['physicalProviderRequests'],
                'serializedRequests': harness['serializedRequests'],
                'tools': harness['toolsExecuted'], 'usage': sums,
                'wireVerified': harness['wireVerified'], 'oauthVerified': harness['oauthVerified'],
                'testsUnmodified': harness['testsUnmodified'],
                'finalGrade': receipt['grade'],
                'registeredChecks': [
                    {key: item['report'].get(key) for key in ('state', 'verdict', 'exitCode', 'cleanupConfirmed', 'targetUnchanged')}
                    for item in harness['checks'] if item.get('report')
                ],
                'receiptHash': hashlib.sha256(path.read_bytes()).hexdigest(),
                'driverHash': receipt['driverHash'], 'sourceHash': receipt['sourceHash'],
                'checkHash': receipt['checkHash'], 'runtimeHashes': harness['runtimeHashes'],
            })
    by_effort = {}
    for effort in EFFORTS:
        selected = [row for row in rows if row['effort'] == effort]
        by_effort[effort] = {
            'passed': sum(row['passed'] for row in selected), 'total': len(selected),
            'physicalProviderRequests': sum(row['physicalProviderRequests'] for row in selected),
            'medianWallSeconds': statistics.median(row['wallSeconds'] for row in selected),
            'totalWallSeconds': sum(row['wallSeconds'] for row in selected),
            'usage': {key: sum(row['usage'][key] for row in selected)
                      if all(row['usage'][key] is not None for row in selected) else None
                      for key in selected[0]['usage']},
        }
    checks = Counter(check['verdict'] for row in rows for check in row['registeredChecks'])
    helper_path = root / 'check-helper-verification/results.json'
    helper_checks = json.loads(helper_path.read_text()) if helper_path.exists() else []
    report = {
        'scope': 'five authored development coding fixtures, visible tests, real Corral Coordinator and broker tools',
        'model': 'gpt-6.1-sol', 'provider': 'openai-codex', 'auth': 'oauth',
        'caseIds': list(CASES), 'byEffort': by_effort, 'registeredCheckVerdicts': dict(checks),
        'allWiresVerified': all(row['wireVerified'] for row in rows),
        'allOAuthVerified': all(row['oauthVerified'] for row in rows),
        'allTestsUnmodified': all(row['testsUnmodified'] for row in rows),
        'physicalProviderRequests': sum(row['physicalProviderRequests'] for row in rows),
        'measuredDriverHashes': sorted({row['driverHash'] for row in rows}),
        'currentDriverHash': hashlib.sha256((Path(__file__).parent / 'driver.ts').read_bytes()).hexdigest(),
        'offlineCorrectedHelperChecks': helper_checks,
        'rows': rows,
        'limitations': [
            'Five development fixtures and one repeat do not select an optimal effort policy.',
            'Tests were visible; this is separate from hidden-test next-response evaluation.',
            'SDK worker is a strict brokered process, not an OS-sandboxed worker.',
            'Registered fixture helper and final grader use bubblewrap without network/home access.',
            'Recorded Python checks were inconclusive because bytecode writes altered the check copy; independent immutable final grade is authoritative. The corrected -B helper was verified offline without new model calls.',
            'Measured wall time includes tool execution, provider latency, and any repeated inconclusive checks.',
            'No meeting selection or sealed final cases were evaluated.',
        ],
    }
    save(root / 'report.json', report)
    text = ['# Real Corral coding harness development smoke', '',
            'Five authored development fixtures; visible tests; one run per medium/high condition.', '',
            '| Effort | Final grade | Provider requests | Median wall seconds | Input tokens | Output tokens | Cached input |',
            '|---|---:|---:|---:|---:|---:|---:|']
    for effort, result in by_effort.items():
        usage = result['usage']
        text.append(f"| {effort} | {result['passed']}/{result['total']} | {result['physicalProviderRequests']} | {result['medianWallSeconds']:.2f} | {usage['inputTokens']} | {usage['outputTokens']} | {usage['cachedInputTokens']} |")
    text.extend(['', f"All serialized efforts and OAuth profiles verified: {report['allWiresVerified'] and report['allOAuthVerified']}.",
                 f"Original tests unchanged: {report['allTestsUnmodified']}. Registered check verdicts: {dict(checks)}.", '',
                 f"Corrected helper offline checks: {len(helper_checks)}; all clean and passed: {bool(helper_checks) and all(item['exitCode'] == 0 and item['cleanTree'] for item in helper_checks)}.", '',
                 '## Scope and limits', ''])
    text.extend(f'- {limitation}' for limitation in report['limitations'])
    (root / 'report.md').write_text('\n'.join(text) + '\n')
    (root / 'report.md').chmod(0o600)
    print(json.dumps({key: report[key] for key in ('byEffort', 'physicalProviderRequests', 'registeredCheckVerdicts')}))


if __name__ == '__main__':
    main()
