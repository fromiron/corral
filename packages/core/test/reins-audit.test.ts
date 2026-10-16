import type { AgentHost, AgentSettlement, CorralDefinition, RunCommand } from '@corral/contracts';
import {
  collaborationCorral,
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  type CoordinatorDeps,
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Required test fixture is missing');
  return value;
}

async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

class FailingStore extends InMemoryRunStore {
  fail = false;
  override saveProjection(...args: Parameters<InMemoryRunStore['saveProjection']>) {
    if (this.fail) throw new Error('storage failed');
    super.saveProjection(...args);
  }
}

function controlled(
  definition: CorralDefinition,
  extra: Pick<CoordinatorDeps, 'tools' | 'store'> = {},
) {
  const clock = new FakeClock();
  const hosts = new Map<string, AgentHost>();
  const coordinator = new Coordinator({
    ...extra,
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: {
      async start(input, host) {
        hosts.set(input.executionId, host);
        let finish!: (result: AgentSettlement) => void;
        const settlement = new Promise<AgentSettlement>((resolve) => {
          finish = resolve;
        });
        return {
          cancel: async () => {
            finish({ outcome: 'cancelled' });
          },
          waitForSettlement: () => settlement,
        };
      },
    },
  });
  const runId = required(
    coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'mock',
      definition,
    }).runId,
  );
  const send = (type: RunCommand['type'], payload: unknown, commandId: string = type) =>
    coordinator.submit({
      schemaVersion: '0.1',
      runId,
      commandId,
      type,
      payload,
      expectedControlRevision: coordinator.getSnapshot(runId).projection.controlRevision,
    } as RunCommand);
  return {
    coordinator,
    runId,
    hosts,
    send,
    projection: () => coordinator.getSnapshot(runId).projection,
  };
}

describe('Reins integration counterexamples', () => {
  it('[TC-RNS-004-N] an unconfirmed child shutdown also cancels surviving parent and sibling scopes', async () => {
    const clock = new FakeClock();
    const hosts = new Map<string, AgentHost>();
    const cancelled = new Set<string>();
    const coordinator = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      agents: {
        async start(input, host) {
          hosts.set(input.executionId, host);
          return {
            cancel: async () => {
              cancelled.add(input.executionId);
            },
            waitForSettlement: () => new Promise<AgentSettlement>(() => {}),
          };
        },
      },
    });
    const runId = required(
      coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'start',
        mode: 'mock',
        definition: collaborationCorral(),
      }).runId,
    );
    await drain();
    const parent = required(coordinator.getSnapshot(runId).projection.executionOrder[0]);
    await required(hosts.get(parent)).invokeTool({
      name: 'spawn_subagents',
      args: {
        tasks: [
          { targetNodeId: 'helper', brief: 'A' },
          { targetNodeId: 'helper', brief: 'B' },
        ],
      },
    });
    await drain();
    const executions = coordinator.getSnapshot(runId).projection.executionOrder;
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel',
      runId,
      type: 'cancel',
      payload: {
        scope: { kind: 'execution', executionId: required(executions[1]) },
        reason: 'Stop one child',
      },
    });
    clock.advance(10_000);
    await drain();
    expect(coordinator.getSnapshot(runId).projection.status).toBe('failed');
    expect([...cancelled].sort()).toEqual([...executions].sort());
  });

  it.each(['run', 'execution'] as const)(
    '[TC-RNS-004-H] [TC-RNS-004-N] cancelling %s waits for the child backend tool to release before confirming',
    async (kind) => {
      const definition = collaborationCorral();
      required(definition.roles.find((role) => role.id === 'helper')).allowedWorkTools.push(
        'read_document',
      );
      const store = new InMemoryRunStore();
      let aborted = false;
      let release!: (value: Record<string, unknown>) => void;
      const s = controlled(definition, {
        store,
        tools: {
          execute: async (_input, cancellation) => {
            cancellation.onCancel(() => {
              aborted = true;
            });
            return new Promise((resolve) => {
              release = resolve;
            });
          },
        },
      });
      await drain();
      const parentId = required(s.projection().executionOrder[0]);
      const parent = required(s.hosts.get(parentId));
      await parent.invokeTool({
        name: 'spawn_subagents',
        args: { tasks: [{ targetNodeId: 'helper', brief: 'Read source' }] },
      });
      await drain();
      const child = required(
        Object.values(s.projection().executions).find(
          (execution) => execution.parentExecutionId === parentId,
        ),
      );
      const waiting = parent.invokeTool({ name: 'await_tasks', args: { taskIds: [child.taskId] } });
      const reading = required(s.hosts.get(child.executionId)).invokeTool({
        name: 'read_document',
        args: { documentId: 'doc_1' },
      });
      await drain();
      const scope = kind === 'run' ? { kind } : { kind, executionId: child.executionId };
      expect(s.send('cancel', { scope, reason: 'Stop scope' }).error).toBeUndefined();
      await drain();
      expect(aborted).toBe(true);
      expect(s.projection().executions[child.executionId]?.status).toBe('cancelling');
      expect(store.readEvents(s.runId, 0).some((event) => event.type === 'cancel.confirmed')).toBe(
        false,
      );
      release({ text: 'Late backend response' });
      expect((await reading).ok).toBe(false);
      await drain();
      expect(s.projection().executions[child.executionId]?.status).toBe('cancelled');
      expect(s.projection().status).toBe(kind === 'run' ? 'cancelled' : 'awaiting_user');
      expect(store.readEvents(s.runId, 0).some((event) => event.type === 'cancel.confirmed')).toBe(
        true,
      );
      if (kind === 'execution')
        s.send('cancel', { scope: { kind: 'run' }, reason: 'Cleanup' }, 'cleanup');
      await waiting;
    },
  );

  it('[TC-RACE-09] storage failure cancels an active backend tool and closes admission', async () => {
    const store = new FailingStore();
    const definition = linearCorral(['writer']);
    required(definition.roles[0]).allowedWorkTools.push('read_document');
    let aborted = false;
    const s = controlled(definition, {
      store,
      tools: {
        execute: (_input, cancellation) =>
          new Promise((resolve) => {
            cancellation.onCancel(() => {
              aborted = true;
              resolve({ cancelled: true });
            });
          }),
      },
    });
    await drain();
    const host = required(s.hosts.get(required(s.projection().executionOrder[0])));
    const reading = host
      .invokeTool({ name: 'read_document', args: { documentId: 'doc_1' } })
      .catch(() => null);
    await drain();
    store.fail = true;
    expect(s.send('pause', { scope: 'run' }).error?.code).toBe('STORAGE_UNAVAILABLE');
    await reading;
    expect(aborted).toBe(true);
    expect(s.coordinator.admitting).toBe(false);
  });

  it('[TC-RACE-09] storage failure releases the pending question RPC after its workers stop', async () => {
    const store = new FailingStore();
    const definition = collaborationCorral();
    required(
      definition.roles.find((role) => role.id === 'researcher'),
    ).allowedCollaborationTools.push('ask');
    definition.capabilityLinks.push({
      id: 'ask_research',
      kind: 'question',
      sourceNodeId: 'research',
      targetNodeId: 'respond',
    });
    const s = controlled(definition, { store });
    await drain();
    const host = required(s.hosts.get(required(s.projection().executionOrder[0])));
    let questionSettled = false;
    void host
      .invokeTool({ name: 'ask', args: { targetNodeId: 'respond', body: 'Evidence?' } })
      .then(
        () => {
          questionSettled = true;
        },
        () => {
          questionSettled = true;
        },
      );
    await drain();
    expect(Object.values(s.projection().questions)[0]?.status).toBe('open');
    store.fail = true;
    expect(s.send('pause', { scope: 'run' }).error?.code).toBe('STORAGE_UNAVAILABLE');
    await drain();
    expect(questionSettled).toBe(true);
  });

  it('[TC-RNS-004-N] unconfirmed worker termination keeps the workspace closed to new runs', async () => {
    const clock = new FakeClock();
    let starts = 0;
    const coordinator = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      agents: {
        async start() {
          starts++;
          return {
            cancel: async () => {},
            waitForSettlement: () => new Promise<AgentSettlement>(() => {}),
          };
        },
      },
    });
    const request = {
      schemaVersion: '0.1' as const,
      commandId: 'first',
      mode: 'mock' as const,
      definition: linearCorral(['writer']),
    };
    const first = coordinator.startRun(request);
    await drain();
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel',
      runId: required(first.runId),
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'Stop' },
    });
    clock.advance(10_000);
    await drain();
    expect(coordinator.getSnapshot(required(first.runId)).projection.statusReason).toBe(
      'termination_unconfirmed',
    );
    const next = coordinator.startRun({ ...request, commandId: 'second' });
    await drain();
    expect(next.runId).toBeNull();
    expect(next.receipt.error?.code).toBe('RESOURCE_CAPACITY');
    expect(coordinator.admitting).toBe(false);
    expect(starts).toBe(1);
  });

  it('[TC-RNS-005-H] [TC-RNS-005-N] [TC-RACE-11] a required task supports two explicit restarts without late old-attempt results changing its new owner', async () => {
    const store = new InMemoryRunStore();
    const s = controlled(collaborationCorral(), { store });
    await drain();
    const parentId = required(s.projection().executionOrder[0]);
    const parent = required(s.hosts.get(parentId));
    const spawn = await parent.invokeTool({
      name: 'spawn_subagents',
      args: { tasks: [{ targetNodeId: 'helper', brief: 'Required work' }] },
    });
    expect(spawn.ok).toBe(true);
    await drain();
    const first = required(
      Object.values(s.projection().executions).find((e) => e.parentExecutionId === parentId),
    );
    const waiting = parent.invokeTool({ name: 'await_tasks', args: { taskIds: [first.taskId] } });
    await drain();
    let previous = first.executionId;
    for (let attempt = 2; attempt <= 3; attempt++) {
      const oldHost = required(s.hosts.get(previous));
      const oldRequest = await oldHost.prepareModelRequest();
      expect(
        s.send(
          'cancel',
          { scope: { kind: 'execution', executionId: previous }, reason: 'Replace this attempt' },
          `cancel_${attempt}`,
        ).error,
      ).toBeUndefined();
      await drain();
      expect(s.projection().tasks[first.taskId]?.status).toBe('blocked');
      expect(
        s.send(
          'restart_task',
          { taskId: first.taskId, previousExecutionId: previous, instruction: 'Try again' },
          `restart_${attempt}`,
        ).error,
      ).toBeUndefined();
      await drain();
      const next = s.projection().tasks[first.taskId]?.activeExecutionId;
      expect(next).not.toBe(previous);
      expect(s.projection().executions[parentId]?.waitingOn?.targetIds).toContain(next);
      await oldHost.observe({
        kind: 'model_completed',
        modelCallId: oldRequest.modelCallId,
        text: 'Late result from replaced attempt',
        usage: { inputTokens: 1, outputTokens: 7 },
      });
      expect(s.projection().tasks[first.taskId]).toMatchObject({
        activeExecutionId: next,
        status: 'in_progress',
        attemptCount: attempt,
      });
      expect(s.projection().executions[previous]?.status).toBe('cancelled');
      expect(s.projection().budget).toMatchObject({
        spent: (attempt - 1) * 7,
        unknownOutstanding: 0,
      });
      expect(
        store
          .readEvents(s.runId, 0)
          .some(
            (event) =>
              event.type === 'observation.late' &&
              event.executionId === previous &&
              event.payload.originalRef === oldRequest.modelCallId,
          ),
      ).toBe(true);
      expect(store.getArtifactText(s.runId, `response_${oldRequest.modelCallId}`)).toBeNull();
      await expect(oldHost.prepareModelRequest()).rejects.toThrow();
      previous = required(next);
    }
    expect(s.projection().tasks[first.taskId]?.attemptCount).toBe(3);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'Test complete' }, 'cleanup');
    await waiting;
    await drain();
    expect(s.projection().status).toBe('cancelled');
  });

  it('[TC-RNS-003-N] approving a paused final output keeps the run paused until explicit resume', async () => {
    const clock = new FakeClock();
    const definition = linearCorral(['writer']);
    const output = required(definition.nodes.find((node) => node.type === 'output'));
    output.requireApproval = true;
    const coordinator = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    const transport = new InProcessTransport(coordinator);
    const runId = required(
      coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'start',
        mode: 'mock',
        definition,
      }).runId,
    );
    const waiting = await waitForProjection(transport, runId, (p) => p.status === 'awaiting_user');
    const approval = required(Object.values(waiting.approvals)[0]);
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'pause',
      runId,
      type: 'pause',
      payload: { scope: 'run' },
    });
    expect(coordinator.getSnapshot(runId).projection.status).toBe('paused');
    expect(
      coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'approve',
        runId,
        type: 'resolve_approval',
        expectedControlRevision: waiting.controlRevision,
        payload: {
          approvalId: approval.approvalId,
          decision: 'approve',
          subjectVersionId: required(approval.subjectVersionIds[0]),
        },
      }).error,
    ).toBeUndefined();
    await drain();
    expect(coordinator.getSnapshot(runId).projection.status).toBe('paused');
    expect(coordinator.getSnapshot(runId).projection.output).toBeNull();
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'resume',
      runId,
      type: 'resume',
      payload: { scope: 'run' },
    });
    await drain();
    expect(coordinator.getSnapshot(runId).projection.status).toBe('succeeded');
  });

  it('[TC-RNS-003-H] both idempotent pause receipts settle when the shared boundary is reached', async () => {
    const s = controlled(linearCorral(['writer']));
    await drain();
    const host = required(s.hosts.get(required(s.projection().executionOrder[0])));
    const request = await host.prepareModelRequest();
    s.send('pause', { scope: 'run' }, 'pause_first');
    s.send('pause', { scope: 'run' }, 'pause_second');
    await host.observe({
      kind: 'model_completed',
      modelCallId: request.modelCallId,
      text: 'Finished',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const blocked = host.prepareModelRequest().catch(() => null);
    await drain();
    expect(s.projection().status).toBe('paused');
    expect(s.coordinator.getReceipt(s.runId, 'pause_first')?.status).toBe('applied');
    expect(s.coordinator.getReceipt(s.runId, 'pause_second')?.status).toBe('applied');
    s.send('cancel', { scope: { kind: 'run' }, reason: 'Test complete' }, 'cleanup');
    await blocked;
  });

  it('[TC-RUN-007-H] recovery expires a pause that never reached its boundary', async () => {
    const store = new InMemoryRunStore();
    const s = controlled(linearCorral(['writer']), { store });
    await drain();
    await required(s.hosts.get(required(s.projection().executionOrder[0]))).prepareModelRequest();
    s.send('pause', { scope: 'run' });
    const recovered = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    expect(recovered.getSnapshot(s.runId).projection.status).toBe('interrupted');
    expect(recovered.getReceipt(s.runId, 'pause')?.status).toBe('expired');
  });

  it.each([false, true])(
    '[TC-RNS-003-H] run cancellation settles pending pause receipts and preserves applied pauses (paused=%s)',
    async (reachedBoundary) => {
      const s = controlled(linearCorral(['writer']));
      await drain();
      const host = required(s.hosts.get(required(s.projection().executionOrder[0])));
      const request = await host.prepareModelRequest();
      s.send('pause', { scope: 'run' });
      let blocked: Promise<unknown> | undefined;
      if (reachedBoundary) {
        await host.observe({
          kind: 'model_completed',
          modelCallId: request.modelCallId,
          text: 'Finished',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        blocked = host.prepareModelRequest().catch(() => null);
        await drain();
        expect(s.projection().status).toBe('paused');
      }
      s.send('cancel', { scope: { kind: 'run' }, reason: 'Stop' });
      await blocked;
      await drain();
      expect(s.projection().status).toBe('cancelled');
      expect(s.coordinator.getReceipt(s.runId, 'pause')?.status).toBe(
        reachedBoundary ? 'applied' : 'cancelled',
      );
    },
  );

  it('[TC-RNS-003-H] a superseded pause stays superseded after a later pause reaches its boundary', async () => {
    const s = controlled(linearCorral(['writer']));
    await drain();
    const host = required(s.hosts.get(required(s.projection().executionOrder[0])));
    const request = await host.prepareModelRequest();
    s.send('pause', { scope: 'run' }, 'pause_first');
    s.send('pause', { scope: 'run' }, 'pause_duplicate');
    s.send('resume', { scope: 'run' });
    expect(s.coordinator.getReceipt(s.runId, 'pause_first')?.status).toBe('superseded');
    expect(s.coordinator.getReceipt(s.runId, 'pause_duplicate')?.status).toBe('superseded');
    s.send('pause', { scope: 'run' }, 'pause_later');
    await host.observe({
      kind: 'model_completed',
      modelCallId: request.modelCallId,
      text: 'Finished',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const blocked = host.prepareModelRequest().catch(() => null);
    await drain();
    expect(s.projection().status).toBe('paused');
    const statuses = ['pause_first', 'pause_duplicate', 'pause_later'].map(
      (commandId) => s.coordinator.getReceipt(s.runId, commandId)?.status,
    );
    s.send('cancel', { scope: { kind: 'run' }, reason: 'Test complete' }, 'cleanup');
    await blocked;
    expect(statuses).toEqual(['superseded', 'superseded', 'applied']);
  });
});
