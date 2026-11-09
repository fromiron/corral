import type { VerificationResultView } from '@corral/client';
import { describe, expect, it } from 'vitest';
import { fixRequestText, outputSummary } from './checkFixRequest.ts';

const failed = (output: string): VerificationResultView => ({
  verificationId: 'verification_1',
  commandId: 'check_1',
  name: 'Unit tests',
  argv: ['pnpm', 'test'],
  tree: 'a'.repeat(40),
  state: 'failed',
  exitCode: 1,
  signal: null,
  timedOut: false,
  durationMs: 1200,
  output,
  startedAt: '2026-11-10T00:00:00.000Z',
  endedAt: '2026-11-10T00:00:01.200Z',
  stale: false,
});

describe('fix request summary', () => {
  it('keeps short output whole', () => {
    expect(outputSummary('one\ntwo\n')).toEqual({ text: 'one\ntwo', shown: 2, total: 2 });
  });

  it('keeps the last lines of long output', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const summary = outputSummary(lines.join('\n'), { lines: 40 });
    expect(summary.shown).toBe(40);
    expect(summary.total).toBe(100);
    expect(summary.text.split('\n')[0]).toBe('line 61');
    expect(summary.text.endsWith('line 100')).toBe(true);
  });

  it('caps the characters on whole lines, and cuts one long line at the cap', () => {
    const summary = outputSummary(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('\n'), {
      chars: 70,
    });
    expect(summary.text).toBe(`${'b'.repeat(30)}\n${'c'.repeat(30)}`);
    expect(outputSummary('x'.repeat(500), { chars: 100 }).text).toHaveLength(100);
  });

  it('names the check, its command and result with the summary', () => {
    const text = fixRequestText(failed('ok 1\nnot ok 2 - adds numbers\n'));
    expect(text).toContain('"Unit tests"');
    expect(text).toContain('pnpm test');
    expect(text).toContain('Exit code: 1');
    expect(text).toContain('not ok 2 - adds numbers');
    expect(fixRequestText({ ...failed(''), timedOut: true, exitCode: null })).toContain(
      'Timed out',
    );
  });
});
