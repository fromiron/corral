import {
  type AgentHost,
  type AgentSettlement,
  type CorralDefinition,
  DEFAULT_LIMITS,
  type DEFAULT_REQUEST_BUDGET,
  type RequestPermit,
  type RunCommand,
  type RunEvent,
} from '@corral/contracts';
import { collaborationCorral, FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  Coordinator,
  carriedDirectives,
  emptyProjection,
  InMemoryRunStore,
  REQUEST_BUDGET_NOTICES,
  type RunProjection,
  requestBudgetOf,
  SPEC_HARD_CAPS,
} from '../src/index.ts';

// The unattended request budget (product contract §9): a team role or a dynamically created
// child is told to wrap up at its budget, to submit at 1.5 times it, and five requests after that
// waits for the person. An execution that answers the conversation directly is never counted.

async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing fixture');
  return value;
}

const N = 50;
const SUBMIT = Math.ceil(1.5 * N);

function setup(definition: CorralDefinition = linearCorral(['writer'])) {
  const store = new InMemoryRunStore();
  const clock = new FakeClock();
  const hosts: AgentHost[] = [];
  const exits: ((result: AgentSettlement) => void)[] = [];
  const coordinator = new Coordinator({
    store,
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    policy: SPEC_HARD_CAPS,
    agents: {
      async start(_input, host) {
        hosts.push(host);
        const settled = new Promise<AgentSettlement>((resolve) => exits.push(resolve));
        const index = exits.length - 1;
        return {
          cancel: async () => exits[index]?.({ outcome: 'cancelled' }),
          waitForSettlement: () => settled,
        };
      },
    },
  });
  const runId = required(
    coordinator.startRun({ schemaVersion: '0.1', commandId: 'start', mode: 'mock', definition })
      .runId,
  );
  const projection = () => coordinator.getSnapshot(runId).projection;
  const send = (type: RunCommand['type'], payload: unknown, commandId: string) =>
    coordinator.submit({
      schemaVersion: '0.1',
      commandId,
      runId,
      type,
      payload,
      expectedControlRevision: projection().controlRevision,
    } as RunCommand);
  const events = () => store.readEvents(runId, 0);
  return { coordinator, store, clock, hosts, exits, runId, projection, send, events };
}

type Setup = ReturnType<typeof setup>;

/**
 * One request and its reply. The first replies are ordinary; later ones are cut (an interrupted
 * reply is no turn without progress), so the no-progress pause never comes first.
 */
async function turn(s: Setup, host: AgentHost): Promise<RequestPermit> {
  const permit = await host.prepareModelRequest();
  await host.modelRequestDispatched?.(permit.modelCallId);
  const count = Object.keys(s.projection().modelCalls).length;
  await host.observe({
    kind: 'model_completed',
    modelCallId: permit.modelCallId,
    text: 'response',
    usage: { inputTokens: null, outputTokens: 1 },
    ...(count > 3 ? { interrupted: true as const } : {}),
  });
  return permit;
}

async function turns(s: Setup, host: AgentHost, count: number): Promise<RequestPermit[]> {
  const permits: RequestPermit[] = [];
  for (let i = 0; i < count; i++) permits.push(await turn(s, host));
  return permits;
}

const budget = (s: Setup, value: Partial<typeof DEFAULT_REQUEST_BUDGET>, id = 'budget') =>
  s.send('patch', { kind: 'run_limits', changes: { requestBudget: value } }, id);

const systemDirectives = (p: RunProjection, executionId?: string) =>
  p.directiveOrder
    .map((id) => required(p.directives[id]))
    .filter((d) => d.origin === 'system' && (!executionId || d.targetExecutionId === executionId));

const budgetApprovals = (p: RunProjection) =>
  Object.values(p.approvals).filter((a) => a.kind === 'request_budget');

const limits = (events: readonly RunEvent[]) =>
  events.filter(
    (e): e is Extract<RunEvent, { type: 'limit.reached' }> =>
      e.type === 'limit.reached' && e.payload.limitKind === 'request_budget',
  );

const executionOf = (s: Setup, index = 0) => required(s.projection().executionOrder[index]);

/** Runs one execution up to the moment its next request waits for the person. */
async function toApproval(s: Setup, host: AgentHost) {
  await turns(s, host, SUBMIT + 5);
  const waiting = host.prepareModelRequest();
  waiting.catch(() => null);
  await drain();
  return { waiting };
}

const resolve = (s: Setup, decision: 'approve' | 'reject', id: string) => {
  const approval = required(budgetApprovals(s.projection()).find((a) => a.status === 'pending'));
  return s.send(
    'resolve_approval',
    {
      approvalId: approval.approvalId,
      decision,
      subjectVersionId: approval.subjectVersionIds[0],
    },
    id,
  );
};

describe('request budget limits', () => {
  it('fills omitted budgets with the defaults and keeps the values used on run.started', () => {
    const s = setup();
    const started = required(s.events().find((e) => e.type === 'run.started'));
    if (started.type !== 'run.started') throw new Error('not run.started');
    expect(started.payload.limits.requestBudget).toEqual({ role: 400, child: 200, advisor: 60 });
    const partial = linearCorral(['writer']);
    partial.limits = { ...DEFAULT_LIMITS, requestBudget: { child: 0 } };
    const p = setup(partial);
    expect(p.projection().limits?.requestBudget).toEqual({ role: 400, child: 0, advisor: 60 });
  });

  it('picks the budget by execution kind', () => {
    const effective = { ...DEFAULT_LIMITS, requestBudget: { role: 70, child: 0, advisor: 90 } };
    expect(requestBudgetOf('role', effective)).toBe(70);
    expect(requestBudgetOf('child', effective)).toBe(0);
    expect(requestBudgetOf('advisor', effective)).toBe(90);
    expect(requestBudgetOf('role', DEFAULT_LIMITS)).toBe(400);
    expect(requestBudgetOf('child', DEFAULT_LIMITS)).toBe(200);
    expect(requestBudgetOf('advisor', DEFAULT_LIMITS)).toBe(60);
  });

  it('a patch takes 0 or 50 to 2,000, in part, and refuses anything else', () => {
    const s = setup();
    for (const [value, id] of [
      [49, 'p49'],
      [2001, 'p2001'],
      [-1, 'pneg'],
      [50.5, 'pfrac'],
    ] as const)
      expect(budget(s, { role: value }, id).status).toBe('rejected');
    expect(s.send('patch', { kind: 'run_limits', changes: {} }, 'pnone').status).toBe('rejected');
    expect(budget(s, { child: 2000 }, 'pmax').status).toBe('applied');
    expect(budget(s, { role: 0 }, 'poff').status).toBe('applied');
    expect(s.projection().limits?.requestBudget).toEqual({ role: 0, child: 2000, advisor: 60 });
    const patch = Object.values(s.projection().patches).at(-1);
    expect(patch?.before).toEqual({ requestBudget: { role: 400, child: 2000, advisor: 60 } });
    expect(patch?.after).toEqual({ requestBudget: { role: 0, child: 2000, advisor: 60 } });
    // The spawn patch is unchanged beside it.
    expect(
      s.send('patch', { kind: 'run_limits', changes: { maxSpawns: 3 } }, 'spawns').status,
    ).toBe('applied');
    expect(s.projection().limits?.maxSpawns).toBe(3);
  });
});

describe('request budget stages', () => {
  it('wraps up at the budget, submits at 1.5 times it, and asks five requests later', async () => {
    const s = setup();
    await drain();
    expect(budget(s, { role: N }).status).toBe('applied');
    const host = required(s.hosts[0]);
    const executionId = executionOf(s);
    await turns(s, host, N - 1);
    expect(systemDirectives(s.projection())).toHaveLength(0);
    await turn(s, host);
    const [wrap] = systemDirectives(s.projection());
    expect(wrap).toMatchObject({
      origin: 'system',
      targetExecutionId: executionId,
      status: 'queued',
      commandId: null,
      text: REQUEST_BUDGET_NOTICES.wrapUp(N),
    });
    const accepted = s
      .events()
      .find((e) => e.type === 'directive.accepted' && e.payload.directiveId === wrap?.directiveId);
    expect(accepted?.type === 'directive.accepted' && accepted.payload.delivery).toBe(
      'next_request',
    );
    expect(accepted?.actor.kind).toBe('runtime');
    expect(accepted?.commandId).toBeUndefined();
    // The next request carries it, and it is delivered like a person's directive.
    const next = await host.prepareModelRequest();
    expect(next.directives).toEqual([
      { directiveId: wrap?.directiveId, text: wrap?.text, origin: 'system' },
    ]);
    await host.modelRequestDispatched?.(next.modelCallId);
    expect(s.projection().directives[wrap?.directiveId ?? '']?.status).toBe('delivered');
    await host.observe({
      kind: 'model_completed',
      modelCallId: next.modelCallId,
      text: 'response',
      usage: { inputTokens: null, outputTokens: 1 },
      interrupted: true,
    });
    await turns(s, host, SUBMIT - N - 2);
    expect(systemDirectives(s.projection())).toHaveLength(1);
    await turn(s, host);
    const notices = systemDirectives(s.projection());
    expect(notices.map((d) => d.text)).toEqual([
      REQUEST_BUDGET_NOTICES.wrapUp(N),
      REQUEST_BUDGET_NOTICES.submit,
    ]);
    await turns(s, host, 4);
    // ceil(1.5N) + 4: the fifth request after the submit notice still goes out.
    expect(budgetApprovals(s.projection())).toHaveLength(0);
    await turn(s, host);
    expect(Object.keys(s.projection().modelCalls)).toHaveLength(SUBMIT + 5);
    const waiting = host.prepareModelRequest();
    waiting.catch(() => null);
    await drain();
    expect(Object.keys(s.projection().modelCalls)).toHaveLength(SUBMIT + 5);
    expect(s.projection().status).toBe('awaiting_user');
    expect(limits(s.events()).map((e) => e.payload)).toEqual([
      { limitKind: 'request_budget', used: SUBMIT + 5, max: N, executionId },
    ]);
    const [approval] = budgetApprovals(s.projection());
    expect(approval).toMatchObject({
      status: 'pending',
      executionId,
      limit: { kind: 'request_budget', used: SUBMIT + 5, max: N, executionId },
    });
    expect(systemDirectives(s.projection())).toHaveLength(2);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });

  it('counts retries and cut requests as sent requests', async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    const host = required(s.hosts[0]);
    const executionId = executionOf(s);
    const first = await host.prepareModelRequest();
    await host.observe({
      kind: 'model_completed',
      modelCallId: first.modelCallId,
      text: '',
      usage: { inputTokens: null, outputTokens: null },
      interrupted: true,
    });
    const retry = await host.prepareModelRequest(undefined, {
      retryOfModelCallId: first.modelCallId,
    });
    await host.observe({
      kind: 'model_completed',
      modelCallId: retry.modelCallId,
      text: 'response',
      usage: { inputTokens: null, outputTokens: 1 },
    });
    expect(s.projection().requestBudgets?.[executionId]?.used).toBe(2);
    await turns(s, host, N - 2);
    expect(systemDirectives(s.projection())).toHaveLength(1);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });

  it('never counts an execution that answers the conversation directly', async () => {
    const definition = linearCorral(['assistant']);
    definition.roles = definition.roles.map((role) => ({
      ...role,
      answer: 'final_reply' as const,
      allowedWorkTools: [],
      allowedCollaborationTools: [],
    }));
    const s = setup(definition);
    await drain();
    budget(s, { role: N, child: N });
    const host = required(s.hosts[0]);
    await turns(s, host, SUBMIT + 8);
    expect(Object.keys(s.projection().modelCalls)).toHaveLength(SUBMIT + 8);
    expect(systemDirectives(s.projection())).toHaveLength(0);
    expect(budgetApprovals(s.projection())).toHaveLength(0);
    expect(limits(s.events())).toHaveLength(0);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });

  it('a child uses the child budget and a team role the role budget', async () => {
    const s = setup(collaborationCorral());
    await drain();
    budget(s, { role: 100, child: N });
    const parent = required(s.hosts[0]);
    await parent.invokeTool({
      name: 'spawn_subagents',
      args: { tasks: [{ targetNodeId: 'helper', brief: 'Part' }] },
    });
    await drain();
    const child = required(s.hosts[1]);
    const childId = executionOf(s, 1);
    const parentId = executionOf(s, 0);
    await turns(s, child, N);
    expect(systemDirectives(s.projection(), childId)).toHaveLength(1);
    await turns(s, parent, 3);
    // The parent's requests and the child's are counted apart.
    expect(s.projection().requestBudgets?.[parentId]?.used).toBe(3);
    await turns(s, parent, N - 3);
    expect(systemDirectives(s.projection(), parentId)).toHaveLength(0);
    budget(s, { role: N }, 'role');
    // A lowered budget applies from the next judgement on.
    await turns(s, parent, 1);
    expect(systemDirectives(s.projection(), parentId)).toHaveLength(1);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });
});

describe('request budget decisions', () => {
  it('continuing counts again from zero through the same three stages', async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    const host = required(s.hosts[0]);
    const executionId = executionOf(s);
    const { waiting } = await toApproval(s, host);
    expect(resolve(s, 'approve', 'continue').status).toBe('applied');
    const permit = await waiting;
    expect(permit.modelCallId).toBeTruthy();
    expect(s.projection().requestBudgets?.[executionId]?.used).toBe(1);
    await host.observe({
      kind: 'model_completed',
      modelCallId: permit.modelCallId,
      text: 'response',
      usage: { inputTokens: null, outputTokens: 1 },
      interrupted: true,
    });
    await turns(s, host, N - 2);
    expect(systemDirectives(s.projection())).toHaveLength(2);
    await turn(s, host);
    expect(systemDirectives(s.projection())).toHaveLength(3);
    await turns(s, host, SUBMIT - N);
    expect(systemDirectives(s.projection()).map((d) => d.text)).toEqual([
      REQUEST_BUDGET_NOTICES.wrapUp(N),
      REQUEST_BUDGET_NOTICES.submit,
      REQUEST_BUDGET_NOTICES.wrapUp(N),
      REQUEST_BUDGET_NOTICES.submit,
    ]);
    await turns(s, host, 5);
    const again = host.prepareModelRequest();
    again.catch(() => null);
    await drain();
    expect(budgetApprovals(s.projection()).filter((a) => a.status === 'pending')).toHaveLength(1);
    expect(limits(s.events())).toHaveLength(2);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });

  it('stopping ends the run the way a rejected no-progress pause does', async () => {
    const outcome = async (s: Setup, waiting: Promise<RequestPermit>) => {
      const error = await waiting.then(
        () => null,
        (e: Error) => e.message,
      );
      expect(error).toMatch(/stopped$/);
      s.exits[0]?.({ outcome: 'failed', error: required(error) });
      await drain();
      const p = s.projection();
      const execution = required(p.executions[executionOf(s)]);
      return {
        run: p.status,
        reason: p.statusReason,
        execution: execution.status,
        task: Object.values(p.tasks).map((t) => t.status),
        tail: s
          .events()
          .slice(-4)
          .map((e) => e.type),
      };
    };
    const budgeted = setup();
    await drain();
    budget(budgeted, { role: N });
    const { waiting } = await toApproval(budgeted, required(budgeted.hosts[0]));
    expect(resolve(budgeted, 'reject', 'stop').status).toBe('applied');
    const stopped = await outcome(budgeted, waiting);

    const stalled = setup();
    await drain();
    const host = required(stalled.hosts[0]);
    for (let i = 0; i < 6; i++) {
      const permit = await host.prepareModelRequest();
      await host.observe({
        kind: 'model_completed',
        modelCallId: permit.modelCallId,
        text: 'response',
        usage: { inputTokens: null, outputTokens: 1 },
      });
    }
    const paused = host.prepareModelRequest();
    paused.catch(() => null);
    await drain();
    const approval = required(Object.values(stalled.projection().approvals)[0]);
    stalled.send(
      'resolve_approval',
      {
        approvalId: approval.approvalId,
        decision: 'reject',
        subjectVersionId: approval.subjectVersionIds[0],
      },
      'stop',
    );
    expect(stopped).toEqual(await outcome(stalled, paused));
    expect(stopped.run).toBe('failed');
  });

  it('applies one decision once when it is sent twice', async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    const host = required(s.hosts[0]);
    const { waiting } = await toApproval(s, host);
    const first = resolve(s, 'approve', 'continue');
    const [approval] = budgetApprovals(s.projection());
    const repeat = s.send(
      'resolve_approval',
      {
        approvalId: approval?.approvalId,
        decision: 'approve',
        subjectVersionId: approval?.subjectVersionIds[0],
      },
      'continue',
    );
    expect(repeat).toEqual(first);
    const other = s.send(
      'resolve_approval',
      {
        approvalId: approval?.approvalId,
        decision: 'reject',
        subjectVersionId: approval?.subjectVersionIds[0],
      },
      'continue_again',
    );
    expect(other.status).toBe('rejected');
    await waiting;
    expect(
      s
        .events()
        .filter(
          (e) => e.type === 'approval.resolved' && e.payload.approvalId === approval?.approvalId,
        ),
    ).toHaveLength(1);
    expect(s.projection().requestBudgets?.[executionOf(s)]?.used).toBe(1);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });

  it('a gate called again while waiting asks once', async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    const host = required(s.hosts[0]);
    const { waiting } = await toApproval(s, host);
    // The worker gives up and asks again (a retry after its own error).
    const again = host.prepareModelRequest().catch((e: Error) => e.message);
    await drain();
    expect(await again).toMatch(/already in progress/);
    expect(budgetApprovals(s.projection())).toHaveLength(1);
    expect(limits(s.events())).toHaveLength(1);
    resolve(s, 'approve', 'continue');
    await waiting;
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });

  it('cancelling the run while it waits closes the approval and confirms the cancel', async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    const { waiting } = await toApproval(s, required(s.hosts[0]));
    expect(s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel').status).not.toBe(
      'rejected',
    );
    await expect(waiting).rejects.toThrow();
    await drain();
    expect(s.projection().status).toBe('cancelled');
    expect(budgetApprovals(s.projection()).every((a) => a.status !== 'pending')).toBe(true);
    expect(s.events().some((e) => e.type === 'cancel.confirmed')).toBe(true);
  });

  it("keeps a person's directive sent while waiting and delivers it after continuing", async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    const host = required(s.hosts[0]);
    const executionId = executionOf(s);
    const { waiting } = await toApproval(s, host);
    const steer = s.send(
      'steer',
      { targetExecutionId: executionId, text: 'Use primary sources.', delivery: 'next_request' },
      'steer',
    );
    expect(steer.status).toBe('queued');
    const person = required(
      s
        .projection()
        .directiveOrder.map((id) => s.projection().directives[id])
        .at(-1),
    );
    expect(person.origin).toBe('user');
    resolve(s, 'approve', 'continue');
    const permit = await waiting;
    expect(permit.directives).toEqual([
      { directiveId: person.directiveId, text: 'Use primary sources.', origin: 'user' },
    ]);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });
});

describe('request budget switches', () => {
  it('0 in the definition turns it off', async () => {
    const definition = linearCorral(['writer']);
    definition.limits = { ...DEFAULT_LIMITS, requestBudget: { role: 0 } };
    const s = setup(definition);
    await drain();
    const host = required(s.hosts[0]);
    await turns(s, host, 650);
    expect(systemDirectives(s.projection())).toHaveLength(0);
    expect(budgetApprovals(s.projection())).toHaveLength(0);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });

  it('a patch to 0 turns it off from then on; raising it waits for the new stages', async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    const host = required(s.hosts[0]);
    await turns(s, host, N);
    expect(systemDirectives(s.projection())).toHaveLength(1);
    budget(s, { role: 0 }, 'off');
    await turns(s, host, SUBMIT + 10 - N);
    expect(systemDirectives(s.projection())).toHaveLength(1);
    expect(budgetApprovals(s.projection())).toHaveLength(0);
    // On again: the notice already given is not given again; the next stage follows the new value
    // (ceil(1.5 × 56) = 84, already passed).
    budget(s, { role: 56 }, 'raise');
    await turns(s, host, 1);
    expect(systemDirectives(s.projection()).map((d) => d.text)).toEqual([
      REQUEST_BUDGET_NOTICES.wrapUp(N),
      REQUEST_BUDGET_NOTICES.submit,
    ]);
    await turns(s, host, 4);
    expect(budgetApprovals(s.projection())).toHaveLength(0);
    await turn(s, host);
    const waiting = host.prepareModelRequest();
    waiting.catch(() => null);
    await drain();
    expect(limits(s.events()).map((e) => e.payload.max)).toEqual([56]);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });

  it('raising it before a stage moves the stage', async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    const host = required(s.hosts[0]);
    await turns(s, host, N - 1);
    budget(s, { role: 80 }, 'raise');
    await turns(s, host, 30);
    expect(systemDirectives(s.projection())).toHaveLength(0);
    await turn(s, host);
    expect(systemDirectives(s.projection()).map((d) => d.text)).toEqual([
      REQUEST_BUDGET_NOTICES.wrapUp(80),
    ]);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });
});

describe('request budget records', () => {
  it('a notice left when its execution ends expires and is never carried', async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    const host = required(s.hosts[0]);
    await turns(s, host, N);
    const written = await host.invokeTool({ name: 'write_artifact', args: { text: 'done' } });
    if (!written.ok) throw new Error('write refused');
    const submitted = await host.invokeTool({
      name: 'submit_result',
      args: { artifactVersionIds: [written.result.artifactVersionId] },
    });
    expect(submitted.ok).toBe(true);
    required(s.exits[0])({ outcome: 'succeeded' });
    await drain();
    expect(s.projection().executions[executionOf(s)]?.status).toBe('succeeded');
    const [notice] = systemDirectives(s.projection());
    expect(notice?.status).toBe('expired');
    expect(carriedDirectives(s.projection())).toEqual([]);
  });

  it('replaying the events gives the same counts, notices and approval', async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    await toApproval(s, required(s.hosts[0]));
    const replayed = s.events().reduce(applyEvent, emptyProjection(s.runId));
    expect(replayed.requestBudgets).toEqual(s.projection().requestBudgets);
    expect(systemDirectives(replayed)).toEqual(systemDirectives(s.projection()));
    expect(budgetApprovals(replayed)).toEqual(budgetApprovals(s.projection()));
    expect(replayed.requestBudgets?.[executionOf(s)]).toEqual({
      used: SUBMIT + 5,
      wrapAt: N,
      submitAt: SUBMIT,
    });
  });

  it('a backend restarted while it waits keeps one approval and gives no notice again', async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    await toApproval(s, required(s.hosts[0]));
    const before = s.events();
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
            throw new Error('recovery starts nothing');
          },
        },
      });
    const recovered = recover('b').getSnapshot(s.runId).projection;
    await drain();
    expect(recovered.status).toBe('interrupted');
    expect(budgetApprovals(recovered)).toHaveLength(1);
    expect(systemDirectives(recovered)).toHaveLength(2);
    const after = s.store.readEvents(s.runId, 0);
    expect(after.filter((e) => e.type === 'approval.requested')).toHaveLength(
      before.filter((e) => e.type === 'approval.requested').length,
    );
    expect(after.filter((e) => e.type === 'directive.accepted')).toHaveLength(
      before.filter((e) => e.type === 'directive.accepted').length,
    );
    recover('c');
    await drain();
    expect(starts).toBe(0);
    expect(s.store.readEvents(s.runId, 0)).toEqual(after);
  });

  it('a compaction summary call recorded for the execution counts like any request', () => {
    const run = 'run_x';
    const base = {
      runId: run,
      recordedAt: '2026-11-13T00:00:00.000Z',
      actor: { kind: 'runtime', id: 'coordinator' },
    };
    const events = [
      {
        ...base,
        eventId: 'evt_1',
        runSeq: 1,
        type: 'model.request_prepared',
        executionId: 'exec_1',
        payload: {
          executionId: 'exec_1',
          modelCallId: 'call_summary',
          contextSnapshotId: 'ctx_1',
          profile: 'model-a',
          configRevision: 0,
          directiveIds: [],
          inputArtifactVersionIds: [],
        },
      },
    ] as unknown as RunEvent[];
    const p = events.reduce(applyEvent, emptyProjection(run));
    expect(p.requestBudgets?.exec_1?.used).toBe(1);
  });

  it("the person's directive is user and the budget's is system", async () => {
    const s = setup();
    await drain();
    budget(s, { role: N });
    const host = required(s.hosts[0]);
    s.send(
      'steer',
      { targetExecutionId: executionOf(s), text: 'Be brief.', delivery: 'next_request' },
      'steer',
    );
    await turns(s, host, N);
    const p = s.projection();
    expect(p.directiveOrder.map((id) => p.directives[id]?.origin)).toEqual(['user', 'system']);
    const accepted = s.events().filter((e) => e.type === 'directive.accepted');
    expect(accepted.map((e) => e.type === 'directive.accepted' && e.payload.origin)).toEqual([
      'user',
      'system',
    ]);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'end' }, 'cancel');
    await drain();
  });
});
