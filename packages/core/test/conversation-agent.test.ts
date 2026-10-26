import type { EffectiveHarnessSnapshot, RunEvent } from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  applyProgressEvent,
  Coordinator,
  conversationDefinition,
  createAutoStarter,
  emptyProgress,
  explainDefinition,
  InMemoryRunStore,
  InProcessTransport,
  NO_PROGRESS_TURNS,
  waitForProjection,
} from '../src/index.ts';

// session chat is one lead that answers with its final reply.

const choice = { modelProfile: 'model-a' };

describe('conversation agent', () => {
  it('the conversation lead answers with its final reply and has no output tools', () => {
    const definition = conversationDefinition({
      id: 'conversation_chat',
      brief: '하이',
      choice,
      fileTools: false,
    });
    // The lead, and the helper it may call on request.
    expect(definition.roles.map((role) => role.name)).toEqual(['Assistant', 'Helper']);
    const [lead] = definition.roles;
    expect(lead).toMatchObject({ answer: 'final_reply', outputContract: 'text' });
    expect(lead?.allowedWorkTools).not.toContain('write_artifact');
    expect(lead?.allowedCollaborationTools).not.toContain('submit_result');
    expect(lead?.allowedCollaborationTools).toEqual(
      expect.arrayContaining(['ask_user', 'update_plan']),
    );
    const withFiles = conversationDefinition({
      id: 'conversation_files',
      brief: 'Fix the bug',
      choice,
      fileTools: true,
    });
    expect(withFiles.roles[0]?.allowedWorkTools).toEqual(
      expect.arrayContaining(['read_file', 'write_file']),
    );
  });

  it('team none starts the conversation lead without asking a chooser', async () => {
    let routed = 0;
    const started: Parameters<Parameters<typeof createAutoStarter>[0]['startRun']>[0][] = [];
    const starter = createAutoStarter({
      route: () => {
        routed++;
        return Promise.resolve({
          ok: true,
          text: '{"template":"single","reason":"x"}',
          usage: null,
        });
      },
      startRun: (request) => {
        started.push(request);
        return {
          runId: 'run_chat',
          receipt: {
            commandId: request.commandId,
            runId: 'run_chat',
            status: 'accepted',
            acceptedSeq: 1,
            target: 'run:run_chat',
            requestedBoundary: 'immediate',
            relatedEventIds: [],
          },
        };
      },
    });
    const result = await starter.start(
      {
        commandId: 'cmd_chat',
        sessionId: 'session_chat',
        brief: '하이',
        mode: 'live',
        choice,
        team: 'none',
      },
      { fileTools: false },
    );
    expect(result.runId).toBe('run_chat');
    expect(routed).toBe(0);
    expect(started[0]?.definition.roles[0]?.answer).toBe('final_reply');
    expect(started[0]?.autoRoute).toBeUndefined();
  });

  it('a question about a result has no tools and answers with its final reply', () => {
    const [role] = explainDefinition({
      id: 'explain',
      question: 'Why?',
      modelProfile: 'model-a',
    }).roles;
    expect(role).toMatchObject({
      answer: 'final_reply',
      allowedWorkTools: [],
      allowedCollaborationTools: [],
    });
  });
});

describe('progress guard', () => {
  const version = (
    seq: number,
    artifactId: string,
    contentHash: string,
    executionId = 'exec',
  ): RunEvent =>
    ({
      type: 'artifact.version_created',
      seq,
      executionId,
      payload: {
        artifactId,
        artifactVersionId: `v${seq}`,
        contentHash,
        authorExecutionId: executionId,
      },
    }) as unknown as RunEvent;
  const reply = (seq: number): RunEvent =>
    ({
      type: 'model.finished',
      seq,
      payload: { modelCallId: `call_${seq}` },
    }) as unknown as RunEvent;
  const projection = { artifacts: {}, questions: {} } as Parameters<typeof applyProgressEvent>[2];

  it('rewriting the same unsubmitted artifact is not progress', () => {
    let state = emptyProgress();
    state = applyProgressEvent(state, reply(1), projection);
    state = applyProgressEvent(state, version(2, 'art_answer', 'hash_1'), projection);
    expect(state.turns).toBe(0);
    for (let n = 0; n < NO_PROGRESS_TURNS; n++) {
      state = applyProgressEvent(state, reply(10 + n * 2), projection);
      state = applyProgressEvent(
        state,
        version(11 + n * 2, 'art_answer', `hash_${n + 2}`),
        projection,
      );
    }
    expect(state.turns).toBe(NO_PROGRESS_TURNS);
    // A different artifact is still new work.
    state = applyProgressEvent(state, version(99, 'art_other', 'hash_other'), projection);
    expect(state.turns).toBe(0);
  });

  it('after a submission, the next version of the artifact is progress again', () => {
    let state = applyProgressEvent(emptyProgress(), version(1, 'art_answer', 'hash_1'), projection);
    state = applyProgressEvent(state, reply(2), projection);
    state = applyProgressEvent(
      state,
      {
        type: 'task.submitted',
        seq: 3,
        payload: { artifactVersionIds: ['v1'] },
      } as unknown as RunEvent,
      { artifacts: { v1: { contentHash: 'hash_1' } }, questions: {} } as unknown as Parameters<
        typeof applyProgressEvent
      >[2],
    );
    state = applyProgressEvent(state, reply(4), projection);
    state = applyProgressEvent(state, version(5, 'art_answer', 'hash_2'), projection);
    expect(state.turns).toBe(0);
  });
});

describe('explicit subagents', () => {
  it('the conversation lead can delegate to a helper only when asked', () => {
    const definition = conversationDefinition({
      id: 'conversation_helpers',
      brief: 'Use two subagents to compare these options.',
      choice,
      fileTools: false,
    });
    const [lead, helper] = definition.roles;
    expect(lead?.allowedCollaborationTools).toEqual(
      expect.arrayContaining(['spawn_subagents', 'await_tasks', 'read_artifact']),
    );
    expect(lead?.prompt).toContain('only when the person explicitly asks');
    expect(helper).toMatchObject({ answer: 'final_reply', outputContract: 'text' });
    expect(helper?.allowedCollaborationTools).not.toContain('spawn_subagents');
    const node = definition.nodes.find((n) => n.type === 'agent' && n.roleId === helper?.id);
    expect(node).toMatchObject({ invocation: 'callable' });
    expect(definition.capabilityLinks).toContainEqual(
      expect.objectContaining({ kind: 'delegate', targetNodeId: node?.id }),
    );
  });

  it('a resent conversation start returns its run after the run ended', async () => {
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    const starter = createAutoStarter({
      route: () => Promise.reject(new Error('no chooser for session chat')),
      startRun: (request) => coordinator.startRun(request),
      previousStart: (commandId, requestHash, original) => {
        const result = coordinator.startResult(commandId, requestHash, original);
        return result ? { ...result, autoRoute: null } : null;
      },
    });
    const request = {
      commandId: 'cmd_resend',
      sessionId: 'session_resend',
      brief: 'Hi',
      mode: 'mock' as const,
      choice,
      team: 'none' as const,
    };
    const first = await starter.start(request, { fileTools: false });
    await waitForProjection(new InProcessTransport(coordinator), first.runId!, (p) =>
      ['succeeded', 'failed'].includes(p.status),
    );
    const again = await starter.start(request, { fileTools: false });
    expect(again.receipt.error).toBeUndefined();
    expect(again.runId).toBe(first.runId);
    // A different request under the same command is still a conflict.
    const changed = await starter.start({ ...request, brief: 'Other' }, { fileTools: false });
    expect(changed.receipt.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(coordinator.listRuns()).toHaveLength(1);
  });

  it('delegated helpers answer with final replies that reach the lead', async () => {
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    const started = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start_helpers',
      mode: 'mock',
      definition: conversationDefinition({
        id: 'conversation_run',
        brief: 'Use subagents.',
        choice,
        fileTools: false,
      }),
    });
    const final = await waitForProjection(
      new InProcessTransport(coordinator),
      started.runId!,
      (p) => ['succeeded', 'failed'].includes(p.status),
    );
    expect(final.status).toBe('succeeded');
    const children = final.executionOrder.slice(1).map((id) => final.executions[id]);
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((child) => child?.status === 'succeeded')).toBe(true);
    // Nobody called write_artifact or submit_result as a model: the Coordinator published.
    expect(Object.values(final.toolCalls).map((call) => call.name)).toEqual(
      expect.arrayContaining(['spawn_subagents', 'await_tasks']),
    );
  });
});

describe('team selector', () => {
  const accepted = (commandId: string) => ({
    runId: 'run_team',
    receipt: {
      commandId,
      runId: 'run_team',
      status: 'accepted' as const,
      acceptedSeq: 1,
      target: 'run:run_team',
      requestedBoundary: 'immediate' as const,
      relatedEventIds: [],
    },
  });
  type Started = Parameters<Parameters<typeof createAutoStarter>[0]['startRun']>[0];

  it('auto gives the lead a roster of named delegates without a chooser', async () => {
    let routed = 0;
    const started: Started[] = [];
    const starter = createAutoStarter({
      route: () => {
        routed++;
        return null;
      },
      startRun: (request) => {
        started.push(request);
        return accepted(request.commandId);
      },
    });
    await starter.start(
      {
        commandId: 'cmd_auto',
        sessionId: 'session_team',
        brief: 'Write a report',
        mode: 'mock',
        choice,
        team: 'auto',
      },
      { fileTools: false },
    );
    expect(routed).toBe(0);
    const definition = started[0]!.definition;
    const [lead, ...roster] = definition.roles;
    expect(lead?.answer).toBe('final_reply');
    expect(roster.map((role) => role.name)).toEqual([
      'Planner',
      'Researcher',
      'Writer',
      'Reviewer',
    ]);
    expect(roster.every((role) => role.answer === 'final_reply')).toBe(true);
    expect(definition.capabilityLinks.filter((link) => link.kind === 'delegate')).toHaveLength(4);
    expect(lead?.prompt).toContain('Planner');
    expect(lead?.prompt).not.toContain('only when the person explicitly asks');
  });

  it('a chosen Corral lends its roles to the lead with its flow as guidance', async () => {
    const corral = linearCorral(['research', 'write']);
    const started: Started[] = [];
    const starter = createAutoStarter({
      corral: (id) => (id === 'corral_saved' ? corral : null),
      startRun: (request) => {
        started.push(request);
        return accepted(request.commandId);
      },
    });
    await starter.start(
      {
        commandId: 'cmd_corral',
        sessionId: 'session_team',
        brief: 'Do it',
        mode: 'mock',
        choice,
        team: { corralId: 'corral_saved' },
      },
      { fileTools: false },
    );
    const definition = started[0]!.definition;
    const [lead, ...roster] = definition.roles;
    expect(roster.map((role) => role.name)).toEqual(corral.roles.map((role) => role.name));
    expect(roster.every((role) => role.answer === 'final_reply')).toBe(true);
    expect(roster.flatMap((role) => role.allowedCollaborationTools)).not.toContain('submit_result');
    // The saved flow reaches the lead as guidance, not as wiring.
    expect(lead?.prompt).toContain('→');
    expect(definition.controlEdges.every((edge) => !edge.source.startsWith('team_'))).toBe(true);
  });

  it('a saved team’s other models are prepared before the start', async () => {
    const corral = linearCorral(['review']);
    corral.roles = corral.roles.map((role) => ({ ...role, modelProfile: 'model-b' }));
    const asked: (readonly string[] | undefined)[] = [];
    let models: Record<string, unknown> | undefined;
    const snapshot = (profile: string) => ({
      profile,
      provider: null,
      modelId: null,
      auth: 'mock' as const,
    });
    const starter = createAutoStarter({
      corral: () => corral,
      prepareModels: (_request, profiles) => {
        asked.push(profiles);
        const list = profiles ?? ['model-a'];
        return { ok: true, models: Object.fromEntries(list.map((p) => [p, snapshot(p)])) };
      },
      startRun: (request, _signal, prepared) => {
        models = prepared;
        return accepted(request.commandId);
      },
    });
    await starter.start(
      {
        commandId: 'cmd_models',
        sessionId: 's',
        brief: 'x',
        mode: 'mock',
        choice,
        team: { corralId: 'c' },
      },
      { fileTools: false },
    );
    expect(asked).toEqual([undefined, ['model-a', 'model-b']]);
    expect(Object.keys(models ?? {})).toEqual(['model-a', 'model-b']);
  });

  it('a missing Corral is refused, never replaced by another team', async () => {
    const started: Started[] = [];
    const starter = createAutoStarter({
      corral: () => null,
      startRun: (request) => {
        started.push(request);
        return accepted(request.commandId);
      },
    });
    const result = await starter.start(
      {
        commandId: 'cmd_missing',
        sessionId: 'session_team',
        brief: 'Do it',
        mode: 'mock',
        choice,
        team: { corralId: 'corral_deleted' },
      },
      { fileTools: false },
    );
    expect(result.runId).toBeNull();
    expect(result.receipt.error?.code).toBe('TARGET_NOT_FOUND');
    expect(started).toHaveLength(0);
  });
});

describe('session tools by default', () => {
  const binding = { profileId: 'session-default', revision: 1 };
  const capture = () => {
    const started: Parameters<Parameters<typeof createAutoStarter>[0]['startRun']>[0][] = [];
    const asked: string[] = [];
    const starter = createAutoStarter({
      route: () => Promise.reject(new Error('session chat sends no chooser request')),
      sessionHarness: (request) => {
        asked.push(request.commandId);
        return binding;
      },
      startRun: (request) => {
        started.push(request);
        return {
          runId: 'run_tools',
          receipt: {
            commandId: request.commandId,
            runId: 'run_tools',
            status: 'accepted',
            acceptedSeq: 1,
            target: 'run:run_tools',
            requestedBoundary: 'immediate',
            relatedEventIds: [],
          },
        };
      },
    });
    return { starter, started, asked };
  };
  const request = (team: 'none' | 'auto', commandId = `cmd_${team}`) => ({
    commandId,
    sessionId: 'session_tools',
    brief: 'Run the tests and fix them.',
    mode: 'live' as const,
    choice,
    team,
  });

  it('in a trusted folder the lead and its writers get command and preview tools', async () => {
    const { starter, started } = capture();
    await starter.start(request('none'), { fileTools: true });
    const [lead, helper] = started[0]?.definition.roles ?? [];
    expect(lead?.harness).toEqual(binding);
    expect(lead?.allowedWorkTools).toEqual(
      expect.arrayContaining(['run_command', 'preview_app', 'preview_action', 'preview_file']),
    );
    expect(helper?.harness).toEqual(binding);
    expect(helper?.allowedWorkTools).toContain('run_command');

    await starter.start(request('auto'), { fileTools: true });
    const roles = started[1]?.definition.roles ?? [];
    expect(roles.find((role) => role.id === 'team_writer')?.allowedWorkTools).toContain(
      'run_command',
    );
    // A reviewer is deliberately read-only.
    expect(roles.find((role) => role.id === 'team_reviewer')?.allowedWorkTools).not.toContain(
      'run_command',
    );
  });

  it('without a trusted folder no work style is bound and no command tool is offered', async () => {
    const { starter, started, asked } = capture();
    await starter.start(request('none'), { fileTools: false });
    const [lead] = started[0]?.definition.roles ?? [];
    expect(lead?.harness).toBeUndefined();
    expect(lead?.allowedWorkTools).not.toContain('run_command');
    expect(asked).toEqual([]);
    // An explicit work style still wins over the session default.
    const explicit = { profileId: 'chosen', revision: 3 };
    await starter.start(
      { ...request('none', 'cmd_explicit'), harness: explicit },
      {
        fileTools: true,
      },
    );
    expect(started[1]?.definition.roles[0]?.harness).toEqual(explicit);
    expect(asked).toEqual([]);
    // Simulated agents keep their file tools: a bound work style would only be simulated.
    await starter.start({ ...request('none', 'cmd_mock'), mode: 'mock' }, { fileTools: true });
    expect(started[2]?.definition.roles[0]?.harness).toBeUndefined();
    expect(started[2]?.definition.roles[0]?.allowedWorkTools).toContain('write_file');
    expect(asked).toEqual([]);
  });

  it('a final reply is published even when the loaded work style lists no output tools', async () => {
    const snapshot: EffectiveHarnessSnapshot = {
      binding,
      snapshotHash: 'a'.repeat(64),
      piVersion: '1.3.0',
      policyRevision: 1,
      policy: 'strict',
      resources: [],
      allowedTools: ['read_file', 'ask_user', 'update_plan'],
      tools: [],
      diagnostics: [],
    };
    const store = new InMemoryRunStore();
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      store,
      harnesses: {
        resolve: () => JSON.parse(JSON.stringify(snapshot)) as EffectiveHarnessSnapshot,
        readSkill: () => ({ text: '', sha256: 'e'.repeat(64) }),
      },
      agents: new ScriptedAgentAdapter({
        turns: 1,
        script: async (_input, host) => {
          await host.reportHarness?.({
            ok: true,
            snapshotHash: snapshot.snapshotHash,
            tools: [],
            diagnostics: [],
          });
          // A loaded work style's request carries its SDK record.
          const permit = await host.prepareModelRequest({
            purpose: 'turn',
            directiveIds: [],
            contextHash: 'd'.repeat(64),
            contextBytes: 250,
            sections: [],
          });
          await host.modelRequestDispatched?.(permit.modelCallId);
          await host.observe({
            kind: 'model_completed',
            modelCallId: permit.modelCallId,
            text: 'The tests pass now.',
            usage: { inputTokens: null, outputTokens: 19 },
          });
          return { outcome: 'succeeded', finalTextModelCallId: permit.modelCallId };
        },
      }),
    });
    const definition = conversationDefinition({
      id: 'conversation_harness',
      brief: 'Run the tests.',
      choice,
      fileTools: false,
      harness: binding,
    });
    const started = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start_harness',
      mode: 'mock',
      definition,
    });
    expect(started.receipt.error ?? null).toBeNull();
    const final = await waitForProjection(
      new InProcessTransport(coordinator),
      started.runId!,
      (p) => ['succeeded', 'failed'].includes(p.status),
    );
    expect(final.status).toBe('succeeded');
    const [output] = final.output?.artifactVersionIds ?? [];
    expect(output && store.getArtifactText(started.runId!, output)).toBe('The tests pass now.');
  });
});

describe('cancelling a delegating turn', () => {
  it('cancelling the run settles the lead’s wait as cancelled, not failed', async () => {
    const childStarted = new Gate();
    const release = new Gate();
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({
        turns: 1,
        beforeReply: async (_turn, input) => {
          if (input.assignment.kind !== 'delegated') return;
          childStarted.open();
          await release.wait();
        },
      }),
    });
    const transport = new InProcessTransport(coordinator);
    const started = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start_cancel',
      mode: 'mock',
      definition: conversationDefinition({
        id: 'conversation_cancel',
        brief: 'Use subagents.',
        choice,
        fileTools: false,
      }),
    });
    await childStarted.wait();
    await transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cancel_turn',
      runId: started.runId!,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'The person stopped this turn' },
    });
    release.open();
    const final = await waitForProjection(transport, started.runId!, (p) =>
      ['cancelled', 'failed', 'succeeded'].includes(p.status),
    );
    expect(final.status).toBe('cancelled');
    const failed = Object.values(final.effects).filter((effect) => effect.outcome === 'failed');
    expect(failed).toEqual([]);
  });
});
