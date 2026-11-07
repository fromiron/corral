import { describe, expect, it } from 'vitest';
import { runFlowChecks } from './runFlowChecks.ts';

const check = (id: string, runId: string) => ({
  verificationId: id,
  name: 'Targeted tests',
  report: {
    owner: {
      kind: 'execution' as const,
      runId,
      executionId: 'exec_writer',
      attemptNo: 1,
      effectId: 'effect_check',
    },
    state: 'completed' as const,
    verdict: 'fail' as const,
    exitCode: 1,
    timedOut: false,
  },
  output: 'Do not copy raw check output into flow metadata',
});

describe('flow check evidence ownership', () => {
  it('includes the named metadata for the exact recorded report only', () => {
    expect(
      runFlowChecks([check('used', 'run_one'), check('unused', 'run_one')], 'run_one', ['used']),
    ).toEqual([
      {
        id: 'used',
        name: 'Targeted tests',
        state: 'completed',
        verdict: 'fail',
        exitCode: 1,
        timedOut: false,
      },
    ]);
  });
  it('does not link another run or an ownerless legacy report even when its identifier matches', () => {
    expect(
      runFlowChecks(
        [
          check('foreign', 'run_two'),
          { verificationId: 'legacy', name: 'Legacy check', report: null },
        ],
        'run_one',
        ['foreign', 'legacy'],
      ),
    ).toEqual([]);
  });
});
