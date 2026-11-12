import { ExecutionStatus, RunStatus } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import {
  executionPresence,
  PRESENCE_EXIT_GRACE_MS,
  PRESENCE_STALE_MS,
  type Presence,
  type PresenceKind,
  runPresence,
  sessionGroupOf,
  sessionPresence,
  settle,
} from '../src/run/presence.ts';

// docs/specs/features/presence.md

type Row = [PresenceKind, Presence['tone'], Presence['glyph']];

const RUN_TABLE: Record<RunStatus, Row> = {
  created: ['starting', 'active', 'queued'],
  validating: ['starting', 'active', 'queued'],
  running: ['working', 'active', 'running'],
  pausing: ['pausing', 'active', 'running'],
  paused: ['paused', 'warning', 'stopped'],
  awaiting_user: ['awaiting_user', 'warning', 'waiting'],
  cancelling: ['stopping', 'active', 'running'],
  succeeded: ['succeeded', 'success', 'done'],
  failed: ['failed', 'danger', 'failed'],
  cancelled: ['cancelled', 'neutral', 'stopped'],
  interrupted: ['interrupted', 'danger', 'failed'],
};

const EXECUTION_TABLE: Record<ExecutionStatus, Row> = {
  queued: ['starting', 'active', 'queued'],
  ready: ['starting', 'active', 'queued'],
  active: ['working', 'active', 'running'],
  waiting_children: ['working', 'active', 'running'],
  waiting_message: ['working', 'active', 'running'],
  waiting_approval: ['awaiting_user', 'warning', 'waiting'],
  pausing: ['pausing', 'active', 'running'],
  paused: ['paused', 'warning', 'stopped'],
  cancelling: ['stopping', 'active', 'running'],
  succeeded: ['succeeded', 'success', 'done'],
  failed: ['failed', 'danger', 'failed'],
  cancelled: ['cancelled', 'neutral', 'stopped'],
};

const SCREEN_NAMES: Record<PresenceKind, [string, string]> = {
  awaiting_user: ['응답 대기', 'Waiting for you'],
  failed: ['실패', 'Failed'],
  interrupted: ['중단됨', 'Interrupted'],
  stopping: ['중지하는 중', 'Stopping'],
  pausing: ['일시정지하는 중', 'Pausing'],
  paused: ['일시정지됨', 'Paused'],
  starting: ['시작하는 중', 'Starting'],
  working: ['작업 중', 'Working'],
  succeeded: ['완료', 'Completed'],
  cancelled: ['취소됨', 'Cancelled'],
  ready: ['실행 전', 'No run yet'],
  empty: ['빈 세션', 'Empty session'],
};

function lookup(catalog: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      (catalog as Record<string, unknown>).Presence,
    );
}

const run = (status: RunStatus) => ({ status });

describe('presence table', () => {
  it('covers every Run status', () => {
    expect(Object.keys(RUN_TABLE).sort()).toEqual([...RunStatus.options].sort());
    for (const status of RunStatus.options) {
      const presence = runPresence(run(status), [], []);
      const [kind, tone, glyph] = RUN_TABLE[status];
      expect({ status, kind: presence.kind, tone: presence.tone, glyph: presence.glyph }).toEqual({
        status,
        kind,
        tone,
        glyph,
      });
    }
  });

  it('covers every Execution status', () => {
    expect(Object.keys(EXECUTION_TABLE).sort()).toEqual([...ExecutionStatus.options].sort());
    for (const status of ExecutionStatus.options) {
      const presence = executionPresence({ status });
      const [kind, tone, glyph] = EXECUTION_TABLE[status];
      expect({ status, kind: presence.kind, tone: presence.tone, glyph: presence.glyph }).toEqual({
        status,
        kind,
        tone,
        glyph,
      });
    }
  });

  it('names each state with the screen name of the spec, in both catalogs', () => {
    const kinds = Object.keys(SCREEN_NAMES) as PresenceKind[];
    for (const kind of kinds) {
      const presence =
        kind === 'ready' || kind === 'empty'
          ? sessionPresence(null, { terminalAttention: false, hasContent: kind === 'ready' })
          : runPresence(
              run(RunStatus.options.find((status) => RUN_TABLE[status][0] === kind) ?? 'running'),
              [],
              [],
            );
      expect(presence.kind).toBe(kind);
      expect(lookup(ko, presence.labelKey)).toBe(SCREEN_NAMES[kind][0]);
      expect(lookup(en, presence.labelKey)).toBe(SCREEN_NAMES[kind][1]);
    }
  });

  it('has the need and detail names of the spec', () => {
    const needs = {
      approval: ['승인', 'Approval'],
      question: ['질문', 'Question'],
      continue: ['계속 여부', 'Continue?'],
    };
    for (const [need, [k, e]] of Object.entries(needs)) {
      expect(lookup(ko, `need.${need}`)).toBe(k);
      expect(lookup(en, `need.${need}`)).toBe(e);
    }
    const details = {
      waiting_agents: ['하위 에이전트 대기', 'Waiting for agents'],
      waiting_reply: ['답 대기', 'Waiting for a reply'],
      watching: ['지켜보는 중', 'Watching'],
    };
    for (const [detail, [k, e]] of Object.entries(details)) {
      expect(lookup(ko, `detail.${detail}`)).toBe(k);
      expect(lookup(en, `detail.${detail}`)).toBe(e);
    }
  });
});

describe('priority', () => {
  it('waits for the person before reporting a failed execution', () => {
    const presence = runPresence(
      run('running'),
      [{ status: 'waiting_approval' }, { status: 'failed' }],
      [],
    );
    expect(presence.kind).toBe('awaiting_user');
    expect(presence.need).toBe('approval');
  });

  it('takes the need of the earliest open request', () => {
    const presence = runPresence(
      run('awaiting_user'),
      [{ status: 'active' }],
      [
        { kind: 'continue', order: 3 },
        { kind: 'question', order: 1 },
        { kind: 'approval', order: 2 },
      ],
    );
    expect(presence.kind).toBe('awaiting_user');
    expect(presence.need).toBe('question');
  });

  it('waits for the person when a request is open on a running Run', () => {
    const presence = runPresence(
      run('running'),
      [{ status: 'active' }],
      [{ kind: 'continue', order: 0 }],
    );
    expect(presence.kind).toBe('awaiting_user');
    expect(presence.need).toBe('continue');
  });

  it('shows a failed execution of a Run in progress', () => {
    expect(runPresence(run('running'), [{ status: 'active' }, { status: 'failed' }], []).kind).toBe(
      'failed',
    );
  });

  it('shows a pause and a cancel as requested, not applied', () => {
    expect(runPresence(run('pausing'), [{ status: 'paused' }], []).kind).toBe('pausing');
    expect(runPresence(run('cancelling'), [{ status: 'cancelled' }], []).kind).toBe('stopping');
    expect(executionPresence({ status: 'pausing' }).kind).not.toBe('paused');
    expect(executionPresence({ status: 'cancelling' }).kind).not.toBe('cancelled');
  });

  it('carries no need outside awaiting_user', () => {
    expect(runPresence(run('running'), [], []).need).toBeUndefined();
  });
});

describe('detail', () => {
  it('names what a working execution waits on', () => {
    const agents = executionPresence({ status: 'waiting_children' });
    expect(agents.detail).toBe('waiting_agents');
    expect(agents.detailKey).toBe('detail.waiting_agents');
    expect(executionPresence({ status: 'waiting_message' }).detail).toBe('waiting_reply');
    expect(executionPresence({ status: 'waiting_message', observer: true }).detail).toBe(
      'watching',
    );
    expect(executionPresence({ status: 'waiting_message', observer: true }).kind).toBe('working');
    expect(executionPresence({ status: 'active' }).detail).toBeUndefined();
    expect(executionPresence({ status: 'active' }).detailKey).toBeUndefined();
  });
});

describe('session', () => {
  const succeeded = runPresence(run('succeeded'), [], []);

  it('is the latest run, or ready or empty without one', () => {
    expect(sessionPresence(succeeded, { terminalAttention: false, hasContent: true })).toEqual(
      succeeded,
    );
    expect(sessionPresence(null, { terminalAttention: false, hasContent: true }).kind).toBe(
      'ready',
    );
    expect(sessionPresence(null, { terminalAttention: true, hasContent: false }).kind).toBe(
      'empty',
    );
    const ready = sessionPresence(null, { terminalAttention: false, hasContent: true });
    expect(ready.glyph).toBeNull();
    expect(ready.tone).toBe('neutral');
  });

  it('maps every state to its group', () => {
    const groups: Record<PresenceKind, string> = {
      awaiting_user: 'attention',
      failed: 'attention',
      interrupted: 'attention',
      paused: 'attention',
      starting: 'running',
      working: 'running',
      pausing: 'running',
      stopping: 'running',
      succeeded: 'completed',
      cancelled: 'cancelled',
      ready: 'ready',
      empty: 'empty',
    };
    for (const [kind, group] of Object.entries(groups)) {
      expect({ kind, group: sessionGroupOf({ kind: kind as PresenceKind }, false) }).toEqual({
        kind,
        group,
      });
    }
  });

  it('needs attention for a terminal to check, whatever the run', () => {
    for (const kind of ['succeeded', 'working', 'cancelled', 'ready', 'empty'] as const)
      expect(sessionGroupOf({ kind }, true)).toBe('attention');
  });
});

describe('settle', () => {
  const working = runPresence(run('running'), [], []);
  const succeeded = runPresence(run('succeeded'), [], []);
  const now = 1_000_000;

  it('exports the spec times', () => {
    expect(PRESENCE_EXIT_GRACE_MS).toBe(2_000);
    expect(PRESENCE_STALE_MS).toBe(60_000);
  });

  it('keeps working for two seconds after a run succeeds', () => {
    const held = settle(working, succeeded, { endedAt: now, now });
    expect(held.presence).toEqual(working);
    expect(held.holdUntil).toBe(now + PRESENCE_EXIT_GRACE_MS);
    const still = settle(working, succeeded, { endedAt: now, now: now + 1_999 });
    expect(still.presence).toEqual(working);
    expect(still.holdUntil).toBe(now + PRESENCE_EXIT_GRACE_MS);
    const after = settle(working, succeeded, { endedAt: now, now: now + 2_000 });
    expect(after.presence).toEqual(succeeded);
    expect(after.holdUntil).toBeNull();
  });

  it('holds starting the same way', () => {
    const starting = runPresence(run('created'), [], []);
    const cancelled = runPresence(run('cancelled'), [], []);
    expect(settle(starting, cancelled, { endedAt: now, now }).presence).toEqual(starting);
  });

  it('moves at once to awaiting_user, failed and interrupted', () => {
    for (const status of ['awaiting_user', 'failed', 'interrupted'] as const) {
      const next = runPresence(run(status), [], []);
      const settled = settle(working, next, { endedAt: now, now });
      expect(settled.presence).toEqual(next);
      expect(settled.holdUntil).toBeNull();
    }
  });

  it('does not hold a run that ended more than a minute ago', () => {
    const settled = settle(working, succeeded, {
      endedAt: now - PRESENCE_STALE_MS - 1,
      now,
    });
    expect(settled.presence).toEqual(succeeded);
    expect(settled.holdUntil).toBeNull();
  });

  it('stays put when work resumes inside the grace', () => {
    const held = settle(working, succeeded, { endedAt: now, now });
    const resumed = settle(held.presence, working, { endedAt: now, now: now + 1_000 });
    expect(resumed.presence).toEqual(working);
    expect(resumed.holdUntil).toBeNull();
  });

  it('does not hold when nothing was in progress', () => {
    const settled = settle(succeeded, runPresence(run('cancelled'), [], []), { endedAt: now, now });
    expect(settled.presence.kind).toBe('cancelled');
    expect(settled.holdUntil).toBeNull();
    const first = settle(null, succeeded, { endedAt: now, now });
    expect(first.presence).toEqual(succeeded);
    expect(first.holdUntil).toBeNull();
  });
});
