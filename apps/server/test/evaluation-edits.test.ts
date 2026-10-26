import { expect, it, vi } from 'vitest';
import { evaluateCodingTools } from '../src/index.ts';

it('compares three edit methods through the real broker with fresh identical copies', async () => {
  const hashline = vi.fn(async () => 'alpha\nchanged\n');
  const report = await evaluateCodingTools(
    {
      schemaVersion: '0.1',
      kind: 'coding_tools',
      fixtures: [
        {
          id: 'line',
          before: 'alpha\nbeta\n',
          expected: 'alpha\nchanged\n',
          edits: [{ oldText: 'beta', newText: 'changed' }],
          hashlinePatch: '[fixture.txt#{tag}]\nPUT 2.=2:\n+changed',
        },
      ],
    },
    { signal: new AbortController().signal, hashline },
  );
  expect(report.results.map((row) => [row.method, row.status, row.correct])).toEqual([
    ['full_write', 'applied', true],
    ['pi_edit', 'applied', true],
    ['hashline', 'applied', true],
  ]);
  expect(new Set(report.results.map((row) => row.baseCommit)).size).toBe(1);
  expect(hashline).toHaveBeenCalledTimes(1);
});
it('stale source protection applies equally before any transformer is called', async () => {
  const hashline = vi.fn(async () => 'wrong');
  const report = await evaluateCodingTools(
    {
      schemaVersion: '0.1',
      kind: 'coding_tools',
      fixtures: [
        {
          id: 'stale',
          before: 'alpha\n',
          expected: 'beta\n',
          changedBeforeApply: 'outside change\n',
          edits: [{ oldText: 'alpha', newText: 'beta' }],
          hashlinePatch: '[fixture.txt#{tag}]\nPUT 1.=1:\n+beta',
        },
      ],
    },
    { signal: new AbortController().signal, hashline },
  );
  expect(report.results).toHaveLength(3);
  expect(
    report.results.every((row) => row.status === 'refused' && row.correct && row.unchanged),
  ).toBe(true);
  expect(hashline).not.toHaveBeenCalled();
});
