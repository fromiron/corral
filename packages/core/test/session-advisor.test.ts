import type {
  AgentAdapter,
  CorralDefinition,
  DeliveredDirective,
  EffectiveHarnessSnapshot,
  StartRunRequest,
  ToolOutcome,
} from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  SequentialIdFactory,
} from '@corral/testkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  type AutoStart,
  type AutoStartContext,
  Coordinator,
  canonicalJson,
  compileDefinition,
  createAutoStarter,
  type HarnessResolver,
  InMemoryRunStore,
  isSessionAdvisor,
  SESSION_ADVISOR_NAME,
  SESSION_ADVISOR_PROMPT,
  withSessionAdvisor,
} from '../src/index.ts';

// The session's advisor (features/advisor.md, 두는 곳 › 대화 and 계약): a conversation started
// while it is on has an advisor watching the role that answers.

const choice = { modelProfile: 'model-a' };
const ON = { modelProfile: 'model-b' };

function accepted(commandId: string) {
  return {
    runId: `run_${commandId}`,
    receipt: {
      commandId,
      runId: `run_${commandId}`,
      status: 'accepted' as const,
      acceptedSeq: 1,
      target: `run:run_${commandId}`,
      requestedBoundary: 'immediate' as const,
      relatedEventIds: [],
    },
  };
}

/** The definition a conversation start gets, with the session's advisor or without. */
async function started(
  request: Partial<AutoStart> = {},
  context: Partial<AutoStartContext> = {},
  corral?: CorralDefinition,
): Promise<CorralDefinition> {
  const requests: StartRunRequest[] = [];
  const starter = createAutoStarter({
    ...(corral ? { corral: () => ({ definition: corral, definitionRevision: 1 }) } : {}),
    startRun: (start) => {
      requests.push(start);
      return accepted(start.commandId);
    },
  });
  await starter.start(
    {
      commandId: 'cmd_chat',
      sessionId: 'session_chat',
      brief: 'Fix the bug',
      mode: 'mock',
      choice,
      team: 'none',
      ...request,
    },
    { fileTools: false, ...context },
  );
  const definition = requests[0]?.definition;
  if (!definition) throw new Error('no start');
  return definition;
}

function advisorOf(definition: CorralDefinition) {
  const node = definition.nodes.find((n) => n.type === 'agent' && n.invocation === 'observer');
  const role = definition.roles.find((r) => node?.type === 'agent' && r.id === node.roleId);
  const link = definition.capabilityLinks.find(
    (l) => l.kind === 'advise' && l.sourceNodeId === node?.id,
  );
  return { node, role, link };
}

function lead(definition: CorralDefinition) {
  const node = definition.nodes.find((n) => n.id === definition.entryNodeId);
  return definition.roles.find((r) => node?.type === 'agent' && r.id === node.roleId);
}

describe('the conversation definition with the session advisor', () => {
  it('adds one observer with the built-in principles watching the answering role, and compiles', async () => {
    const definition = await started({}, { sessionAdvisor: ON });
    const { node, role, link } = advisorOf(definition);
    expect(node).toEqual({
      id: 'session_advisor',
      type: 'agent',
      label: 'Advisor',
      roleId: 'session_advisor',
      invocation: 'observer',
      outputName: 'notes',
      review: { interval: 3, maxRequestsPerReview: 8 },
    });
    expect(role).toEqual({
      id: 'session_advisor',
      name: SESSION_ADVISOR_NAME,
      prompt: SESSION_ADVISOR_PROMPT,
      modelProfile: 'model-b',
      // The conversation's roles read nothing here, so neither does its advisor.
      allowedWorkTools: [],
      allowedCollaborationTools: ['read_artifact', 'advise'],
      outputContract: 'notes',
    });
    expect(role).not.toHaveProperty('answer');
    expect(link).toEqual({
      id: 'session_advisor_watch',
      kind: 'advise',
      sourceNodeId: 'session_advisor',
      targetNodeId: definition.entryNodeId,
    });
    expect(SESSION_ADVISOR_NAME).toBe('Advisor');
    expect(SESSION_ADVISOR_PROMPT.split('\n').length).toBeLessThanOrEqual(10);
    const compiled = compileDefinition(definition);
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(compiled.ok).toBe(true);
  });

  it('gives the advisor only the read tools the conversation’s roles have', async () => {
    const files = await started({}, { sessionAdvisor: ON, fileTools: true });
    expect(lead(files)?.allowedWorkTools).toEqual(expect.arrayContaining(['read_file']));
    expect(advisorOf(files).role?.allowedWorkTools).toEqual(['list_files', 'read_file']);
    // A saved team whose roles read documents and search lends the advisor those reads, no more.
    const corral = linearCorral(['writer', 'editor']);
    const [writer, editor] = corral.roles;
    if (!writer || !editor) throw new Error('no roles');
    writer.allowedWorkTools = ['write_artifact', 'search'];
    editor.allowedWorkTools = ['write_artifact', 'read_document'];
    const team = await started(
      { team: { corralId: 'corral_saved' } },
      { sessionAdvisor: ON },
      corral,
    );
    expect(advisorOf(team).role?.allowedWorkTools).toEqual(['search', 'read_document']);
    expect(compileDefinition(team).ok).toBe(true);
  });

  it('adds nothing when the advisor is off', async () => {
    for (const context of [{}, { sessionAdvisor: null }]) {
      const definition = await started({}, context);
      expect(advisorOf(definition).node).toBeUndefined();
      expect(definition.capabilityLinks.some((l) => l.kind === 'advise')).toBe(false);
    }
  });

  it('binds the advisor to the answering role’s work style, on a team or not', async () => {
    const harness = { profileId: 'writing', revision: 2 };
    for (const team of ['none', 'auto'] as const) {
      const definition = await started({ team, harness }, { sessionAdvisor: ON });
      expect(lead(definition)?.harness).toEqual(harness);
      expect(advisorOf(definition).role?.harness).toEqual(harness);
      expect(compileDefinition(definition).ok).toBe(true);
    }
    const without = await started({}, { sessionAdvisor: ON });
    expect(advisorOf(without).role).not.toHaveProperty('harness');
  });

  /**
   * A saved team with an advisor as the team editor makes it (its role lists `advise`), and a
   * role an observer and a working step share.
   */
  function advisedTeam() {
    const corral = linearCorral(['writer', 'editor']);
    const reader = (id: string, collaboration: ('advise' | 'read_artifact')[]) => ({
      id,
      name: id,
      prompt: 'Watch the writer.',
      modelProfile: 'model-c',
      allowedWorkTools: ['read_file' as const],
      allowedCollaborationTools: collaboration,
      outputContract: 'notes' as const,
    });
    corral.roles.push(
      reader('checker', ['read_artifact', 'advise']),
      reader('shared', []),
      // An advisor role no node runs yet.
      reader('spare', ['advise']),
    );
    for (const [id, roleId] of [
      ['checker', 'checker'],
      ['second_look', 'shared'],
    ] as const) {
      corral.nodes.push({
        id,
        type: 'agent',
        label: id,
        roleId,
        invocation: 'observer',
        outputName: 'notes',
      });
      corral.capabilityLinks.push({
        id: `watch_${id}`,
        kind: 'advise',
        sourceNodeId: id,
        targetNodeId: 'writer',
      });
    }
    // The shared role also does work as a callable step the writer may delegate to.
    corral.nodes.push({
      id: 'lookup',
      type: 'agent',
      label: 'lookup',
      roleId: 'shared',
      invocation: 'callable',
      inputBindings: [],
      outputName: 'notes',
    });
    corral.capabilityLinks.push({
      id: 'writer_lookup',
      kind: 'delegate',
      sourceNodeId: 'writer',
      targetNodeId: 'lookup',
    });
    return corral;
  }

  it('leaves a saved team’s advisor roles out of the conversation’s roster', async () => {
    const corral = advisedTeam();
    const definition = await started({ team: { corralId: 'corral_saved' } }, {}, corral);
    const ids = definition.roles.map((role) => role.id);
    // Its writer and editor are delegates; neither advisor role is, nor the role an advisor runs
    // that a step also uses (the same rule as the team editor's role import).
    expect(ids).toContain('team_writer_role');
    expect(ids).toContain('team_editor_role');
    expect(ids).not.toContain('team_checker');
    expect(ids).not.toContain('team_shared');
    expect(ids).not.toContain('team_spare');
    expect(definition.roles.flatMap((role) => role.allowedCollaborationTools)).not.toContain(
      'advise',
    );
    const called = definition.capabilityLinks
      .filter((l) => l.kind === 'delegate')
      .map((l) => l.targetNodeId);
    expect(called).not.toContain('team_checker');
    expect(called).not.toContain('team_shared');
    expect(advisorOf(definition).node).toBeUndefined();
    const compiled = compileDefinition(definition);
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(compiled.ok).toBe(true);
  });

  it('with the session advisor on, that one advisor watches the lead of a saved team’s conversation', async () => {
    const corral = advisedTeam();
    const without = await started({ team: { corralId: 'corral_saved' } }, {}, corral);
    const definition = await started(
      { team: { corralId: 'corral_saved' } },
      { sessionAdvisor: ON },
      corral,
    );
    expect(definition.roles.slice(0, -1)).toEqual(without.roles);
    expect(definition.nodes.slice(0, -1)).toEqual(without.nodes);
    const observers = definition.nodes.filter(
      (n) => n.type === 'agent' && n.invocation === 'observer',
    );
    expect(observers.map((n) => n.id)).toEqual(['session_advisor']);
    expect(advisorOf(definition).link?.targetNodeId).toBe(definition.entryNodeId);
    expect(compileDefinition(definition).ok).toBe(true);
  });

  it('keeps an advisor the definition already has and picks ids that are free', () => {
    const base: CorralDefinition = withSessionAdvisor(
      { ...linearCorral(['writer']), entryNodeId: 'writer' },
      ON,
    );
    const both = withSessionAdvisor(base, { modelProfile: 'model-c' });
    const observers = both.nodes.filter((n) => n.type === 'agent' && n.invocation === 'observer');
    expect(observers.map((n) => n.id)).toEqual(['session_advisor', 'session_advisor_2']);
    expect(both.capabilityLinks.filter((l) => l.kind === 'advise').map((l) => l.id)).toEqual([
      'session_advisor_watch',
      'session_advisor_2_watch',
    ]);
    expect(compileDefinition(both).ok).toBe(true);
  });

  it('does not take its reads from an advisor the definition already has', () => {
    const base = { ...linearCorral(['writer']), entryNodeId: 'writer' };
    for (const role of base.roles) role.allowedWorkTools = ['write_artifact'];
    base.roles.push({
      id: 'reader',
      name: 'Reader',
      prompt: 'Watch.',
      modelProfile: 'model-c',
      allowedWorkTools: ['read_file'],
      allowedCollaborationTools: ['read_artifact', 'advise'],
      outputContract: 'notes',
    });
    base.nodes.push({
      id: 'reader',
      type: 'agent',
      label: 'Reader',
      roleId: 'reader',
      invocation: 'observer',
      outputName: 'notes',
    });
    base.capabilityLinks.push({
      id: 'reader_watch',
      kind: 'advise',
      sourceNodeId: 'reader',
      targetNodeId: 'writer',
    });
    const added = withSessionAdvisor(base, ON);
    expect(added.roles.find((role) => role.id === 'session_advisor')?.allowedWorkTools).toEqual([]);
  });

  it('does not reuse an advise link id that is already taken', () => {
    const base = { ...linearCorral(['writer', 'editor']), entryNodeId: 'writer' };
    base.capabilityLinks.push({
      id: 'session_advisor_watch',
      kind: 'delegate',
      sourceNodeId: 'writer',
      targetNodeId: 'editor',
    });
    const added = withSessionAdvisor(base, ON);
    expect(advisorOf(added).node?.id).toBe('session_advisor_2');
    expect(advisorOf(added).link?.id).toBe('session_advisor_2_watch');
    expect(new Set(added.capabilityLinks.map((l) => l.id)).size).toBe(added.capabilityLinks.length);
  });

  it('says when the start is refused because the advisor’s model cannot be prepared', async () => {
    const refusal = async (advisor: { modelProfile: string }) => {
      const starter = createAutoStarter({
        prepareModels: (_request, profiles = ['model-a']) => {
          const missing = profiles.find((profile) => profile !== 'model-a');
          if (missing)
            return {
              ok: false,
              error: { code: 'MODEL_UNAVAILABLE', message: `${missing}: no credentials` },
            };
          return {
            ok: true,
            models: Object.fromEntries(
              profiles.map((profile) => [
                profile,
                { profile, provider: 'fixture', modelId: 'fixture', auth: 'api_key' as const },
              ]),
            ),
          };
        },
        startRun: (start) => accepted(start.commandId),
      });
      const result = await starter.start(
        {
          commandId: 'cmd_chat',
          sessionId: 'session_chat',
          brief: 'Fix the bug',
          mode: 'live',
          choice,
          team: 'none',
        },
        { fileTools: false, sessionAdvisor: advisor },
      );
      return result.receipt.error;
    };
    expect(await refusal({ modelProfile: 'model-b' })).toEqual({
      code: 'MODEL_UNAVAILABLE',
      message: 'Advisor model model-b: no credentials',
    });
  });

  it('says nothing of the advisor when a role it shares a model with cannot get it', async () => {
    const corral = linearCorral(['writer']);
    const writer = corral.roles[0];
    if (!writer) throw new Error('no role');
    writer.modelProfile = 'model-b';
    const starter = createAutoStarter({
      corral: () => ({ definition: corral, definitionRevision: 1 }),
      prepareModels: (_request, profiles = ['model-a']) =>
        profiles.includes('model-b')
          ? { ok: false, error: { code: 'MODEL_UNAVAILABLE', message: 'model-b: no credentials' } }
          : {
              ok: true,
              models: {
                'model-a': { profile: 'model-a', provider: 'f', modelId: 'f', auth: 'api_key' },
              },
            },
      startRun: (start) => accepted(start.commandId),
    });
    const result = await starter.start(
      {
        commandId: 'cmd_chat',
        sessionId: 'session_chat',
        brief: 'Fix the bug',
        mode: 'live',
        choice,
        team: { corralId: 'corral_saved' },
      },
      { fileTools: false, sessionAdvisor: ON },
    );
    expect(result.receipt.error).toEqual({
      code: 'MODEL_UNAVAILABLE',
      message: 'model-b: no credentials',
    });
  });
});

// ── on a Coordinator ────────────────────────────────────────────────────────────────────────

async function until(done: () => boolean, what = 'the condition') {
  const deadline = Date.now() + 3_000;
  const host = globalThis as unknown as { setImmediate(fn: () => void): unknown };
  while (!done() && Date.now() < deadline)
    await new Promise<void>((resolve) => host.setImmediate(resolve));
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

interface Run {
  /** The answering role's model requests, and what it awaits before the given one. */
  lead?: { turns?: number; before?: (turn: number) => Promise<void> };
  advisor?: Partial<ScriptedAgentOptions>;
  harnesses?: HarnessResolver;
  files?: ConstructorParameters<typeof Coordinator>[0]['files'];
  harness?: AutoStart['harness'];
  advisorOn?: boolean;
  tools?: ConstructorParameters<typeof Coordinator>[0]['tools'];
  /** The conversation's roles read and write files. */
  fileTools?: boolean;
}

/** A conversation started through the auto starter on a Coordinator, scripted agents only. */
async function conversation(options: Run = {}) {
  const permits: DeliveredDirective[][] = [];
  // The lead answers with its last reply after its requests; it delegates nothing.
  const leadAgent = new ScriptedAgentAdapter({
    turns: 1,
    script: async (input, host) => {
      // A bound work style is simulated in mock mode, as the pi worker does.
      if (input.harness) await host.simulateHarness?.();
      let last = '';
      for (let turn = 1; turn <= (options.lead?.turns ?? 1); turn++) {
        await options.lead?.before?.(turn);
        const permit = await host.prepareModelRequest();
        permits.push(permit.directives);
        await host.modelRequestDispatched?.(permit.modelCallId);
        await host.observe({
          kind: 'model_completed',
          modelCallId: permit.modelCallId,
          text: `answer ${turn}`,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        last = permit.modelCallId;
      }
      return { outcome: 'succeeded', finalTextModelCallId: last };
    },
  });
  const advisorAgent = new ScriptedAgentAdapter({ turns: 1, ...options.advisor });
  const agents: AgentAdapter = {
    start: (input, host) =>
      (input.assignment.kind === 'advisor' ? advisorAgent : leadAgent).start(input, host),
  };
  const store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents,
    ...(options.harnesses ? { harnesses: options.harnesses } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
  });
  const starter = createAutoStarter({ startRun: (request) => coordinator.startRun(request) });
  const result = await starter.start(
    {
      commandId: 'cmd_chat',
      sessionId: 'session_chat',
      brief: 'Fix the bug',
      mode: 'mock',
      choice,
      team: 'none',
      ...(options.harness ? { harness: options.harness } : {}),
    },
    {
      fileTools: options.fileTools ?? false,
      ...(options.advisorOn === false ? {} : { sessionAdvisor: ON }),
    },
  );
  const runId = result.runId;
  if (!runId) throw new Error(JSON.stringify(result.receipt));
  const projection = () => coordinator.getSnapshot(runId).projection;
  const ended = () =>
    until(
      () => ['succeeded', 'failed', 'cancelled'].includes(projection().status),
      'the run to end',
    ).catch((error) => {
      const p = projection();
      throw new Error(
        `${error} ${p.status} ${JSON.stringify(Object.values(p.executions).map((e) => [e.nodeId, e.status, e.modelCallIds.length, e.waitingOn]))}`,
      );
    });
  return { coordinator, store, runId, projection, ended, permits };
}

describe('a conversation with the session advisor on a Coordinator', () => {
  it('pins the advisor in the run’s snapshot; a run started without it has none', async () => {
    const on = await conversation();
    const off = await conversation({ advisorOn: false });
    await on.ended();
    await off.ended();
    const observers = (c: Awaited<ReturnType<typeof conversation>>) =>
      c.coordinator
        .getRunSnapshot(c.runId)
        ?.definition.nodes.filter((n) => n.type === 'agent' && n.invocation === 'observer')
        .map((n) => n.id);
    expect(observers(on)).toEqual(['session_advisor']);
    expect(observers(off)).toEqual([]);
    expect(on.projection().status).toBe('succeeded');
  });

  it('a concern from the advisor reaches the answering role’s next request', async () => {
    const given = new Gate();
    const outcomes: ToolOutcome[] = [];
    const c = await conversation({
      lead: {
        turns: 4,
        // The review falls due after three requests; the fourth waits for its advice.
        before: async (turn) => {
          if (turn === 4) await given.wait();
        },
      },
      advisor: {
        advise: () =>
          outcomes.length === 0 ? [{ severity: 'concern', note: 'The test was not run.' }] : [],
        onAdvised: (outcome) => {
          outcomes.push(outcome);
          given.open();
        },
      },
    });
    await c.ended();
    expect(c.projection().status).toBe('succeeded');
    expect(outcomes[0]?.ok && outcomes[0].result.advice).toMatchObject({
      outcome: 'admitted',
      delivery: 'next_request',
    });
    expect(c.permits.flat()).toEqual([
      {
        directiveId: expect.any(String),
        text: 'The test was not run.',
        origin: 'advice',
        advice: { severity: 'concern', from: 'Advisor' },
      },
    ]);
  });

  it('an advisor that fails leaves the conversation’s answer as it was', async () => {
    const c = await conversation({
      lead: { turns: 4 },
      advisor: { script: async () => ({ outcome: 'failed', error: 'advisor broke' }) },
    });
    await c.ended();
    const plain = await conversation({ lead: { turns: 4 }, advisorOn: false });
    await plain.ended();
    expect(c.projection().status).toBe('succeeded');
    const advisor = Object.values(c.projection().executions).find(
      (e) => e.nodeId === 'session_advisor',
    );
    expect(advisor?.status).toBe('failed');
    const answer = (x: typeof c) =>
      x.store.getArtifactText(x.runId, x.projection().output?.artifactVersionIds[0] ?? '');
    expect(answer(c)).toBe(answer(plain));
    expect(answer(c)).toBe('answer 4');
  });

  it('a search the conversation’s roles do not have is refused and reaches no provider', async () => {
    const reached: unknown[] = [];
    const results: string[] = [];
    const c = await conversation({
      tools: {
        execute: async (call) => {
          reached.push(call);
          return { results: [] };
        },
      },
      lead: { turns: 3 },
      advisor: {
        script: async (_input, host) => {
          for (;;) {
            const review = await host.nextReview?.();
            if (!review) return { outcome: 'succeeded' };
            if (results.length > 0) continue;
            const permit = await host.prepareModelRequest();
            await host.modelRequestDispatched?.(permit.modelCallId);
            await host.observe({
              kind: 'model_completed',
              modelCallId: permit.modelCallId,
              text: 'reviewing',
              usage: { inputTokens: 1, outputTokens: 1 },
            });
            for (const args of [{ query: 'x' }, { query: 'x', provider: 'brave' }]) {
              const outcome = await host.invokeTool({ name: 'search', args });
              results.push(outcome.ok ? 'ok' : outcome.error.code);
            }
            const document = await host.invokeTool({
              name: 'read_document',
              args: { documentId: 'doc_1' },
            });
            results.push(document.ok ? 'ok' : document.error.code);
          }
        },
      },
    });
    await c.ended();
    expect(results).toEqual(['CAPABILITY_DENIED', 'CAPABILITY_DENIED', 'CAPABILITY_DENIED']);
    expect(reached).toEqual([]);
    expect(c.projection().status).toBe('succeeded');
  });

  it('the answering role’s work style denies the advisor’s reads', async () => {
    const readFile = {
      name: 'read_file',
      source: 'corral',
      schemaHash: 'd'.repeat(64),
      exposure: 'direct',
      sideEffect: 'none',
      annotations: { readOnlyHint: true },
    };
    const readFileHash = bytesToHex(sha256(utf8ToBytes(canonicalJson(readFile))));
    const style = {
      binding: { profileId: 'writing', revision: 1 },
      snapshotHash: 'a'.repeat(64),
      piVersion: '1.3.0',
      policyRevision: 1,
      policy: 'trusted-native',
      resources: [],
      allowedTools: ['read_file'],
      tools: [readFile],
      diagnostics: [],
      permissionPolicies: [
        {
          default: 'ask',
          rules: [
            { tool: 'read_file', action: 'deny', path: { argument: 'path', prefix: 'secrets' } },
            { tool: 'read_file', action: 'allow', descriptorHash: readFileHash },
          ],
        },
      ],
    } as unknown as EffectiveHarnessSnapshot;
    const executed: unknown[] = [];
    const results: string[] = [];
    const c = await conversation({
      fileTools: true,
      harness: style.binding,
      harnesses: {
        resolve: () => JSON.parse(JSON.stringify(style)) as EffectiveHarnessSnapshot,
        readSkill: () => ({ text: 'x', sha256: 'e'.repeat(64) }),
      } as unknown as HarnessResolver,
      files: {
        available: () => true,
        execute: async (call) => {
          executed.push(call.args.path);
          return { text: 'one line' };
        },
      },
      lead: { turns: 3 },
      advisor: {
        script: async (_input, host) => {
          for (;;) {
            const review = await host.nextReview?.();
            if (!review) return { outcome: 'succeeded' };
            if (results.length > 0) continue;
            const permit = await host.prepareModelRequest();
            await host.modelRequestDispatched?.(permit.modelCallId);
            await host.observe({
              kind: 'model_completed',
              modelCallId: permit.modelCallId,
              text: 'reviewing',
              usage: { inputTokens: 1, outputTokens: 1 },
            });
            for (const path of ['secrets/key.txt', 'notes/a.txt']) {
              const outcome = await host.invokeTool({ name: 'read_file', args: { path } });
              results.push(outcome.ok ? 'ok' : outcome.error.code);
            }
          }
        },
      },
    });
    // The answer's own publishing waits for a person under this style; the reads came first.
    await until(() => results.length === 2, 'the advisor’s reads');
    const snapshot = c.coordinator.getRunSnapshot(c.runId);
    expect(snapshot?.harnesses?.session_advisor?.binding).toEqual(style.binding);
    expect(results).toEqual(['CAPABILITY_DENIED', 'ok']);
    expect(executed).toEqual(['notes/a.txt']);
  });
});

it('tells the advisor a session added from a team advisor by its id, not its name', () => {
  const added = withSessionAdvisor(linearCorral(['writer']), choice);
  const again = withSessionAdvisor(added, choice);
  const ids = again.nodes.flatMap((node) =>
    node.type === 'agent' && node.invocation === 'observer' ? [node.id] : [],
  );
  expect(ids).toEqual(['session_advisor', 'session_advisor_2']);
  for (const id of ids) expect(isSessionAdvisor(again, id)).toBe(true);
  // A team advisor named like it, and a working agent with its id, are not it.
  const team = linearCorral(['writer']);
  team.nodes.push({
    id: 'reviewer',
    type: 'agent',
    label: SESSION_ADVISOR_NAME,
    roleId: 'writer_role',
    invocation: 'observer',
    outputName: 'notes',
  });
  expect(isSessionAdvisor(team, 'reviewer')).toBe(false);
  // A team's own observer that happens to use the id keeps its role, and so its name.
  team.nodes.push({
    id: 'session_advisor',
    type: 'agent',
    label: 'Fact checker',
    roleId: 'writer_role',
    invocation: 'observer',
    outputName: 'checks',
  });
  expect(isSessionAdvisor(team, 'session_advisor')).toBe(false);
  expect(isSessionAdvisor(linearCorral(['session_advisor']), 'session_advisor')).toBe(false);
  expect(isSessionAdvisor(team, 'missing')).toBe(false);
});
