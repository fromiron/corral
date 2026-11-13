import type {
  AdvisorReviewRequest,
  AgentAdapter,
  AgentHandle,
  AgentHost,
  AgentSettlement,
  AgentStartInput,
  CorralDefinition,
  DeliveredDirective,
  ModelRequestRecord,
  RunEvent,
  ToolOutcome,
} from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  type ScriptedAdvice,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  type DefinitionSource,
  InMemoryRunStore,
  type RunProjection,
  unreadAdvice,
} from '../src/index.ts';

// The advisor's execution and its advice (docs/specs/features/advisor.md). Scripted agents and
// fake replies only.

/** Lets the host run its queued work, macrotasks included. */
async function until(done: () => boolean, what = 'the condition') {
  const deadline = Date.now() + 3_000;
  const host = globalThis as unknown as { setImmediate(fn: () => void): unknown };
  while (!done() && Date.now() < deadline)
    await new Promise<void>((resolve) => host.setImmediate(resolve));
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

/** Lets queued host work run for a while, when the test expects nothing to happen. */
async function idle(turns = 50) {
  const host = globalThis as unknown as { setImmediate(fn: () => void): unknown };
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => host.setImmediate(resolve));
}

/** writer → editor → Output, with an advisor watching the writer. */
function advised(review = { interval: 3, maxRequestsPerReview: 8 }, watches = ['writer']) {
  const definition = linearCorral(['writer', 'editor']);
  definition.roles.push({
    id: 'advisor_role',
    name: 'Reviewer of claims',
    prompt: 'Watch the writer and advise only when it matters.',
    modelProfile: 'model-a',
    allowedWorkTools: ['read_file'],
    allowedCollaborationTools: ['advise'],
    outputContract: 'notes',
  });
  definition.nodes.push({
    id: 'advisor',
    type: 'agent',
    label: 'advisor',
    roleId: 'advisor_role',
    invocation: 'observer',
    outputName: 'notes',
    review,
  } as CorralDefinition['nodes'][number]);
  for (const target of watches)
    definition.capabilityLinks.push({
      id: `watch_${target}`,
      kind: 'advise',
      sourceNodeId: 'advisor',
      targetNodeId: target,
    });
  return definition;
}

interface Setup {
  definition?: CorralDefinition;
  /** Model requests of each scheduled agent, by node; 1 when absent. */
  turns?: Record<string, number>;
  /** Awaited before each reply of a scheduled agent. */
  work?: ScriptedAgentOptions['beforeReply'];
  /** The advisor's scripted side. */
  advisor?: Partial<ScriptedAgentOptions>;
  /** Changes a worker's handle (an interrupt, say). */
  handle?: (handle: AgentHandle, input: AgentStartInput) => AgentHandle;
  /** Approve no-progress pauses on the way (long scripted workers). */
  approveLimits?: boolean;
  /** Scripts that take over a scheduled agent, by node. */
  scripts?: Record<string, ScriptedAgentOptions['script']>;
  /** Real-model mode with fixture models, for request records. */
  live?: boolean;
  /** Saved Teams a `reference` Team node reads. */
  corrals?: DefinitionSource;
}

function setup(options: Setup = {}) {
  const reviews: AdvisorReviewRequest[] = [];
  const outcomes: ToolOutcome[] = [];
  const permits: { nodeId: string; directives: DeliveredDirective[] }[] = [];
  const workers = new Map<string, ScriptedAgentAdapter>();
  const worker = (nodeId: string) => {
    let adapter = workers.get(nodeId);
    if (!adapter) {
      adapter = new ScriptedAgentAdapter({
        turns: options.turns?.[nodeId] ?? 1,
        beforeReply: options.work,
        ...(options.scripts?.[nodeId] ? { script: options.scripts[nodeId] } : {}),
        reply: (turn, input, permit) => {
          permits.push({ nodeId: input.nodeId, directives: permit.directives });
          return `${input.nodeId} answer ${turn}`;
        },
      });
      workers.set(nodeId, adapter);
    }
    return adapter;
  };
  const advisor = new ScriptedAgentAdapter({
    turns: 1,
    reply: (turn) => `review turn ${turn}`,
    ...options.advisor,
    reviewTurns: (review, input) => {
      reviews.push(review);
      return options.advisor?.reviewTurns?.(review, input) ?? 1;
    },
    onAdvised: (outcome, review) => {
      outcomes.push(outcome);
      options.advisor?.onAdvised?.(outcome, review);
    },
  });
  const agents: AgentAdapter = {
    async start(input, host) {
      const handle = await (input.assignment.kind === 'advisor'
        ? advisor
        : worker(input.nodeId)
      ).start(input, host);
      return options.handle ? options.handle(handle, input) : handle;
    },
  };
  const store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents,
    ...(options.corrals ? { corrals: options.corrals } : {}),
    ...(options.live
      ? {
          models: {
            resolve: (profile: string) => ({
              ok: true as const,
              snapshot: {
                profile,
                provider: 'fixture',
                modelId: 'fixture',
                auth: 'api_key' as const,
              },
            }),
          },
        }
      : {}),
  });
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: options.live ? 'live' : 'mock',
    definition: options.definition ?? advised(),
  });
  if (!started.runId) throw new Error(JSON.stringify(started));
  const runId = started.runId;
  const projection = (): RunProjection => coordinator.getSnapshot(runId).projection;
  const events = (): RunEvent[] => store.readEvents(runId, 0);
  const approve = () => {
    if (!options.approveLimits) return;
    const p = projection();
    for (const approval of Object.values(p.approvals))
      if (approval.status === 'pending')
        coordinator.submit({
          schemaVersion: '0.1',
          commandId: `approve_${approval.approvalId}`,
          runId,
          type: 'resolve_approval',
          expectedControlRevision: p.controlRevision,
          payload: {
            approvalId: approval.approvalId,
            decision: 'approve',
            subjectVersionId: approval.subjectVersionIds[0] ?? '',
          },
        });
  };
  const wait = (done: (p: RunProjection) => boolean, what?: string) =>
    until(() => {
      approve();
      return done(projection());
    }, what);
  const ended = () =>
    wait((p) => ['succeeded', 'failed', 'cancelled'].includes(p.status), 'the run to end');
  const advisorExecution = () =>
    Object.values(projection().executions).find((e) => e.nodeId === 'advisor');
  const executionOf = (nodeId: string) =>
    Object.values(projection().executions).find((e) => e.nodeId === nodeId);
  return {
    coordinator,
    store,
    runId,
    projection,
    events,
    reviews,
    outcomes,
    permits,
    wait,
    ended,
    advisorExecution,
    executionOf,
  };
}

const advice = (s: ReturnType<typeof setup>) =>
  s.outcomes.map((o) => (o.ok ? o.result.advice : { error: o.error.code }));
/** Each advice's delivery, or why it was dropped. */
const fates = (s: ReturnType<typeof setup>) =>
  s.outcomes.map((o) => {
    const result = o.ok ? (o.result.advice as { delivery?: string; reason?: string }) : null;
    return result?.delivery ?? result?.reason ?? (o.ok ? null : o.error.code);
  });

/** One model request through the host, as a worker makes it. */
async function call(host: AgentHost, text: string, record?: ModelRequestRecord) {
  const permit = await host.prepareModelRequest(record);
  await host.modelRequestDispatched?.(permit.modelCallId);
  await host.observe({
    kind: 'model_completed',
    modelCallId: permit.modelCallId,
    text,
    usage: { inputTokens: 10, outputTokens: 5 },
  });
}

/** Writes its last answer and submits it, as a scheduled worker ends. */
async function submit(host: AgentHost, text: string): Promise<AgentSettlement> {
  const written = await host.invokeTool({ name: 'write_artifact', args: { text } });
  if (!written.ok) return { outcome: 'failed', error: written.error.message };
  const submitted = await host.invokeTool({
    name: 'submit_result',
    args: { artifactVersionIds: [written.result.artifactVersionId] },
  });
  return submitted.ok ? { outcome: 'succeeded' } : { outcome: 'failed' };
}

describe('reviews', () => {
  it('a review starts when the watched execution finished the interval of requests', async () => {
    const s = setup({ turns: { writer: 3 } });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    const writer = s.executionOf('writer');
    const first = s.reviews[0];
    expect(first?.targetExecutionId).toBe(writer?.executionId);
    for (const turn of [1, 2, 3]) expect(first?.text).toContain(`writer answer ${turn}`);
    // The first review reads the task the writer was given.
    expect(first?.text).toContain('Compare two options using primary sources.');
    // The editor is not watched.
    expect(s.reviews.every((r) => r.targetExecutionId === writer?.executionId)).toBe(true);
    expect(s.advisorExecution()?.status).toBe('succeeded');
  });

  it('no review starts before the interval', async () => {
    const gate = new Gate();
    const s = setup({
      turns: { writer: 3 },
      work: async (turn, input) => {
        if (input.nodeId === 'writer' && turn === 3) await gate.wait();
      },
    });
    await s.wait((p) => Object.values(p.modelCalls).filter((c) => c.finished).length === 2);
    await idle();
    expect(s.reviews).toHaveLength(0);
    expect(s.advisorExecution()).toBeUndefined();
    gate.open();
    await s.ended();
    expect(s.reviews.length).toBeGreaterThan(0);
  });

  it('six calls finished during a review are read by one next review', async () => {
    const reviewing = new Gate();
    const s = setup({
      turns: { writer: 9 },
      approveLimits: true,
      work: async (turn, input) => {
        // The writer waits for the first review to be under way before its fourth call.
        if (input.nodeId === 'writer' && turn === 4) await until(() => s.reviews.length === 1);
      },
      advisor: {
        beforeReply: async () => {
          if (s.reviews.length === 1) await reviewing.wait();
        },
      },
    });
    await s.wait((p) => Object.values(p.modelCalls).filter((c) => c.finished).length >= 9);
    expect(s.reviews).toHaveLength(1);
    reviewing.open();
    await s.ended();
    const second = s.reviews[1];
    for (const turn of [4, 5, 6, 7, 8, 9]) expect(second?.text).toContain(`writer answer ${turn}`);
    expect(second?.text).not.toContain('writer answer 3\n');
    // Then only the writer's end is left to read: never one review per call.
    expect(s.reviews.length).toBeLessThanOrEqual(3);
  });

  it('reviews of two watched executions run one after the other', async () => {
    const first = new Gate();
    const definition = advised({ interval: 1, maxRequestsPerReview: 8 }, ['writer', 'editor']);
    let open = 0;
    let most = 0;
    const s = setup({
      definition,
      advisor: {
        beforeReply: async () => {
          open += 1;
          most = Math.max(most, open);
          if (s.reviews.length === 1) await first.wait();
          open -= 1;
        },
      },
      work: async (_turn, input) => {
        // The editor's call ends while the writer's review is still running.
        if (input.nodeId === 'editor') first.open();
      },
    });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    const writer = s.executionOf('writer')?.executionId;
    const editor = s.executionOf('editor')?.executionId;
    const order = s.reviews.map((r) => r.targetExecutionId);
    expect(order[0]).toBe(writer);
    expect(order).toContain(editor);
    expect(most).toBe(1);
  });

  it('a compaction call is neither counted toward the interval nor read', async () => {
    const compaction: ModelRequestRecord = {
      purpose: 'compaction',
      runtime: 'pi-core',
      contextHash: 'a'.repeat(64),
      contextBytes: 100,
      directiveIds: [],
      sections: [],
    };
    const s = setup({
      live: true,
      definition: advised({ interval: 2, maxRequestsPerReview: 8 }),
      scripts: {
        writer: async (_input, host) => {
          await call(host, 'writer answer 1');
          await call(host, 'the compaction summary', compaction);
          await until(() => true);
          const before = s.reviews.length;
          await call(host, 'writer answer 3');
          await until(() => s.reviews.length > before, 'a review after the third call');
          return submit(host, 'writer answer 3');
        },
      },
    });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    const first = s.reviews[0];
    expect(first?.text).toContain('writer answer 1');
    expect(first?.text).toContain('writer answer 3');
    expect(first?.text).not.toContain('the compaction summary');
  });
});

describe('advice', () => {
  /**
   * The first review advises the writer while its second request is out (prepared before the
   * advice, so it cannot carry it); a third request, by default, then reads it.
   */
  function adviseOnce(advice: ScriptedAdvice[], extra: Setup = {}) {
    const given = new Gate();
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }),
      turns: { writer: 3 },
      ...extra,
      work: async (turn, input) => {
        if (input.nodeId === 'writer' && turn === 2) await given.wait();
        await extra.work?.(turn, input);
      },
      advisor: {
        ...extra.advisor,
        advise: (review, input) =>
          s.reviews.length === 1 ? advice : (extra.advisor?.advise?.(review, input) ?? []),
        onAdvised: () => {
          if (s.outcomes.length === advice.length) given.open();
        },
      },
    });
    return s;
  }

  it('a concern is delivered as an advice directive on the target’s next request', async () => {
    const s = adviseOnce([{ severity: 'concern', note: 'The 2024 figure is from 2019.' }]);
    await s.ended();
    expect(advice(s)).toEqual([
      { outcome: 'admitted', adviceId: expect.any(String), delivery: 'next_request' },
    ]);
    const second = s.permits.find((p) => p.nodeId === 'writer' && p.directives.length);
    expect(second?.directives).toEqual([
      {
        directiveId: expect.any(String),
        text: 'The 2024 figure is from 2019.',
        origin: 'advice',
        advice: { severity: 'concern', from: 'Reviewer of claims' },
      },
    ]);
    const [directive] = Object.values(s.projection().directives);
    expect(directive).toMatchObject({
      origin: 'advice',
      status: 'delivered',
      targetExecutionId: s.executionOf('writer')?.executionId,
      advice: { severity: 'concern', observerExecutionId: s.advisorExecution()?.executionId },
    });
    const admitted = s.events().find((e) => e.type === 'advice.admitted');
    expect(admitted?.payload).toMatchObject({
      delivery: 'next_request',
      directiveId: directive?.directiveId,
    });
    expect(admitted?.actor).toEqual({ kind: 'agent', id: s.advisorExecution()?.executionId });
    // The receipt follows its directive.
    const outcome = s.outcomes[0];
    const receipt = outcome?.ok
      ? s.coordinator.getReceipt(s.runId, outcome.result.commandId as string)
      : null;
    expect(receipt).toMatchObject({ status: 'applied', advice: { delivery: 'next_request' } });
  });

  it('a blocker interrupts a target that can be cut', async () => {
    const cut: DeliveredDirective[] = [];
    const s = adviseOnce([{ severity: 'blocker', note: 'Stop: the brief asks for two options.' }], {
      handle: (handle, input) =>
        input.nodeId === 'writer' ? { ...handle, interrupt: (d) => cut.push(d) } : handle,
    });
    await s.ended();
    expect(advice(s)).toEqual([
      { outcome: 'admitted', adviceId: expect.any(String), delivery: 'interrupt' },
    ]);
    expect(cut).toEqual([
      expect.objectContaining({
        origin: 'advice',
        advice: { severity: 'blocker', from: 'Reviewer of claims' },
      }),
    ]);
    const accepted = s.events().find((e) => e.type === 'directive.accepted');
    expect(accepted?.payload).toMatchObject({ delivery: 'interrupt', origin: 'advice' });
  });

  it('a blocker to a target that cannot be cut is lowered to its next request', async () => {
    const s = adviseOnce([{ severity: 'blocker', note: 'Stop: the brief asks for two options.' }]);
    await s.ended();
    expect(advice(s)).toEqual([
      { outcome: 'admitted', adviceId: expect.any(String), delivery: 'next_request' },
    ]);
    const accepted = s.events().find((e) => e.type === 'directive.accepted');
    expect(accepted?.payload).toMatchObject({ delivery: 'next_request', origin: 'advice' });
    expect(s.events().find((e) => e.type === 'advice.admitted')?.payload).toMatchObject({
      severity: 'blocker',
      delivery: 'next_request',
    });
  });

  it('the gatekeeper’s reasons come back in the receipt, and dropped text is not recorded', async () => {
    const s = adviseOnce([
      { severity: 'nit', note: 'LGTM' },
      { severity: 'nit', note: 'Name the second source.' },
      { severity: 'nit', note: 'name the second source' },
      { severity: 'concern', note: 'Name the second source!' },
      { severity: 'nit', note: 'Shorten the intro.' },
      { severity: 'nit', note: 'Define the acronym.' },
      { severity: 'blocker', note: 'The first option is not in the brief.' },
    ]);
    await s.ended();
    expect(fates(s)).toEqual([
      'noise',
      'next_request',
      'duplicate',
      'next_request',
      'next_request',
      'over_budget',
      'next_request',
    ]);
    const suppressed = s.events().filter((e) => e.type === 'advice.suppressed');
    expect(suppressed.map((e) => e.type === 'advice.suppressed' && e.payload.reason)).toEqual([
      'noise',
      'duplicate',
      'over_budget',
    ]);
    const log = JSON.stringify(s.events());
    expect(log).not.toContain('LGTM');
    expect(log).not.toContain('Define the acronym.');
  });

  it('after the target ended, a note is dropped and a concern is kept with its note', async () => {
    const s = setup({
      advisor: {
        advise: (review) =>
          s.projection().executions[review.targetExecutionId]?.status === 'succeeded'
            ? [
                { severity: 'nit', note: 'Shorten the intro.' },
                { severity: 'concern', note: 'The second source is a blog.' },
              ]
            : [],
      },
    });
    await s.ended();
    expect(advice(s)).toEqual([
      { outcome: 'suppressed', reason: 'target_terminal' },
      { outcome: 'admitted', adviceId: expect.any(String), delivery: 'preserve' },
    ]);
    const kept = Object.values(s.projection().advice ?? {});
    expect(kept).toEqual([
      expect.objectContaining({
        severity: 'concern',
        delivery: 'preserve',
        directiveId: null,
        note: 'The second source is a blog.',
      }),
    ]);
    // Kept for the person; the dropped note is not.
    expect(unreadAdvice(s.projection())).toEqual([
      expect.objectContaining({
        severity: 'concern',
        text: 'The second source is a blog.',
        state: 'preserved',
      }),
    ]);
    // Nothing woke the ended writer.
    expect(s.projection().directiveOrder).toEqual([]);
    expect(s.projection().status).toBe('succeeded');
  });

  it('a note to an ended target takes no place in the gatekeeper’s budget', async () => {
    const s = setup({
      advisor: {
        advise: (review) =>
          s.projection().executions[review.targetExecutionId]?.status === 'succeeded'
            ? [
                { severity: 'nit', note: 'One.' },
                { severity: 'nit', note: 'Two.' },
                { severity: 'nit', note: 'Three.' },
                { severity: 'nit', note: 'Four.' },
                { severity: 'concern', note: 'One.' },
              ]
            : [],
      },
    });
    await s.ended();
    expect(advice(s).at(-1)).toEqual({
      outcome: 'admitted',
      adviceId: expect.any(String),
      delivery: 'preserve',
    });
  });

  it('advice its target never read is listed for the person, preserved advice too', async () => {
    const { unreadAdvice } = await import('../src/index.ts');
    const s = adviseOnce([{ severity: 'concern', note: 'Check the 2019 figure.' }], {
      // The writer ends before another request reads the advice.
      turns: { writer: 2 },
    });
    await s.ended();
    const unread = unreadAdvice(s.projection());
    expect(unread).toEqual([
      {
        adviceId: expect.any(String),
        targetExecutionId: s.executionOf('writer')?.executionId,
        observerExecutionId: s.advisorExecution()?.executionId,
        severity: 'concern',
        text: 'Check the 2019 figure.',
        state: 'expired',
      },
    ]);
  });

  it('an unread note is not listed, nor is advice its target read', () => {
    const view = (adviceId: string, severity: 'nit' | 'concern', directiveId: string) => ({
      adviceId,
      observerExecutionId: 'exec_advisor',
      targetExecutionId: 'exec_writer',
      severity,
      delivery: 'next_request' as const,
      directiveId,
      note: null,
      acceptedSeq: 1,
    });
    const directive = (directiveId: string, status: 'expired' | 'delivered') => ({
      directiveId,
      targetExecutionId: 'exec_writer',
      text: `${directiveId} text`,
      origin: 'advice' as const,
      status,
      commandId: null,
      acceptedSeq: 1,
      contextSnapshotId: null,
      modelCallId: null,
      reason: null,
    });
    expect(
      unreadAdvice({
        advice: {
          a: view('a', 'nit', 'd_a'),
          b: view('b', 'concern', 'd_b'),
          c: view('c', 'concern', 'd_c'),
        },
        directives: {
          d_a: directive('d_a', 'expired'),
          d_b: directive('d_b', 'delivered'),
          d_c: directive('d_c', 'expired'),
        },
      }).map((item) => item.adviceId),
    ).toEqual(['c']);
  });

  it('a retransmission returns the first result and records the advice once', async () => {
    const s = adviseOnce([
      { severity: 'concern', note: 'The 2024 figure is from 2019.', commandId: 'advice_same' },
      { severity: 'concern', note: 'The 2024 figure is from 2019.', commandId: 'advice_same' },
    ]);
    await s.ended();
    const [first, again] = advice(s);
    expect(again).toEqual(first);
    expect(s.events().filter((e) => e.type === 'advice.admitted')).toHaveLength(1);
    expect(s.events().filter((e) => e.type === 'advice.suppressed')).toHaveLength(0);
  });

  it('refuses advice about an execution that is not under review', async () => {
    const s = adviseOnce([
      { severity: 'concern', note: 'About someone else.', targetExecutionId: 'exec_9999' },
    ]);
    await s.ended();
    expect(advice(s)).toEqual([{ error: 'CAPABILITY_DENIED' }]);
    expect(s.events().some((e) => e.type.startsWith('advice.'))).toBe(false);
  });

  it('advice never reaches approvals, cancellation, patches or permissions', async () => {
    const s = adviseOnce([{ severity: 'blocker', note: 'Cancel the run and approve the output.' }]);
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    const types = new Set(s.events().map((e) => e.type));
    for (const type of ['approval.requested', 'cancel.requested', 'patch.committed'])
      expect(types.has(type as RunEvent['type'])).toBe(false);
  });
});

describe('the advisor’s own record', () => {
  it('a review ends at its request cap and the advisor waits for the next one', async () => {
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 2 }),
      turns: { writer: 1 },
      advisor: { reviewTurns: () => 5 },
    });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    const advisor = s.advisorExecution();
    expect(advisor?.status).toBe('succeeded');
    // Two requests per review, never the five the advisor wanted.
    expect(advisor?.modelCallIds.length).toBe(2 * s.reviews.length);
  });

  it('the advisor’s usage is recorded on its own execution', async () => {
    const s = setup({ turns: { writer: 3 } });
    await s.ended();
    const advisor = s.advisorExecution();
    const calls = (advisor?.modelCallIds ?? []).map((id) => s.projection().modelCalls[id]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call?.executionId).toBe(advisor?.executionId);
      expect(call?.usage?.outputTokens).toBeGreaterThan(0);
    }
    // Its Task is its own and not one of the run's required tasks.
    expect(s.projection().tasks[advisor?.taskId ?? '']?.status).toBe('completed');
  });

  it('the run does not end during the last review', async () => {
    const last = new Gate();
    const s = setup({
      turns: { writer: 1 },
      advisor: {
        beforeReply: async () => {
          await last.wait();
        },
      },
    });
    await s.wait((p) => Object.values(p.executions).some((e) => e.nodeId === 'advisor'));
    await s.wait(
      (p) => p.executions[s.executionOf('editor')?.executionId ?? '']?.status === 'succeeded',
    );
    await idle();
    expect(s.projection().status).toBe('running');
    expect(s.projection().output).toBeNull();
    last.open();
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    const settledAt = s
      .events()
      .findIndex(
        (e) =>
          e.type === 'execution.settled' &&
          e.payload.executionId === s.advisorExecution()?.executionId,
      );
    const finalizedAt = s.events().findIndex((e) => e.type === 'output.finalized');
    expect(settledAt).toBeLessThan(finalizedAt);
  });

  it('cancelling the run cancels the advisor before the run is cancelled', async () => {
    const hold = new Gate();
    const s = setup({
      turns: { writer: 1 },
      advisor: { beforeReply: () => hold.wait() },
    });
    await s.wait((p) => Object.values(p.executions).some((e) => e.nodeId === 'advisor'));
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel',
      runId: s.runId,
      type: 'cancel',
      expectedControlRevision: s.projection().controlRevision,
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    hold.open();
    await s.ended();
    expect(s.projection().status).toBe('cancelled');
    expect(s.advisorExecution()?.status).toBe('cancelled');
    const settledAt = s
      .events()
      .findIndex(
        (e) =>
          e.type === 'execution.settled' &&
          e.payload.executionId === s.advisorExecution()?.executionId,
      );
    const cancelledAt = s
      .events()
      .findIndex((e) => e.type === 'run.state_changed' && e.payload.to === 'cancelled');
    expect(settledAt).toBeLessThan(cancelledAt);
  });

  it('cancelling the run reaches an advisor resting between reviews', async () => {
    const hold = new Gate();
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }),
      turns: { writer: 2 },
      work: async (turn, input) => {
        if (input.nodeId === 'writer' && turn === 2) await hold.wait();
      },
    });
    await s.wait((p) => {
      const advisor = Object.values(p.executions).find((e) => e.nodeId === 'advisor');
      return advisor?.status === 'waiting_message';
    }, 'the advisor to rest');
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel',
      runId: s.runId,
      type: 'cancel',
      expectedControlRevision: s.projection().controlRevision,
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    hold.open();
    await s.ended();
    expect(s.projection().status).toBe('cancelled');
    expect(s.advisorExecution()?.status).toBe('cancelled');
  });

  it('pausing the run reaches the advisor: no review request goes out until resume', async () => {
    const hold = new Gate();
    const s = setup({
      turns: { writer: 3 },
      work: async (turn, input) => {
        if (input.nodeId === 'writer' && turn === 3) await hold.wait();
      },
    });
    await s.wait((p) => Object.values(p.modelCalls).filter((c) => c.finished).length === 2);
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'pause',
      runId: s.runId,
      type: 'pause',
      expectedControlRevision: s.projection().controlRevision,
      payload: { scope: 'run' },
    });
    hold.open();
    await s.wait((p) => p.status === 'paused', 'the pause');
    await idle();
    const advisor = s.advisorExecution();
    expect(advisor?.modelCallIds ?? []).toEqual([]);
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'resume',
      runId: s.runId,
      type: 'resume',
      expectedControlRevision: s.projection().controlRevision,
      payload: { scope: 'run' },
    });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    expect(s.advisorExecution()?.modelCallIds.length).toBeGreaterThan(0);
  });

  it('a review that falls due while the run is paused waits for resume', async () => {
    const hold = new Gate();
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }),
      turns: { writer: 3 },
      work: async (turn, input) => {
        if (input.nodeId === 'writer' && turn === 3) await hold.wait();
      },
    });
    await s.wait(
      (p) =>
        s.reviews.length === 2 &&
        Object.values(p.executions).find((e) => e.nodeId === 'advisor')?.status ===
          'waiting_message',
      'the advisor to rest after two reviews',
    );
    const control = (type: 'pause' | 'resume') =>
      s.coordinator.submit({
        schemaVersion: '0.1',
        commandId: type,
        runId: s.runId,
        type,
        expectedControlRevision: s.projection().controlRevision,
        payload: { scope: 'run' },
      });
    control('pause');
    // The writer's third answer schedules a review while the run is pausing.
    hold.open();
    await s.wait((p) => p.status === 'paused', 'the pause');
    await idle();
    expect(s.reviews).toHaveLength(2);
    expect(s.advisorExecution()?.status).toBe('waiting_message');
    control('resume');
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    expect(s.reviews.length).toBeGreaterThan(2);
  });

  it('cancelling only the advisor does not hold the run for a person', async () => {
    const hold = new Gate();
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }),
      turns: { writer: 2 },
      work: async (turn, input) => {
        if (input.nodeId === 'writer' && turn === 2) await hold.wait();
      },
    });
    await s.wait(
      (p) =>
        Object.values(p.executions).find((e) => e.nodeId === 'advisor')?.status ===
        'waiting_message',
      'the advisor to rest',
    );
    const advisor = s.advisorExecution()?.executionId ?? '';
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel_advisor',
      runId: s.runId,
      type: 'cancel',
      expectedControlRevision: s.projection().controlRevision,
      payload: { scope: { kind: 'execution', executionId: advisor }, reason: 'not needed' },
    });
    await s.wait((p) => p.executions[advisor]?.status === 'cancelled', 'the advisor to stop');
    expect(s.projection().status).toBe('running');
    hold.open();
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    expect(s.events().some((e) => e.type === 'task.blocked')).toBe(false);
  });

  it('an advisor that fails changes neither the run’s result nor its output, and reviews no more', async () => {
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }),
      turns: { writer: 3 },
      advisor: {
        beforeReply: async () => {
          throw new Error('the advisor model broke');
        },
      },
    });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    expect(s.projection().output).not.toBeNull();
    expect(s.advisorExecution()?.status).toBe('failed');
    expect(s.reviews).toHaveLength(1);
    expect(
      Object.values(s.projection().executions).filter((e) => e.nodeId === 'advisor'),
    ).toHaveLength(1);
  });
});

describe('who may give advice', () => {
  it('refuses advice from an attempt that is not the advisor’s current one', async () => {
    const hold = new Gate();
    const s = setup({ turns: { writer: 1 }, advisor: { beforeReply: () => hold.wait() } });
    await s.wait((p) => Object.values(p.executions).some((e) => e.nodeId === 'advisor'));
    await until(() => s.reviews.length === 1);
    const advisor = s.advisorExecution();
    const submit = (attemptNo: number, observerExecutionId = advisor?.executionId ?? '') =>
      (
        s.coordinator as unknown as {
          submitAdvice(command: unknown): { status: string; error?: { code: string } };
        }
      ).submitAdvice({
        schemaVersion: '0.1',
        commandId: `advice_attempt_${attemptNo}_${observerExecutionId}`,
        runId: s.runId,
        type: 'submit_advice',
        payload: {
          observerExecutionId,
          attemptNo,
          targetExecutionId: s.reviews[0]?.targetExecutionId,
          severity: 'concern',
          note: 'The cited figure is from 2019.',
        },
      });
    expect(submit(2).error?.code).toBe('TARGET_TERMINAL');
    expect(submit(1, s.executionOf('editor')?.executionId).error?.code).toBe('TARGET_TERMINAL');
    expect(s.events().some((e) => e.type.startsWith('advice.'))).toBe(false);
    // The current attempt about the execution under review is admitted.
    expect(submit(1)).toMatchObject({ status: 'accepted' });
    hold.open();
    await s.ended();
  });

  it('an advisor of a referenced Team runs', async () => {
    const saved = advised();
    saved.id = 'saved';
    const top = linearCorral(['lead'], 'top');
    top.nodes.push({
      id: 'team',
      type: 'team',
      label: 'team',
      source: { kind: 'reference', corralId: 'saved', definitionRevision: 1 },
    });
    top.controlEdges = [
      { id: 'e1', source: 'lead', sourcePort: 'out', target: 'team', targetPort: 'enter' },
      { id: 'e2', source: 'team', sourcePort: 'next', target: 'output', targetPort: 'in' },
    ];
    const s = setup({
      definition: top,
      corrals: { getDefinition: (id) => (id === 'saved' ? saved : null) },
    });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    const advisor = s.executionOf('team.advisor');
    expect(advisor?.status).toBe('succeeded');
    const writer = s.executionOf('team.writer');
    expect(s.reviews.map((r) => r.targetExecutionId)).toContain(writer?.executionId);
  });
});

describe('advice and the session queue', () => {
  it('an advice directive its target never read is not carried to the queue', async () => {
    const { carriedDirectives } = await import('../src/index.ts');
    const given = new Gate();
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }),
      turns: { writer: 2 },
      work: async (turn, input) => {
        if (input.nodeId === 'writer' && turn === 2) await given.wait();
      },
      advisor: {
        advise: () =>
          s.reviews.length === 1 ? [{ severity: 'concern', note: 'Name the source.' }] : [],
        onAdvised: () => given.open(),
      },
    });
    await s.ended();
    const expired = Object.values(s.projection().directives).filter((d) => d.status === 'expired');
    expect(expired.map((d) => d.origin)).toEqual(['advice']);
    expect(carriedDirectives(s.projection())).toEqual([]);
  });
});
