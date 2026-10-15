import type { AgentHost, AgentSettlement, CorralDefinition, RunCommand } from '@corral/contracts';
import {
  collaborationCorral,
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  applyEvent,
  Coordinator,
  emptyProjection,
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing test fixture');
  return value;
}

async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

function controlled(definition = linearCorral(['writer'])) {
  const store = new InMemoryRunStore();
  const clock = new FakeClock();
  const hosts = new Map<string, AgentHost>();
  const exits = new Map<string, (result: AgentSettlement) => void>();
  const coordinator = new Coordinator({
    store,
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: {
      async start(input, host) {
        hosts.set(input.executionId, host);
        const settled = new Promise<AgentSettlement>((resolve) => {
          exits.set(input.executionId, resolve);
        });
        return {
          cancel: async () => required(exits.get(input.executionId))({ outcome: 'cancelled' }),
          waitForSettlement: () => settled,
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
  const projection = () => coordinator.getSnapshot(runId).projection;
  const send = (type: RunCommand['type'], payload: unknown, commandId: string = type) =>
    coordinator.submit({
      schemaVersion: '0.1',
      commandId,
      runId,
      type,
      payload,
      expectedControlRevision: projection().controlRevision,
    } as RunCommand);
  return { coordinator, runId, store, hosts, exits, projection, send };
}

async function completeRequest(host: AgentHost) {
  const permit = await host.prepareModelRequest();
  await host.modelRequestDispatched?.(permit.modelCallId);
  await host.observe({
    kind: 'model_completed',
    modelCallId: permit.modelCallId,
    text: 'Still working',
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

it('[TC-RNS-003-H] [TC-RNS-005-N] a paused required task cannot restart until explicit resume', async () => {
  const s = controlled(collaborationCorral());
  await drain();
  const parentId = required(s.projection().executionOrder[0]);
  const parent = required(s.hosts.get(parentId));
  await parent.invokeTool({
    name: 'spawn_subagents',
    args: { tasks: [{ targetNodeId: 'helper', brief: 'Required work' }] },
  });
  await drain();
  const child = required(Object.values(s.projection().executions).find((e) => e.depth === 1));
  const waiting = parent.invokeTool({ name: 'await_tasks', args: { taskIds: [child.taskId] } });
  await drain();
  s.send('cancel', {
    scope: { kind: 'execution', executionId: child.executionId },
    reason: 'Stop',
  });
  await drain();
  s.send('pause', { scope: 'run' });
  expect(s.projection().status).toBe('paused');
  const beforeEffects = Object.keys(s.projection().effects);
  const payload = {
    taskId: child.taskId,
    previousExecutionId: child.executionId,
    instruction: 'Try again',
  };
  expect(s.send('restart_task', payload).error?.code).toBe('RESTART_NOT_ALLOWED');
  await drain();
  expect(s.projection().status).toBe('paused');
  expect(s.hosts.size).toBe(2);
  expect(Object.keys(s.projection().effects)).toEqual(beforeEffects);
  s.send('resume', { scope: 'run' });
  expect(s.projection().status).toBe('awaiting_user');
  expect(s.send('restart_task', payload, 'restart_after_resume').status).toBe('applied');
  await drain();
  expect(s.hosts.size).toBe(3);
  expect(s.projection().tasks[child.taskId]?.attemptCount).toBe(2);
  s.send('cancel', { scope: { kind: 'run' }, reason: 'Cleanup' }, 'cleanup');
  await waiting;
});

it('[TC-RNS-003-H] cancelling a child while paused preserves the user pause', async () => {
  const s = controlled(collaborationCorral());
  await drain();
  const parent = required(s.hosts.get(required(s.projection().executionOrder[0])));
  await parent.invokeTool({
    name: 'spawn_subagents',
    args: { tasks: [{ targetNodeId: 'helper', brief: 'Required work' }] },
  });
  await drain();
  const child = required(Object.values(s.projection().executions).find((e) => e.depth === 1));
  const waiting = parent.invokeTool({ name: 'await_tasks', args: { taskIds: [child.taskId] } });
  await drain();
  s.send('pause', { scope: 'run' });
  const blocked = required(s.hosts.get(child.executionId))
    .prepareModelRequest()
    .catch(() => null);
  await drain();
  expect(s.projection().status).toBe('paused');
  s.send('cancel', {
    scope: { kind: 'execution', executionId: child.executionId },
    reason: 'Stop',
  });
  await blocked;
  await drain();
  expect(s.projection().status).toBe('paused');
  expect(s.projection().tasks[child.taskId]?.status).toBe('blocked');
  s.send('cancel', { scope: { kind: 'run' }, reason: 'Cleanup' }, 'cleanup');
  await waiting;
});

it('[TC-RNS-003-H] a request failure during pause is retained until resume', async () => {
  const s = controlled();
  await drain();
  const executionId = required(s.projection().executionOrder[0]);
  await required(s.hosts.get(executionId)).prepareModelRequest();
  s.send('pause', { scope: 'run' });
  required(s.exits.get(executionId))({ outcome: 'failed', error: 'Provider failure' });
  await drain();
  expect(s.projection().status).toBe('paused');
  s.send('resume', { scope: 'run' });
  await drain();
  expect(s.projection().status).toBe('failed');
  expect(s.projection().statusReason).toContain('execution_failed');
  expect(s.hosts.size).toBe(1);
});

it('[TC-RNS-003-H] no-progress approval is a safe pause boundary without approving it', async () => {
  const s = controlled();
  await drain();
  const host = required(s.hosts.get(required(s.projection().executionOrder[0])));
  for (let i = 0; i < 6; i++) await completeRequest(host);
  const blocked = host.prepareModelRequest().catch(() => null);
  await drain();
  const approval = required(Object.values(s.projection().approvals)[0]);
  s.send('pause', { scope: 'run' });
  await drain();
  expect(s.projection().status).toBe('paused');
  expect(s.projection().approvals[approval.approvalId]?.status).toBe('pending');
  s.send('resume', { scope: 'run' });
  expect(s.projection().status).toBe('awaiting_user');
  expect(Object.keys(s.projection().modelCalls)).toHaveLength(6);
  s.send('resolve_approval', {
    approvalId: approval.approvalId,
    subjectVersionId: required(approval.subjectVersionIds[0]),
    decision: 'approve',
  });
  expect(await blocked).not.toBeNull();
  expect(Object.keys(s.projection().modelCalls)).toHaveLength(7);
  s.send('cancel', { scope: { kind: 'run' }, reason: 'Cleanup' });
});

it('[TC-ART-002-H] multiple writes in a later Loop round keep artifact versions increasing', async () => {
  const scripted = new ScriptedAgentAdapter({ turns: 1, collaborate: false });
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: {
      start(input, host) {
        return scripted.start(input, {
          ...host,
          invokeTool: async (proposal) => {
            const first = await host.invokeTool(proposal);
            return proposal.name === 'write_artifact' &&
              input.role.outputContract === 'draft' &&
              input.round === 2
              ? host.invokeTool({
                  name: 'write_artifact',
                  args: { text: `${proposal.args.text}\nAnother edit before submitting` },
                })
              : first;
          },
        });
      },
    },
  });
  const runId = required(
    coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'mock',
      definition: researchTeam as CorralDefinition,
    }).runId,
  );
  const projection = await waitForProjection(
    new InProcessTransport(coordinator),
    runId,
    (p) => p.status === 'awaiting_user',
  );
  const drafts = Object.values(projection.artifacts).filter((a) => a.contract === 'draft');
  expect(new Set(drafts.map((a) => a.artifactId)).size).toBe(1);
  expect(drafts.map((a) => a.version)).toEqual([1, 2, 3]);
  expect(drafts[2]?.parentVersionId).toBe(drafts[1]?.artifactVersionId);
});

it('[TC-RUN-007-H] recovery closes open questions and invalidates approvals exactly once', async () => {
  const definition = collaborationCorral();
  required(definition.roles.find((r) => r.id === 'researcher')).allowedCollaborationTools.push(
    'ask',
  );
  definition.capabilityLinks.push({
    id: 'ask_research',
    kind: 'question',
    sourceNodeId: 'research',
    targetNodeId: 'respond',
  });
  const s = controlled(definition);
  await drain();
  const parent = required(s.hosts.get(required(s.projection().executionOrder[0])));
  void parent.invokeTool({ name: 'ask', args: { targetNodeId: 'respond', body: 'Evidence?' } });
  await drain();
  const question = required(Object.values(s.projection().questions)[0]);
  const responderId = required(s.projection().tasks[question.taskId]?.activeExecutionId);
  const responder = required(s.hosts.get(responderId));
  for (let i = 0; i < 6; i++) await completeRequest(responder);
  void responder.prepareModelRequest();
  await drain();
  const approval = required(Object.values(s.projection().approvals)[0]);
  let starts = 0;
  const recover = (suffix: string) =>
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(suffix),
      store: s.store,
      sessionId: `backend_${suffix}`,
      agents: {
        async start() {
          starts++;
          throw new Error('Recovery must not start an execution');
        },
      },
    });
  const recovered = recover('b');
  const projection = recovered.getSnapshot(s.runId).projection;
  expect(projection.status).toBe('interrupted');
  expect(projection.questions[question.questionId]?.status).toBe('cancelled');
  expect(projection.approvals[approval.approvalId]?.status).toBe('stale');
  expect(
    recovered.submit({
      schemaVersion: '0.1',
      commandId: 'late_approval',
      runId: s.runId,
      type: 'resolve_approval',
      expectedControlRevision: projection.controlRevision,
      payload: {
        approvalId: approval.approvalId,
        subjectVersionId: required(approval.subjectVersionIds[0]),
        decision: 'approve',
      },
    }).error?.code,
  ).toBe('APPROVAL_STALE');
  const events = s.store.readEvents(s.runId, 0);
  expect(events.reduce(applyEvent, emptyProjection(s.runId))).toEqual(projection);
  recover('c');
  await drain();
  expect(starts).toBe(0);
  expect(s.store.readEvents(s.runId, 0)).toEqual(events);
});
