import { ExecutionStatus, RunStatus } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import {
  executionPresence,
  PRESENCE_EXIT_GRACE_MS,
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

  it('leaves a failed or cancelled execution to its own row while the Run goes on', () => {
    expect(runPresence(run('running'), [{ status: 'failed' }, { status: 'active' }], []).kind).toBe(
      'working',
    );
    expect(runPresence(run('running'), [{ status: 'cancelled' }], []).kind).toBe('working');
  });

  it('waits for the person before showing a pause in progress', () => {
    const presence = runPresence(run('pausing'), [{ status: 'waiting_approval' }], []);
    expect(presence.kind).toBe('awaiting_user');
    expect(presence.need).toBe('approval');
  });

  it('follows an ended Run over a leftover approval or request', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
      const presence = runPresence(
        run(status),
        [{ status: 'waiting_approval' }],
        [{ kind: 'question', order: 0 }],
      );
      expect({ status, kind: presence.kind, need: presence.need }).toEqual({
        status,
        kind: RUN_TABLE[status][0],
        need: undefined,
      });
    }
  });

  it('shows a pause and a cancel as requested, not applied', () => {
    expect(runPresence(run('pausing'), [{ status: 'paused' }], []).kind).toBe('pausing');
    expect(runPresence(run('cancelling'), [{ status: 'cancelled' }], []).kind).toBe('stopping');
    expect(executionPresence({ status: 'pausing' }).kind).not.toBe('paused');
    expect(executionPresence({ status: 'cancelling' }).kind).not.toBe('cancelled');
  });

  it('waits on continue when the Run waits with nothing open', () => {
    const presence = runPresence(run('awaiting_user'), [], []);
    expect(presence.kind).toBe('awaiting_user');
    expect(presence.need).toBe('continue');
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
  const starting = runPresence(run('created'), [], []);
  const succeeded = runPresence(run('succeeded'), [], []);
  const cancelled = runPresence(run('cancelled'), [], []);
  const now = 1_000_000;

  it('exports the spec grace', () => {
    expect(PRESENCE_EXIT_GRACE_MS).toBe(2_000);
  });

  it('holds working until two seconds after the run ended', () => {
    const held = settle(working, succeeded, { endedAt: now - 1_999, now });
    expect(held.presence).toEqual(working);
    expect(held.holdUntil).toBe(now - 1_999 + PRESENCE_EXIT_GRACE_MS);
    for (const elapsed of [2_000, 2_001]) {
      const settled = settle(working, succeeded, { endedAt: now - elapsed, now });
      expect({ elapsed, presence: settled.presence, holdUntil: settled.holdUntil }).toEqual({
        elapsed,
        presence: succeeded,
        holdUntil: null,
      });
    }
  });

  it('holds starting into cancelled the same way', () => {
    const held = settle(starting, cancelled, { endedAt: now, now });
    expect(held.presence).toEqual(starting);
    expect(held.holdUntil).toBe(now + PRESENCE_EXIT_GRACE_MS);
  });

  it('shows every other change at once', () => {
    const others = [
      runPresence(run('pausing'), [], []),
      runPresence(run('cancelling'), [], []),
      runPresence(run('paused'), [], []),
      runPresence(run('awaiting_user'), [], []),
      runPresence(run('failed'), [], []),
      runPresence(run('interrupted'), [], []),
      sessionPresence(null, { terminalAttention: false, hasContent: true }),
      sessionPresence(null, { terminalAttention: false, hasContent: false }),
    ];
    for (const next of others)
      for (const endedAt of [now, undefined]) {
        const settled = settle(working, next, { endedAt, now });
        expect({ kind: next.kind, endedAt, ...settled }).toEqual({
          kind: next.kind,
          endedAt,
          presence: next,
          holdUntil: null,
          since: null,
        });
      }
  });

  it('counts from first sight when the end is unknown, without moving the end', () => {
    const first = settle(working, succeeded, { now });
    expect(first.presence).toEqual(working);
    expect(first.holdUntil).toBe(now + PRESENCE_EXIT_GRACE_MS);
    expect(first.since).toBe(now);
    let since = first.since;
    for (const at of [now + 500, now + 1_000, now + 1_500, now + 1_999]) {
      const again = settle(working, succeeded, { since, now: at });
      expect(again.presence).toEqual(working);
      expect(again.holdUntil).toBe(now + PRESENCE_EXIT_GRACE_MS);
      since = again.since;
    }
    const released = settle(working, succeeded, { since, now: first.holdUntil ?? 0 });
    expect(released.presence).toEqual(succeeded);
    expect(released.holdUntil).toBeNull();
  });

  it('ends the hold when work starts again', () => {
    const held = settle(working, succeeded, { endedAt: now, now });
    for (const next of [working, starting]) {
      const resumed = settle(held.presence, next, { endedAt: now, now: now + 1_000 });
      expect(resumed.presence).toEqual(next);
      expect(resumed.holdUntil).toBeNull();
    }
  });

  it('does not hold when nothing was in progress', () => {
    const settled = settle(succeeded, cancelled, { endedAt: now, now });
    expect(settled.presence).toEqual(cancelled);
    expect(settled.holdUntil).toBeNull();
    const first = settle(null, succeeded, { endedAt: now, now });
    expect(first.presence).toEqual(succeeded);
    expect(first.holdUntil).toBeNull();
  });
});
