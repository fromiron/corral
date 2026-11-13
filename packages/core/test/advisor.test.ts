import type {
  AdvisorReviewRequest,
  AgentAdapter,
  AgentHandle,
  AgentHost,
  AgentSettlement,
  AgentStartInput,
  CorralDefinition,
  DeliveredDirective,
  EffectiveHarnessSnapshot,
  ModelRequestRecord,
  RunEvent,
  ToolOutcome,
} from '@corral/contracts';
import { DEFAULT_LIMITS } from '@corral/contracts';
import {
  collaborationCorral,
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
  DEFAULT_GATES,
  type DefinitionSource,
  emptyProjection,
  type FileTools,
  type HarnessResolver,
  InMemoryRunStore,
  type RunProjection,
  SPEC_HARD_CAPS,
  type ToolGateView,
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

/**
 * writer → editor → Output, with an advisor watching the writer. Its role lists no collaboration
 * tools: `advise` and `read_artifact` are the Coordinator's to give.
 */
function advised(
  review = { interval: 3, maxRequestsPerReview: 8 },
  watches = ['writer'],
  collaboration: CorralDefinition['roles'][number]['allowedCollaborationTools'] = [],
) {
  const definition = linearCorral(['writer', 'editor']);
  definition.roles.push({
    id: 'advisor_role',
    name: 'Reviewer of claims',
    prompt: 'Watch the writer and advise only when it matters.',
    modelProfile: 'model-a',
    allowedWorkTools: ['read_file'],
    allowedCollaborationTools: collaboration,
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
  /** The work folders the Coordinator is told of. */
  workspaceRoots?: readonly string[];
  /** The file tools a writer may use. */
  files?: FileTools;
  store?: InMemoryRunStore;
  /** Work styles the roles are bound to. */
  harnesses?: HarnessResolver;
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
  const store = options.store ?? new InMemoryRunStore();
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents,
    ...(options.corrals ? { corrals: options.corrals } : {}),
    ...(options.workspaceRoots ? { workspaceRoots: () => options.workspaceRoots ?? [] } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.harnesses ? { harnesses: options.harnesses } : {}),
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
  const wait = (done: (p: RunProjection) => boolean, what?: string) =>
    until(() => done(projection()), what);
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

  it('calls finished during a review are read by one next review', async () => {
    const reviewing = new Gate();
    // Five calls in all: the writer's own count stays below the no-progress pause.
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }),
      turns: { writer: 5 },
      work: async (turn, input) => {
        // The writer waits for the first review to be under way before its second call.
        if (input.nodeId === 'writer' && turn === 2) await until(() => s.reviews.length === 1);
      },
      advisor: {
        beforeReply: async () => {
          if (s.reviews.length === 1) await reviewing.wait();
        },
      },
    });
    await s.wait(
      (p) =>
        Object.values(p.modelCalls).filter(
          (c) => c.finished && p.executions[c.executionId]?.nodeId === 'writer',
        ).length >= 5,
    );
    await idle();
    expect(s.reviews).toHaveLength(1);
    reviewing.open();
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    const second = s.reviews[1];
    for (const turn of [2, 3, 4, 5]) expect(second?.text).toContain(`writer answer ${turn}`);
    expect(second?.text).not.toContain('writer answer 1\n');
    // Then only the writer's end is left to read: never one review per call.
    expect(s.reviews.length).toBeLessThanOrEqual(3);
  });

  it('two advisors watching one execution each read every answer and the task input', async () => {
    const definition = advised({ interval: 1, maxRequestsPerReview: 8 });
    definition.nodes.push({
      id: 'advisor_b',
      type: 'agent',
      label: 'advisor b',
      roleId: 'advisor_role',
      invocation: 'observer',
      outputName: 'notes',
      review: { interval: 1, maxRequestsPerReview: 8 },
    } as CorralDefinition['nodes'][number]);
    definition.capabilityLinks.push({
      id: 'watch_b',
      kind: 'advise',
      sourceNodeId: 'advisor_b',
      targetNodeId: 'writer',
    });
    const read: Record<string, string[]> = { advisor: [], advisor_b: [] };
    const s = setup({
      definition,
      turns: { writer: 3 },
      // Each writer request waits for the reviews of the one before to be handed out.
      work: async (turn, input) => {
        if (input.nodeId === 'writer' && turn > 1) await idle(40);
      },
      advisor: {
        reviewTurns: (review, input) => {
          read[input.nodeId]?.push(review.text);
          return 1;
        },
      },
    });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    for (const nodeId of ['advisor', 'advisor_b']) {
      const texts = read[nodeId] ?? [];
      expect(texts[0]).toContain('Compare two options using primary sources.');
      for (const turn of [1, 2, 3]) expect(texts.join('\n')).toContain(`writer answer ${turn}`);
    }
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

  it('a role that lists advise itself advises the same way', async () => {
    const s = adviseOnce([{ severity: 'concern', note: 'The 2024 figure is from 2019.' }], {
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }, ['writer'], ['advise']),
    });
    await s.ended();
    expect(fates(s)).toEqual(['next_request']);
  });

  it('a retransmission of the same advise call returns the first result and records it once', async () => {
    const results: ToolOutcome[] = [];
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }),
      advisor: {
        script: async (_input, host) => {
          for (;;) {
            const review = await host.nextReview?.();
            if (!review) return { outcome: 'succeeded' };
            if (results.length > 0) continue;
            await call(host, 'reviewing');
            const authorized = await host.authorizeTool({
              name: 'advise',
              args: { severity: 'concern', note: 'The 2024 figure is from 2019.' },
            });
            if (!authorized.ok) throw new Error(authorized.error.message);
            results.push(await host.executeTool(authorized.toolCallId));
            results.push(await host.executeTool(authorized.toolCallId));
          }
        },
      },
    });
    await s.ended();
    const [first, again] = results;
    expect(first?.ok).toBe(true);
    expect(again).toEqual(first);
    expect(s.events().filter((e) => e.type === 'advice.admitted')).toHaveLength(1);
    expect(s.events().filter((e) => e.type === 'advice.suppressed')).toHaveLength(0);
  });

  it('the same note from another advise call is a duplicate', async () => {
    const note = 'The 2024 figure is from 2019.';
    const s = adviseOnce([
      { severity: 'concern', note },
      { severity: 'concern', note },
    ]);
    await s.ended();
    expect(fates(s)).toEqual(['next_request', 'duplicate']);
  });

  it('refuses advice outside a review: there is no execution under review', async () => {
    const results: ToolOutcome[] = [];
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }),
      advisor: {
        script: async (_input, host) => {
          results.push(
            await host.invokeTool({
              name: 'advise',
              args: { severity: 'concern', note: 'Before any review.' },
            }),
          );
          while (await host.nextReview?.()) {}
          return { outcome: 'succeeded' };
        },
      },
    });
    await s.ended();
    expect(results.map((o) => (o.ok ? null : o.error.code))).toEqual(['CAPABILITY_DENIED']);
    expect(s.events().some((e) => e.type.startsWith('advice.'))).toBe(false);
  });

  it('the model names neither the target nor the command id of its advice', async () => {
    const s = adviseOnce([
      { severity: 'concern', note: 'About someone else.', targetExecutionId: 'exec_9999' },
      { severity: 'concern', note: 'With a command id.', commandId: 'advice_forged' },
    ]);
    await s.ended();
    expect(advice(s)).toEqual([{ error: 'SCHEMA_INVALID' }, { error: 'SCHEMA_INVALID' }]);
    expect(s.events().some((e) => e.type.startsWith('advice.'))).toBe(false);
    expect(s.store.getCommand(s.runId, 'advice_forged')).toBeFalsy();
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

  it('long reviews never bring the run to the no-progress pause', async () => {
    const s = setup({
      definition: advised({ interval: 1, maxRequestsPerReview: 8 }),
      turns: { writer: 3 },
      advisor: { reviewTurns: () => 8 },
    });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    // Several reviews of eight requests each, more than the six of the pause.
    expect(s.advisorExecution()?.modelCallIds.length).toBeGreaterThanOrEqual(16);
    expect(Object.values(s.projection().approvals)).toEqual([]);
    expect(
      s.events().some((e) => e.type === 'limit.reached' || e.type === 'extension.ui_notified'),
    ).toBe(false);
  });

  it('with an advisor, the watched role’s own replies still bring the pause', async () => {
    const s = setup({ turns: { writer: 8 } });
    await s.wait((p) => Object.values(p.approvals).some((a) => a.status === 'pending'));
    const p = s.projection();
    expect(Object.values(p.approvals).map((a) => a.limit)).toEqual([
      { kind: 'no_progress', used: 6, max: 6 },
    ]);
    const writer = s.executionOf('writer')?.executionId;
    expect(p.progress.observedCalls).toHaveLength(6);
    for (const id of p.progress.observedCalls) expect(p.modelCalls[id]?.executionId).toBe(writer);
  });

  it('reads what a watched role wrote; another role’s artifact is refused', async () => {
    // The role lists no collaboration tools; reading is the Coordinator's to give.
    const definition = advised({ interval: 1, maxRequestsPerReview: 8 }, ['editor']);
    const reads: Record<string, ToolOutcome> = {};
    const versionOf = (nodeId: string) => {
      const p = s.projection();
      return Object.values(p.artifacts).find(
        (a) => p.executions[a.authorExecutionId]?.nodeId === nodeId,
      )?.artifactVersionId;
    };
    const s = setup({
      definition,
      scripts: {
        editor: async (_input, host) => {
          await call(host, 'editor answer 1');
          await host.invokeTool({ name: 'write_artifact', args: { text: 'editor draft' } });
          await call(host, 'editor answer 2');
          await until(() => 'watched' in reads, 'the advisor to read');
          return submit(host, 'editor answer 2');
        },
      },
      advisor: {
        script: async (_input, host) => {
          for (;;) {
            const review = await host.nextReview?.();
            if (!review) return { outcome: 'succeeded' };
            const watched = versionOf('editor');
            const other = versionOf('writer');
            if (!watched || !other || 'watched' in reads) continue;
            reads.other = await host.invokeTool({
              name: 'read_artifact',
              args: { artifactVersionId: other },
            });
            reads.watched = await host.invokeTool({
              name: 'read_artifact',
              args: { artifactVersionId: watched },
            });
          }
        },
      },
    });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    expect(reads.watched?.ok).toBe(true);
    expect(reads.other?.ok ? null : reads.other?.error.code).toBe('CAPABILITY_DENIED');
  });

  it('a path inside the run’s work folder reaches the review as [workspace]', async () => {
    const definition = advised({ interval: 1, maxRequestsPerReview: 8 });
    definition.roles.find((r) => r.id === 'writer_role')?.allowedWorkTools.push('read_file');
    const s = setup({
      definition,
      workspaceRoots: ['/work/project'],
      files: { available: () => true, execute: async () => ({ text: 'one line' }) },
      scripts: {
        writer: async (_input, host) => {
          // The tool follows the request that asked for it.
          await call(host, 'writer answer 1');
          await host.invokeTool({ name: 'read_file', args: { path: '/work/project/src/app.ts' } });
          await call(host, 'writer answer 2');
          return submit(host, 'writer answer 2');
        },
      },
    });
    await s.ended();
    const text = s.reviews.map((r) => r.text).join('\n');
    expect(text).toContain('[workspace]/src/app.ts');
    expect(text).not.toContain('/work/project');
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

  it('a review that cannot be built stops its advisor, never the run', async () => {
    // A store whose saved replies cannot be read back: the first review never starts.
    class UnreadableReplies extends InMemoryRunStore {
      override getArtifactText(runId: string, ref: string) {
        if (ref.startsWith('response_')) throw new Error('the saved reply cannot be read');
        return super.getArtifactText(runId, ref);
      }
    }
    const s = setup({ store: new UnreadableReplies(), turns: { writer: 3 } });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    expect(s.projection().output).not.toBeNull();
    expect(s.reviews).toEqual([]);
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

describe('the advisor’s tools', () => {
  const descriptor = {
    name: 'echo',
    source: 'extension:fixture@1.0.0',
    schemaHash: 'b'.repeat(64),
    exposure: 'direct',
    sideEffect: 'external',
    annotations: { readOnlyHint: false, openWorldHint: true },
  } as unknown as NonNullable<ToolGateView['descriptor']>;
  const workStyle = {
    binding: { profileId: 'writing', revision: 1 },
    snapshotHash: 'a'.repeat(64),
    piVersion: '1.3.0',
    policyRevision: 1,
    policy: 'trusted-native',
    resources: [
      {
        hash: 'c'.repeat(64),
        name: 'fixture',
        version: '1.0.0',
        kind: 'extension',
        required: true,
      },
    ],
    allowedTools: ['echo', 'run_check', 'advise', 'read_artifact', 'write_artifact'],
    tools: [],
    diagnostics: [],
    projectTools: {
      projectId: 'default',
      revision: 1,
      hash: 'c'.repeat(64),
      checkIds: ['types'],
      lspServerIds: [],
    },
  } as unknown as EffectiveHarnessSnapshot;

  /** What the role allowlist decides for an advisor's call, its role bound to a work style. */
  function decide(
    name: string,
    args: Record<string, unknown>,
    extra: Partial<ToolGateView> = {},
    role: Partial<AgentStartInput['role']> = {},
  ) {
    const gate = DEFAULT_GATES['tool.authorize'].find((g) => g.id === 'role_allowlist');
    if (!gate) throw new Error('no role allowlist');
    const input = {
      executionId: 'exec_advisor',
      nodeId: 'advisor',
      attemptNo: 1,
      assignment: { kind: 'advisor', watches: ['writer'] },
      role: {
        id: 'advisor_role',
        name: 'Reviewer',
        prompt: 'Watch.',
        modelProfile: 'model-a',
        allowedWorkTools: ['read_file'],
        allowedCollaborationTools: [],
        outputContract: 'notes',
        ...role,
      },
      harness: workStyle,
      inputs: [],
      capabilities: { delegateTo: [], askTo: [] },
    } as unknown as AgentStartInput;
    const decision = gate.check({
      projection: emptyProjection('run_1'),
      limits: DEFAULT_LIMITS,
      input,
      proposal: { name, args },
      policy: SPEC_HARD_CAPS,
      callables: { delegate: [], question: [] },
      externalTools: true,
      fileTools: true,
      responderOf: () => undefined,
      readable: () => new Set<string>(),
      ...extra,
    } as ToolGateView);
    return decision.kind === 'refuse' ? decision.code : decision.kind;
  }

  it('an advisor whose role lists no collaboration tools may advise', () => {
    expect(decide('advise', { severity: 'concern', note: 'Name the source.' })).toBe('allow');
    expect(decide('read_file', { path: 'a.txt' })).toBe('allow');
  });

  it('whatever its role or work style lists, the rest is refused', () => {
    const role = {
      allowedWorkTools: ['read_file', 'write_artifact', 'run_command'],
      allowedCollaborationTools: ['submit_result', 'update_plan', 'spawn_subagents'],
    } as unknown as Partial<AgentStartInput['role']>;
    expect(decide('echo', { text: 'side effect' }, { descriptor }, role)).toBe('CAPABILITY_DENIED');
    expect(decide('run_check', { commandId: 'types' }, {}, role)).toBe('CAPABILITY_DENIED');
    for (const name of ['write_artifact', 'submit_result', 'update_plan', 'spawn_subagents'])
      expect(decide(name, {}, {}, role)).toBe('CAPABILITY_DENIED');
    // A read tool its role did not pick stays closed.
    expect(decide('list_files', {}, {}, role)).toBe('CAPABILITY_DENIED');
  });

  it('advice takes only a severity and a note', () => {
    expect(decide('advise', { severity: 'nit', note: 'x', targetExecutionId: 'exec_1' })).toBe(
      'SCHEMA_INVALID',
    );
    expect(decide('advise', { severity: 'nit', note: 'x', commandId: 'c' })).toBe('SCHEMA_INVALID');
  });

  it('an advisor starts without its role’s work style and with only its own tools', async () => {
    const definition = advised({ interval: 1, maxRequestsPerReview: 8 });
    const role = definition.roles.find((r) => r.id === 'advisor_role');
    if (!role) throw new Error('no advisor role');
    role.harness = workStyle.binding;
    let started: AgentStartInput | undefined;
    const s = setup({
      definition,
      harnesses: {
        resolve: () => JSON.parse(JSON.stringify(workStyle)) as EffectiveHarnessSnapshot,
        readSkill: () => ({ text: 'x', sha256: 'e'.repeat(64) }),
      } as unknown as HarnessResolver,
      advisor: {
        script: async (input, host) => {
          started = input;
          while (await host.nextReview?.()) {}
          return { outcome: 'succeeded' };
        },
      },
    });
    await s.ended();
    expect(s.projection().status).toBe('succeeded');
    expect(started?.harness).toBeUndefined();
    expect(started?.role.harness).toBeUndefined();
    expect(started?.role.allowedCollaborationTools).toEqual(['read_artifact', 'advise']);
    expect(started?.role.allowedWorkTools).toEqual(['read_file']);
  });
});

describe('the advisor and item delegation', () => {
  for (const reviewing of [false, true])
    it(`an advisor ${reviewing ? 'in a review' : 'resting between reviews'} does not hold item delegation`, async () => {
      const definition = collaborationCorral();
      definition.roles.push({
        id: 'advisor_role',
        name: 'Reviewer',
        prompt: 'Watch.',
        modelProfile: 'model-a',
        allowedWorkTools: [],
        allowedCollaborationTools: [],
        outputContract: 'notes',
      });
      definition.nodes.push({
        id: 'advisor',
        type: 'agent',
        label: 'advisor',
        roleId: 'advisor_role',
        invocation: 'observer',
        outputName: 'notes',
        review: { interval: 1, maxRequestsPerReview: 8 },
      } as CorralDefinition['nodes'][number]);
      definition.capabilityLinks.push({
        id: 'watch_research',
        kind: 'advise',
        sourceNodeId: 'advisor',
        targetNodeId: 'research',
      });
      const held = new Gate();
      let reviews = 0;
      let spawned: ToolOutcome | undefined;
      const store = new InMemoryRunStore();
      const agents = new ScriptedAgentAdapter({
        turns: 1,
        collaborate: false,
        appendNotes: false,
        reply: () => 'done',
        beforeReply: async (_turn, input) => {
          if (reviewing && input.assignment.kind === 'advisor') await held.wait();
        },
        reviewTurns: () => {
          reviews += 1;
          return 1;
        },
        script: async (input, host) => {
          if (input.nodeId === 'research') {
            await call(host, 'research first answer');
            await until(() => reviews > 0, 'the first review');
            if (!reviewing) await idle(60);
            spawned = await host.invokeTool({
              name: 'spawn_subagents',
              args: {
                mode: 'items',
                tasks: [
                  { targetNodeId: 'helper', brief: 'Only alpha' },
                  { targetNodeId: 'helper', brief: 'Only beta' },
                ],
              },
            });
            held.open();
            return submit(host, 'notes');
          }
          if (input.nodeId === 'helper') return submit(host, 'part');
          return null;
        },
      });
      const clock = new FakeClock();
      const coordinator = new Coordinator({
        store,
        clock,
        timers: clock,
        ids: new SequentialIdFactory(),
        agents,
      });
      const started = coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'start',
        mode: 'mock',
        definition,
      });
      const runId = started.runId ?? '';
      await until(
        () =>
          ['succeeded', 'failed', 'cancelled'].includes(
            coordinator.getSnapshot(runId).projection.status,
          ),
        'the run to end',
      );
      expect(spawned?.ok ? 'ok' : spawned?.error.message).toBe('ok');
      expect(coordinator.getSnapshot(runId).projection.status).toBe('succeeded');
    });
});
