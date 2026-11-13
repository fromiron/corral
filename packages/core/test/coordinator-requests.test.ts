import type {
  AgentAdapter,
  AgentHost,
  AgentSettlement,
  RunCommand,
  RunEvent,
} from '@corral/contracts';
import { collaborationCorral, FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  applyEvent,
  Coordinator,
  emptyProjection,
  InMemoryRunStore,
  InProcessTransport,
  SPEC_HARD_CAPS,
  usageTotals,
  waitForProjection,
} from '../src/index.ts';

async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

async function setup(definition = linearCorral(['writer']), cancelSettles = true) {
  const clock = new FakeClock();
  const hosts: AgentHost[] = [];
  const settles: ((result: AgentSettlement) => void)[] = [];
  const agents: AgentAdapter = {
    async start(_input, host) {
      hosts.push(host);
      let settle!: (result: AgentSettlement) => void;
      const done = new Promise<AgentSettlement>((resolve) => {
        settle = resolve;
      });
      settles.push(settle);
      return {
        cancel: async () => {
          if (cancelSettles) settle({ outcome: 'cancelled' });
        },
        waitForSettlement: () => done,
      };
    },
  };
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents,
    policy: SPEC_HARD_CAPS,
  });
  const transport = new InProcessTransport(coordinator);
  const start = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition,
    mode: 'mock',
  });
  if (!start.runId) throw new Error(JSON.stringify(start.receipt.error));
  const runId = start.runId;
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });
  await drain();
  const send = (type: RunCommand['type'], payload: unknown, id: string, revision?: number) =>
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: id,
      runId,
      type,
      payload,
      ...(revision === undefined ? {} : { expectedControlRevision: revision }),
    } as RunCommand);
  const projection = () => coordinator.getSnapshot(runId).projection;
  const host = (index = 0) => {
    const found = hosts[index];
    if (!found) throw new Error('agent not started');
    return found;
  };
  return { clock, hosts, settles, host, coordinator, transport, runId, events, send, projection };
}

const observe = (host: AgentHost, id: string, outputTokens: number | null) =>
  host.observe({
    kind: 'model_completed',
    modelCallId: id,
    text: 'response',
    usage: { inputTokens: null, outputTokens },
  });

describe('Coordinator model requests', () => {
  it('workers queued for a model slot pause and resume within the concurrency limit', async () => {
    const definition = collaborationCorral();
    definition.limits = { ...definition.limits, maxModelConcurrency: 1 };
    const s = await setup(definition);
    await s.host().invokeTool({
      name: 'spawn_subagents',
      args: { tasks: [1, 2].map((part) => ({ targetNodeId: 'helper', brief: `Part ${part}` })) },
    });
    await drain();
    const first = await s.host().prepareModelRequest();
    const order = [s.host(1), s.host(2), s.host()];
    const pending = order.slice(0, 2).map((host) => host.prepareModelRequest().catch(() => null));
    await drain();
    s.send('pause', { scope: 'run' }, 'pause');
    await observe(s.host(), first.modelCallId, 10);
    pending.push(
      s
        .host()
        .prepareModelRequest()
        .catch(() => null),
    );
    await drain();
    const paused = s.projection();
    s.send('resume', { scope: 'run' }, 'resume');
    for (const [index, request] of pending.entries()) {
      const permit = await request;
      if (!permit) throw new Error('queued request was rejected after resume');
      expect(Object.keys(s.projection().modelCalls)).toHaveLength(index + 2);
      await observe(order[index] as AgentHost, permit.modelCallId, 10);
    }
    s.send('cancel', { scope: { kind: 'run' }, reason: 'cleanup' }, 'cancel');
    await drain();
    expect(paused.status).toBe('paused');
    expect(Object.keys(paused.modelCalls)).toHaveLength(1);
  });

  it('cancelling a worker queued for a model slot rejects its request without consuming a slot', async () => {
    const definition = collaborationCorral();
    definition.limits = { ...definition.limits, maxModelConcurrency: 1 };
    const s = await setup(definition);
    await s.host().invokeTool({
      name: 'spawn_subagents',
      args: { tasks: [1, 2].map((part) => ({ targetNodeId: 'helper', brief: `Part ${part}` })) },
    });
    await drain();
    const children = Object.values(s.projection().executions).filter((e) => e.depth === 1);
    const child = children[1];
    if (!child) throw new Error('second child did not start');
    const waiting = s.host().invokeTool({
      name: 'await_tasks',
      args: { taskIds: children.map((e) => e.taskId) },
    });
    const first = await s.host(1).prepareModelRequest();
    let state = 'pending';
    const pending = s
      .host(2)
      .prepareModelRequest()
      .then(
        () => {
          state = 'permitted';
        },
        () => {
          state = 'cancelled';
        },
      );
    await drain();
    s.send(
      'cancel',
      {
        scope: { kind: 'execution', executionId: child.executionId },
        reason: 'Stop the waiting child',
      },
      'cancel_child',
    );
    await drain();
    const afterChildCancel = state;
    expect(
      s.send(
        'restart_task',
        {
          taskId: child.taskId,
          previousExecutionId: child.executionId,
          instruction: 'Try again',
        },
        'restart',
        s.projection().controlRevision,
      ),
    ).toMatchObject({ status: 'applied' });
    await drain();
    const restarted = s.host(3).prepareModelRequest();
    await drain();
    expect(Object.keys(s.projection().modelCalls)).toHaveLength(1);
    await observe(s.host(1), first.modelCallId, 10);
    const permit = await restarted;
    let nextState = 'pending';
    const next = s
      .host(1)
      .prepareModelRequest()
      .then((result) => {
        nextState = 'permitted';
        return result;
      });
    await drain();
    expect(nextState).toBe('pending');
    expect(Object.keys(s.projection().modelCalls)).toHaveLength(2);
    await observe(s.host(3), permit.modelCallId, 10);
    await next;
    s.send('cancel', { scope: { kind: 'run' }, reason: 'cleanup' }, 'cancel');
    await pending;
    await waiting;
    expect(afterChildCancel).toBe('cancelled');
  });

  it('cancellation leaves usage unknown and late usage fills it without reviving the task', async () => {
    const s = await setup();
    const host = s.host();
    const first = await host.prepareModelRequest();
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'cancelled');
    expect(usageTotals(s.projection())).toMatchObject({ outputTokens: 0, inFlight: 0, unknown: 1 });
    await observe(host, first.modelCallId, 37);
    await observe(host, first.modelCallId, 37);
    expect(usageTotals(s.projection())).toMatchObject({
      outputTokens: 37,
      inFlight: 0,
      unknown: 0,
    });
    expect(s.projection().status).toBe('cancelled');
    expect(Object.values(s.projection().tasks).every((task) => task.status === 'cancelled')).toBe(
      true,
    );
    expect(
      s.events.filter(
        (e) => e.type === 'model.usage_reconciled' && e.payload.normalizedUsage.outputTokens === 37,
      ),
    ).toHaveLength(1);
  });

  it('the ten-second cleanup deadline fails unconfirmed termination without false confirmation', async () => {
    const s = await setup(linearCorral(['writer']), false);
    await s.host().prepareModelRequest();
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
    s.clock.advance(9_999);
    await drain();
    expect(s.projection().status).toBe('cancelling');
    expect(s.events.some((e) => e.type === 'cancel.confirmed')).toBe(false);
    s.clock.advance(1);
    await drain();
    expect(s.projection().status).toBe('failed');
    expect(s.projection().statusReason).toBe('termination_unconfirmed');
    expect(usageTotals(s.projection())).toMatchObject({ inFlight: 0, unknown: 1 });
    expect(s.events.some((e) => e.type === 'cancel.confirmed')).toBe(false);
  });

  it('message-only turns reach user intervention before a seventh request', async () => {
    const s = await setup();
    const host = s.host();
    for (let turn = 0; turn < 6; turn++) {
      const permit = await host.prepareModelRequest();
      await observe(host, permit.modelCallId, 1);
    }
    const pending = host.prepareModelRequest().catch(() => null);
    await drain();
    expect(s.projection().status).toBe('awaiting_user');
    expect(Object.keys(s.projection().modelCalls)).toHaveLength(6);
    expect(
      s.events.some((e) => e.type === 'limit.reached' && e.payload.limitKind === 'no_progress'),
    ).toBe(true);
    const approval = Object.values(s.projection().approvals).find((a) => a.status === 'pending');
    if (!approval) throw new Error('no-progress approval not created');
    // The approval says which limit paused the run, from the fact committed right before it.
    expect(approval.limit).toEqual({ kind: 'no_progress', used: 6, max: 6 });
    expect(
      s.send(
        'resolve_approval',
        {
          approvalId: approval.approvalId,
          decision: 'approve',
          subjectVersionId: approval.subjectVersionIds[0],
        },
        'continue',
        s.projection().controlRevision,
      ).status,
    ).toBe('applied');
    expect(await pending).not.toBeNull();
    expect(Object.keys(s.projection().modelCalls)).toHaveLength(7);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
    await drain();
  });

  describe('a no-progress pause when its run ends', () => {
    /** Six message-only turns, then a request that waits on the person. */
    const stalled = async (s: Awaited<ReturnType<typeof setup>>) => {
      const host = s.host();
      for (let turn = 0; turn < 6; turn++) {
        const permit = await host.prepareModelRequest();
        await observe(host, permit.modelCallId, 1);
      }
      const waiting = host.prepareModelRequest().then(
        () => 'permitted',
        () => 'stopped',
      );
      await drain();
      const approval = Object.values(s.projection().approvals).find((a) => a.status === 'pending');
      expect(approval?.limit?.kind).toBe('no_progress');
      if (!approval) throw new Error('no-progress approval not created');
      return { approval, waiting };
    };
    const lateAnswers = (
      s: Awaited<ReturnType<typeof setup>>,
      approval: { approvalId: string; subjectVersionIds: string[] },
    ) =>
      (['approve', 'reject'] as const).map(
        (decision) =>
          s.send(
            'resolve_approval',
            {
              approvalId: approval.approvalId,
              decision,
              subjectVersionId: approval.subjectVersionIds[0],
            },
            `late_${decision}`,
            s.projection().controlRevision,
          ).error?.code,
      );

    it('closes as rejected by the runtime when the run is cancelled', async () => {
      const s = await setup();
      const { approval, waiting } = await stalled(s);
      s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
      await drain();
      expect(s.projection().status).toBe('cancelled');
      expect(await waiting).toBe('stopped');
      expect(s.projection().approvals[approval.approvalId]).toMatchObject({
        status: 'rejected',
        reason: 'cancelled',
      });
      const closed = s.events.findIndex(
        (e) => e.type === 'approval.resolved' && e.payload.approvalId === approval.approvalId,
      );
      const resolved = s.events[closed];
      expect(resolved?.type === 'approval.resolved' && resolved.payload).toMatchObject({
        decision: 'reject',
        actor: 'coordinator',
      });
      // Closed before the cancellation is confirmed.
      expect(closed).toBeLessThan(s.events.findIndex((e) => e.type === 'cancel.confirmed'));
      expect(lateAnswers(s, approval)).toEqual(['APPROVAL_STALE', 'APPROVAL_STALE']);
    });

    it('closes with the run when the run fails', async () => {
      const s = await setup();
      const { approval } = await stalled(s);
      s.settles[0]?.({ outcome: 'failed', error: 'worker crashed' });
      await drain();
      expect(s.projection().status).toBe('failed');
      expect(s.projection().approvals[approval.approvalId]).toMatchObject({
        status: 'rejected',
        reason: 'execution_ended',
      });
      expect(lateAnswers(s, approval)).toEqual(['APPROVAL_STALE', 'APPROVAL_STALE']);
    });
  });

  it('a paused question consumes only its remaining logical timeout after resume', async () => {
    const definition = collaborationCorral();
    definition.limits = { ...definition.limits, questionTimeoutMs: 1_000 };
    const researcher = definition.roles.find((role) => role.id === 'researcher');
    if (!researcher) throw new Error('fixture researcher missing');
    researcher.allowedCollaborationTools.push('ask');
    definition.capabilityLinks.push({
      id: 'research_question',
      kind: 'question',
      sourceNodeId: 'research',
      targetNodeId: 'respond',
    });
    const s = await setup(definition);
    const question = s
      .host()
      .invokeTool({ name: 'ask', args: { targetNodeId: 'respond', body: 'Evidence?' } });
    await drain();
    s.clock.advance(400);
    s.send('pause', { scope: 'run' }, 'pause');
    const responderRequest = s
      .host(1)
      .prepareModelRequest()
      .catch(() => null);
    await drain();
    expect(s.projection().status).toBe('paused');
    s.clock.advance(2_000);
    expect(Object.values(s.projection().questions)[0]?.status).toBe('open');
    s.send('resume', { scope: 'run' }, 'resume');
    await responderRequest;
    const resumedDeadline = new Date(Date.parse(s.clock.nowIso()) + 600).toISOString();
    expect(Object.values(s.projection().questions)[0]?.deadline).toBe(resumedDeadline);
    expect(
      s.projection().executions[s.projection().executionOrder[0] ?? '']?.waitingOn?.deadline,
    ).toBe(resumedDeadline);
    s.clock.advance(599);
    expect(Object.values(s.projection().questions)[0]?.status).toBe('open');
    s.clock.advance(1);
    const outcome = await question;
    expect(outcome.ok && outcome.result.outcome).toBe('timed_out');
    expect(Object.values(s.projection().questions)[0]?.status).toBe('timed_out');
    s.send('cancel', { scope: { kind: 'run' }, reason: 'cleanup' }, 'cancel');
    await drain();
  });

  it('concurrent workers wait through one no-progress intervention instead of failing each other', async () => {
    const s = await setup(collaborationCorral());
    await s.host().invokeTool({
      name: 'spawn_subagents',
      args: { tasks: [{ targetNodeId: 'helper', brief: 'Part' }] },
    });
    await drain();
    for (let turn = 0; turn < 6; turn++) {
      const permit = await s.host().prepareModelRequest();
      await observe(s.host(), permit.modelCallId, 1);
    }
    const results: ('permitted' | 'failed')[] = [];
    const pending = s.hosts.map((host) =>
      host.prepareModelRequest().then(
        () => {
          results.push('permitted');
        },
        () => {
          results.push('failed');
        },
      ),
    );
    await drain();
    expect(results).toEqual([]);
    const approvals = Object.values(s.projection().approvals).filter((a) => a.status === 'pending');
    expect(approvals).toHaveLength(1);
    const approval = approvals[0];
    if (!approval) throw new Error('no-progress approval missing');
    s.send(
      'resolve_approval',
      {
        approvalId: approval.approvalId,
        decision: 'approve',
        subjectVersionId: approval.subjectVersionIds[0],
      },
      'continue',
      s.projection().controlRevision,
    );
    await Promise.all(pending);
    expect(results).toEqual(['permitted', 'permitted']);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'cleanup' }, 'cancel');
    await drain();
  });

  it('pause accepted between a request boundary and admission parks that request', async () => {
    const s = await setup();
    let result: 'pending' | 'permitted' | 'failed' = 'pending';
    const pending = s
      .host()
      .prepareModelRequest()
      .then(
        () => {
          result = 'permitted';
        },
        () => {
          result = 'failed';
        },
      );
    s.send('pause', { scope: 'run' }, 'pause');
    await drain();
    expect(result).toBe('pending');
    expect(s.projection().status).toBe('paused');
    expect(Object.keys(s.projection().modelCalls)).toHaveLength(0);
    s.send('resume', { scope: 'run' }, 'resume');
    await pending;
    expect(result).toBe('permitted');
    s.send('cancel', { scope: { kind: 'run' }, reason: 'cleanup' }, 'cancel');
    await drain();
  });

  it('seeded commands preserve admission, ownership, usage and replay invariants', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom(
              'prepare',
              'observe',
              'pause',
              'resume',
              'cancel',
              'patch',
              'steer',
            ),
            slot: fc.integer({ min: 0, max: 4 }),
            usage: fc.option(fc.integer({ min: 0, max: 200 }), { nil: null }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        async (actions) => {
          const s = await setup();
          const host = s.host();
          const permits: string[] = [];
          let preparing = false;
          let spent = 0;
          for (const step of actions) {
            const p = s.projection();
            if (step.kind === 'prepare') {
              const latest = permits.at(-1);
              if (!preparing && (!latest || p.modelCalls[latest]?.finished)) {
                preparing = true;
                void host
                  .prepareModelRequest()
                  .then(
                    (permit) => {
                      permits.push(permit.modelCallId);
                    },
                    () => {},
                  )
                  .finally(() => {
                    preparing = false;
                  });
              }
            } else if (step.kind === 'observe') {
              const id = permits[step.slot % Math.max(1, permits.length)];
              if (id) await observe(host, id, step.usage);
            } else if (step.kind === 'patch') {
              s.send(
                'patch',
                { kind: 'run_limits', changes: { maxSpawns: step.slot + 1 } },
                `patch_${step.slot}`,
                p.controlRevision,
              );
            } else if (step.kind === 'cancel') {
              s.send(
                'cancel',
                { scope: { kind: 'run' }, reason: 'property cancel' },
                `cancel_${step.slot}`,
              );
            } else if (step.kind === 'steer') {
              s.send(
                'steer',
                {
                  targetExecutionId: p.executionOrder[0],
                  text: `directive ${step.slot}`,
                  delivery: 'next_request',
                },
                `steer_${step.slot}`,
              );
            } else {
              s.send(step.kind, { scope: 'run' }, `${step.kind}_${step.slot}`);
            }
            await drain();
            const next = s.projection();
            const usage = usageTotals(next);
            expect(usage.outputTokens).toBeGreaterThanOrEqual(spent);
            spent = usage.outputTokens;
            expect(Object.values(usage).every((n) => n >= 0)).toBe(true);
            for (const task of Object.values(next.tasks)) {
              const active = Object.values(next.executions).filter(
                (execution) =>
                  execution.taskId === task.taskId &&
                  !['succeeded', 'failed', 'cancelled'].includes(execution.status),
              );
              expect(active.length).toBeLessThanOrEqual(1);
              if (active.length === 1) expect(active[0]?.executionId).toBe(task.activeExecutionId);
            }
          }
          s.send('cancel', { scope: { kind: 'run' }, reason: 'property cleanup' }, 'finish');
          await drain();
          const final = s.projection();
          expect(final.status).toBe('cancelled');
          expect(s.events.reduce(applyEvent, emptyProjection(s.runId))).toEqual(final);
          expect(s.events.map((e) => e.runSeq)).toEqual(s.events.map((_, index) => index + 1));
          let admissionOpen = false;
          for (const e of s.events) {
            if (e.type === 'run.state_changed') admissionOpen = e.payload.to === 'running';
            if (e.type === 'effect.admitted') expect(admissionOpen).toBe(true);
          }
          const prepared = s.events.filter((e) => e.type === 'model.request_prepared');
          expect(new Set(prepared.map((e) => e.payload.modelCallId)).size).toBe(prepared.length);
        },
      ),
      { seed: 2026101509, numRuns: 80 },
    );
  });

  it('the coordinator uses injected time, IDs, storage and effects without external calls', async () => {
    const realClock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('real clock forbidden');
    });
    vi.stubGlobal('fetch', () => {
      throw new Error('real fetch forbidden');
    });
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new Error('random ID forbidden');
      },
    });
    try {
      const clock = new FakeClock();
      const store = new InMemoryRunStore();
      let host!: AgentHost;
      const coordinator = new Coordinator({
        clock,
        timers: clock,
        ids: new SequentialIdFactory(),
        store,
        agents: {
          async start(_input, bound) {
            host = bound;
            return {
              cancel: async () => {},
              waitForSettlement: () => new Promise<AgentSettlement>(() => {}),
            };
          },
        },
      });
      const start = coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'injected',
        definition: linearCorral(['writer']),
        mode: 'mock',
      });
      if (!start.runId) throw new Error('run did not start');
      await drain();
      const request = await host.prepareModelRequest();
      clock.advance(100);
      await observe(host, request.modelCallId, 10);
      const events = store.readEvents(start.runId, 0);
      expect(events.some((e) => e.recordedAt === clock.nowIso())).toBe(true);
      expect(events.some((e) => e.type === 'model.finished')).toBe(true);
      expect(usageTotals(coordinator.getSnapshot(start.runId).projection).outputTokens).toBe(10);
    } finally {
      realClock.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
