import type { RunEvent } from '@corral/contracts';
import { applyEvent, emptyProjection } from '@corral/core';
import { describe, expect, it } from 'vitest';
import { compareRuns } from '../src/run/compare.ts';
import { projectionWith } from '../src/stories/fixtures.tsx';

// Roadmap 16: two runs side by side, on the figures the eval report uses.

const calls = (tokens: number[]) =>
  Object.fromEntries(
    tokens.map((outputTokens, index) => [
      `call_${index}`,
      { modelCallId: `call_${index}`, executionId: 'e', finished: true, usage: { outputTokens } },
    ]),
  ) as never;

const run = (overrides: Parameters<typeof projectionWith>[0]) =>
  projectionWith({
    status: 'succeeded',
    mode: 'live',
    startedAt: '2026-10-16T00:00:00.000Z',
    endedAt: '2026-10-16T00:00:30.000Z',
    ...overrides,
  });

describe('compareRuns', () => {
  it('lines up status, time, calls, tokens, rounds and models, and marks what differs', () => {
    const a = run({
      runId: 'run_a',
      modelCalls: calls([200, 200, 200, 200, 200, 200]),
      modelProfiles: {
        'model-a': { profile: 'model-a', provider: 'openai', modelId: 'gpt-a', auth: 'api_key' },
      },
      iterations: {
        i1: {
          iterationId: 'i1',
          loopNodeId: 'l',
          no: 1,
          criteriaVersionId: 'c',
          parentIterationId: null,
          outcome: 'revise',
        },
        i2: {
          iterationId: 'i2',
          loopNodeId: 'l',
          no: 2,
          criteriaVersionId: 'c',
          parentIterationId: null,
          outcome: 'pass',
        },
      },
    });
    const b = run({
      runId: 'run_b',
      endedAt: '2026-10-16T00:01:15.000Z',
      modelCalls: calls([100, 100, 100, 100, 200, 200]),
      modelProfiles: {
        'model-a': { profile: 'model-a', provider: 'openai', modelId: 'gpt-b', auth: 'api_key' },
      },
    });
    const rows = Object.fromEntries(compareRuns(a, b).map((r) => [r.key, r]));
    expect(rows.elapsed).toMatchObject({ a: 30_000, b: 75_000, differs: true });
    expect(rows.modelCalls).toMatchObject({ a: 6, b: 6, differs: false });
    expect(rows.outputTokens).toMatchObject({ a: 1_200, b: 800, differs: true });
    expect(rows.reviewRounds).toMatchObject({ a: 2, b: 0, differs: true });
    expect(rows.models).toMatchObject({
      a: 'model-a: openai/gpt-a',
      b: 'model-a: openai/gpt-b',
      differs: true,
    });
  });

  it('counts only the decisions a person made, not approvals the runtime closed', () => {
    let seq = 0;
    const envelope = (actor: 'user' | 'runtime') => ({
      schemaVersion: '0.1',
      eventId: `evt_${++seq}`,
      runId: 'run_a',
      runSeq: seq,
      recordedAt: '2026-10-16T00:00:00.000Z',
      causedByEventIds: [],
      actor: { kind: actor, id: actor === 'user' ? 'local_user' : 'coordinator' },
    });
    const asked = (approvalId: string) =>
      ({
        ...envelope('runtime'),
        type: 'approval.requested',
        payload: {
          approvalId,
          kind: 'user_action',
          subjectVersionIds: ['v1'],
          criteriaVersionId: null,
        },
      }) as RunEvent;
    const closed = (
      approvalId: string,
      actor: 'user' | 'runtime',
      decision: 'approve' | 'reject',
      reason?: string,
    ) =>
      ({
        ...envelope(actor),
        type: 'approval.resolved',
        payload: {
          approvalId,
          decision,
          actor: actor === 'user' ? 'local_user' : 'coordinator',
          subjectVersionIds: ['v1'],
          ...(reason ? { reason } : {}),
        },
      }) as RunEvent;
    const replay = (events: RunEvent[]) => {
      const projection = events
        .map((event, index) => ({ ...event, runSeq: index + 1 }))
        .reduce(applyEvent, emptyProjection('run_a'));
      return { ...run({ runId: 'run_a' }), approvals: projection.approvals };
    };
    // A cancelled run whose two approvals the runtime closed: the person decided nothing.
    const cancelled = replay([
      asked('a1'),
      asked('a2'),
      closed('a1', 'runtime', 'reject', 'cancelled'),
      closed('a2', 'runtime', 'reject', 'cancelled'),
    ]);
    // One call allowed for the run: the two waiting like it pass with it, still one decision.
    const allowed = replay([
      asked('a1'),
      asked('a2'),
      asked('a3'),
      closed('a1', 'user', 'approve'),
      closed('a2', 'runtime', 'approve', 'allowed_for_run'),
      closed('a3', 'runtime', 'approve', 'allowed_for_run'),
    ]);
    const row = compareRuns(cancelled, allowed).find((r) => r.key === 'approvals');
    expect(row).toMatchObject({ a: 0, b: 1 });
    expect(Object.values(allowed.approvals).map((a) => a.resolvedBy)).toEqual([
      'person',
      'runtime',
      'runtime',
    ]);
  });

  it('an unfinished run has no elapsed time rather than a made-up one', () => {
    const a = run({ runId: 'run_a', status: 'running', endedAt: null });
    const b = run({ runId: 'run_b' });
    const elapsed = compareRuns(a, b).find((r) => r.key === 'elapsed');
    expect(elapsed).toMatchObject({ a: null, b: 30_000 });
  });
});
