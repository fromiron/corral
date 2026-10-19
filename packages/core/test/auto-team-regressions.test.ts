import type { AgentHost, AgentStartInput } from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  autoDefinition,
  Coordinator,
  createAutoStarter,
  emptyProjection,
  InMemoryRunStore,
  InProcessTransport,
  parseAutoRoute,
  type RouteAnswer,
  waitForProjection,
} from '../src/index.ts';

const request = (commandId: string) => ({
  commandId,
  sessionId: 'session_one',
  brief: 'Write a report answering the original question.',
  mode: 'mock' as const,
  choice: { modelProfile: 'model-a' },
});
const answer: RouteAnswer = {
  ok: true,
  text: '{"template":"single","reason":"Direct."}',
  usage: { inputTokens: 100, outputTokens: 50 },
};
async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
function setup() {
  const store = new InMemoryRunStore();
  let host: AgentHost | undefined;
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    store,
    agents: {
      async start(_input, nextHost) {
        host = nextHost;
        let settle!: (result: { outcome: 'cancelled' }) => void;
        const done = new Promise<{ outcome: 'cancelled' }>((resolve) => {
          settle = resolve;
        });
        return {
          cancel: async () => settle({ outcome: 'cancelled' }),
          waitForSettlement: () => done,
        };
      },
    },
  });
  let calls = 0;
  const starter = (route: () => Promise<RouteAnswer> = async () => answer) =>
    createAutoStarter({
      startRun: (r) => coordinator.startRun(r),
      previousStart: (id, requestHash) => {
        const previous = coordinator.startResult(id, requestHash);
        return previous
          ? {
              ...previous,
              autoRoute: previous.runId
                ? (coordinator.getRunSnapshot(previous.runId)?.autoRoute ?? null)
                : null,
            }
          : null;
      },
      route: () => {
        calls++;
        return route();
      },
    });
  return {
    coordinator,
    store,
    clock,
    starter,
    calls: () => calls,
    host: () => {
      if (!host) throw new Error('agent has not started');
      return host;
    },
  };
}

describe('auto run regressions (CR-024)', () => {
  it('keeps router model calls in the budget after an absolute limit patch and event replay', async () => {
    const s = setup();
    const started = await s.starter().start(request('cmd_calls'), { fileTools: false });
    const runId = started.runId ?? '';
    await drain();
    const receipt = s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cmd_cap',
      runId,
      type: 'patch',
      expectedControlRevision: 0,
      payload: { kind: 'run_limits', changes: { maxModelCalls: 1 } },
    });
    expect(receipt.status).toBe('applied');
    await expect(s.host().prepareModelRequest()).rejects.toThrow();
    const replay = s.store.readEvents(runId, 0).reduce(applyEvent, emptyProjection(runId));
    expect(replay.budget.modelCalls).toBe(1);
    expect(replay.budget.spent).toBe(50);
    expect(replay.budget).toEqual(s.coordinator.getSnapshot(runId).projection.budget);
  });

  it('keeps router output tokens in the budget when the output limit is replaced', async () => {
    const s = setup();
    const started = await s.starter().start(request('cmd_tokens'), { fileTools: false });
    const runId = started.runId ?? '';
    await drain();
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cmd_tokens_cap',
      runId,
      type: 'patch',
      expectedControlRevision: 0,
      payload: { kind: 'run_limits', changes: { maxOutputTokens: 100 } },
    });
    expect((await s.host().prepareModelRequest()).maxOutputTokens).toBe(50);
  });

  it('retains missing router usage as an unknown reservation, including failed choices', async () => {
    for (const result of [
      { ok: true, text: answer.ok ? answer.text : '', usage: null },
      { ok: false, reason: 'timeout' },
    ] as const) {
      const s = setup();
      const started = await s
        .starter(async () => result)
        .start(request('cmd_unknown'), { fileTools: false });
      expect(s.coordinator.getSnapshot(started.runId ?? '').projection.budget).toMatchObject({
        modelCalls: 1,
        spent: 0,
        reserved: 0,
        unknownOutstanding: 256,
      });
    }
  });

  it('retains known usage even when the router reports an error', async () => {
    const s = setup();
    const started = await s
      .starter(async () => ({
        ok: false,
        reason: 'model_error',
        usage: { inputTokens: 10, outputTokens: 35 },
      }))
      .start(request('cmd_failed_usage'), { fileTools: false });
    expect(started.autoRoute?.usage).toEqual({ inputTokens: 10, outputTokens: 35 });
    expect(s.coordinator.getSnapshot(started.runId ?? '').projection.budget).toMatchObject({
      modelCalls: 1,
      spent: 35,
      unknownOutstanding: 0,
    });
  });

  it('gives the auto reviewer the original brief as well as the draft and criteria', async () => {
    const inputs: AgentStartInput[] = [];
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({
        turns: 1,
        review: () => 'pass',
        script: async (input) => {
          inputs.push(input);
          return null;
        },
      }),
    });
    const brief = 'Explain why checkout throws a 409; do not redesign checkout.';
    const definition = autoDefinition({
      id: 'auto_review_brief',
      template: 'write_review',
      brief,
      choice: { modelProfile: 'model-a' },
      fileTools: false,
    });
    const started = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_review_brief',
      definition,
      mode: 'mock',
    });
    await waitForProjection(
      new InProcessTransport(coordinator),
      started.runId ?? '',
      (p) => p.status === 'succeeded',
    );
    const reviewer = inputs.find((input) => input.role.id === 'reviewer');
    expect(reviewer?.inputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'brief', text: brief })]),
    );
  });

  it('rejects a different payload while the same command is still choosing', async () => {
    const s = setup();
    let release!: (value: RouteAnswer) => void;
    const starter = s.starter(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const original = request('cmd_pending');
    const first = starter.start(original, { fileTools: false });
    const changed = starter.start(
      { ...original, choice: { modelProfile: 'model-b' } },
      { fileTools: false },
    );
    release(answer);
    const [a, b] = await Promise.all([first, changed]);
    expect(a.runId).not.toBeNull();
    expect(b.runId).toBeNull();
    expect(b.receipt.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(s.calls()).toBe(1);
  });

  it('rejects changed completed payloads after recreating the starter', async () => {
    const s = setup();
    const original = request('cmd_stored');
    const first = await s.starter().start(original, { fileTools: false });
    const retry = await s.starter().start(original, { fileTools: true });
    expect(retry.runId).toBe(first.runId);
    for (const changed of [
      { ...original, sessionId: 'session_two' },
      { ...original, brief: 'Do a different task.' },
      { ...original, mode: 'live' as const },
      { ...original, choice: { modelProfile: 'model-b' } },
      { ...original, references: [{ kind: 'file' as const, path: 'other.ts' }] },
    ]) {
      const result = await s.starter().start(changed, { fileTools: false });
      expect(result.runId).toBeNull();
      expect(result.receipt.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    }
    expect(s.calls()).toBe(1);
  });

  it('falls back only the reasoning when its value has the wrong type or size', () => {
    for (const reasoning of [null, 42, true, 'a'.repeat(21), {}, []]) {
      expect(
        parseAutoRoute(
          JSON.stringify({ template: 'write_review', reason: 'Review it.', reasoning }),
          ['low', 'medium', 'high'],
        ),
      ).toEqual({ template: 'write_review', reason: 'Review it.', reasoning: null });
    }
  });

  it('does not start a local choice after cancellation', async () => {
    const signal = { aborted: false };
    let starts = 0;
    const starter = createAutoStarter({
      startRun: (r) => {
        starts++;
        throw new Error(r.commandId);
      },
    });
    const started = starter.start(request('cmd_local_abort'), { fileTools: false, signal });
    signal.aborted = true;
    await expect(started).rejects.toThrow('cancelled');
    expect(starts).toBe(0);
  });

  it('forwards cancellation to an asynchronous start adapter', async () => {
    const signal = { aborted: false };
    const starter = createAutoStarter({
      startRun: (_r, received) => {
        expect(received).toBe(signal);
        throw new Error('start adapter received signal');
      },
    });
    await expect(
      starter.start(request('cmd_forward_abort'), { fileTools: false, signal }),
    ).rejects.toThrow('start adapter received signal');
  });

  it('preserves idempotency for a recorded refusal that has no run snapshot', async () => {
    const s = setup();
    const original = {
      ...request('cmd_refused'),
      references: [{ kind: 'run' as const, runId: 'run_missing' }],
    };
    const first = await s.starter().start(original, { fileTools: false });
    expect(first.receipt.error?.code).toBe('TARGET_NOT_FOUND');
    expect(first.runId).toBeNull();
    expect(await s.starter().start(original, { fileTools: false })).toEqual(first);
    const changed = await s
      .starter()
      .start({ ...original, brief: 'Changed request' }, { fileTools: false });
    expect(changed.receipt.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(s.calls()).toBe(1);
  });
});

describe('durable cancellation before starting an auto run', () => {
  it('[TC-AUTO-003-N] the final start boundary respects a saved cancellation and its session', () => {
    const s = setup();
    const original = request('cmd_cancel_before_commit');
    const stopped = s.coordinator.cancelAutoStart(original.commandId, original.sessionId);
    expect(stopped.receipt.status).toBe('cancelled');
    expect(s.coordinator.cancelAutoStart(original.commandId, original.sessionId)).toEqual(stopped);
    const start = {
      schemaVersion: '0.1' as const,
      commandId: original.commandId,
      sessionId: original.sessionId,
      mode: original.mode,
      definition: autoDefinition({
        id: 'auto_test',
        template: 'single',
        brief: original.brief,
        choice: original.choice,
        fileTools: false,
      }),
    };
    expect(s.coordinator.startRun(start)).toEqual(stopped);
    expect(
      s.coordinator.startRun({ ...start, sessionId: 'session_other' }).receipt.error?.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(s.coordinator.listRuns()).toHaveLength(0);
  });

  it('[TC-AUTO-003-N] a failed cancellation write is not acknowledged as cancelled', () => {
    const s = setup();
    s.store.putCommand = () => {
      throw new Error('test write failure');
    };
    const result = s.coordinator.cancelAutoStart('cmd_cancel_storage', 'session_one');
    expect(result.receipt.status).toBe('rejected');
    expect(result.receipt.error?.code).toBe('STORAGE_UNAVAILABLE');
    expect(s.coordinator.admitting).toBe(false);
    expect(s.coordinator.hasStartCommand('cmd_cancel_storage')).toBe(false);
  });
});
