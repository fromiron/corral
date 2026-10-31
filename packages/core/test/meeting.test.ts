import {
  type AgentStartInput,
  canonicalJson,
  type MeetingConfig,
  type MeetingRound,
  type MeetingSelectionInput,
  SECRETARY_ID,
} from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import {
  Coordinator,
  createKeyValueCorralRepository,
  createTextAttachment,
  InMemoryRunStore,
  InProcessTransport,
  MeetingService,
  meetingAnswerDefinition,
} from '../src/index.ts';

// chat correction: user messages carry the conversation; legacy request IDs and
// reply batches still preserve cancellation, replay and saved answer references.

const CONFIG: MeetingConfig = {
  version: 1,
  participants: [
    {
      participantId: 'architect',
      name: 'Architect',
      prompt: 'Guard the structure.',
      modelProfile: 'model-a',
    },
    {
      participantId: 'builder',
      name: 'Builder',
      prompt: 'Think about building it.',
      modelProfile: 'model-b',
    },
    {
      participantId: 'tester',
      name: 'Tester',
      prompt: 'Look for failures.',
      modelProfile: 'model-a',
    },
  ],
  secretary: { modelProfile: 'model-b' },
};

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

async function fixture(
  options: {
    /** Called as each answer starts; may block or throw. */
    onStart?: (input: AgentStartInput) => Promise<void> | void;
    reply?: (input: AgentStartInput) => string;
    config?: MeetingConfig;
    random?: () => number;
    persistent?: boolean;
    selectParticipants?: (input: MeetingSelectionInput) => Promise<string[] | null>;
  } = {},
) {
  const clock = new FakeClock();
  const seen: AgentStartInput[] = [];
  const scripted = new ScriptedAgentAdapter({
    turns: 1,
    collaborate: false,
    appendNotes: false,
    reply: (_turn, input) => options.reply?.(input) ?? `${input.role.name} answers`,
  });
  const coordinator = new Coordinator({
    ...(options.persistent
      ? {
          runtimeRecovery: { confirm: async () => {} },
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
    store: new InMemoryRunStore(),
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: {
      start: async (input, host) => {
        seen.push(input);
        await options.onStart?.(input);
        return scripted.start(
          input,
          options.persistent
            ? {
                ...host,
                observe: async (observation) => {
                  await host.observe(observation);
                  if (observation.kind === 'model_completed') {
                    const context = {
                      messages: [
                        ...(input.resumeContext?.context.context.messages ?? []),
                        { role: 'user', content: input.inputs[0]!.text, timestamp: 1 },
                        {
                          role: 'assistant',
                          content: [{ type: 'text', text: observation.text }],
                          stopReason: 'stop',
                          timestamp: 2,
                        },
                      ],
                    };
                    await host.checkpointContext!({
                      version: 1,
                      piVersion: '1.3.0',
                      runtime: 'pi-core',
                      context,
                      contextHash: bytesToHex(sha256(utf8ToBytes(canonicalJson(context)))),
                    });
                  }
                },
              }
            : host,
        );
      },
    },
  });
  const transport = new InProcessTransport(coordinator);
  const store = memoryStore();
  let next = 0;
  const repository = createKeyValueCorralRepository(store, {
    clock,
    newCorralId: () => `corral_${++next}`,
    newSessionId: () => `session_${++next}`,
  });
  let rounds = 0;
  const service = () =>
    new MeetingService({
      repository,
      transport,
      clock,
      newRoundId: () => `round_${++rounds}`,
      random: options.random ?? (() => 0.999),
      ...(options.selectParticipants ? { selectParticipants: options.selectParticipants } : {}),
      ...(options.persistent
        ? {
            continuation: (
              runId: string,
              sessionId: string,
              participantId: string,
              definition: import('@corral/contracts').CorralDefinition,
            ) =>
              coordinator.meetingContinuation(
                runId,
                sessionId,
                participantId,
                definition.roles[0]!,
              ),
          }
        : {}),
    });
  const meetings = service();
  const created = await meetings.create({
    projectId: 'default',
    title: 'Design review',
    config: options.config ?? CONFIG,
  });
  if (!created.ok) throw new Error(created.message);
  const sessionId = created.session.sessionId;
  const send = (commandId: string, text: string, mentions?: string[]) =>
    meetings.send(sessionId, {
      kind: 'message',
      commandId,
      mode: options.persistent ? 'live' : 'mock',
      text,
      ...(mentions ? { mentions } : {}),
    });
  const rebut = (commandId: string, mentions?: string[]) =>
    meetings.send(sessionId, {
      kind: 'rebuttal',
      commandId,
      mode: 'mock',
      ...(mentions ? { mentions } : {}),
    });
  return {
    coordinator,
    transport,
    repository,
    meetings,
    service,
    sessionId,
    send,
    rebut,
    seen,
    clock,
  };
}

const brief = (input: AgentStartInput) =>
  input.inputs.find((item) => item.name === 'brief')?.text ?? '';

describe('local meeting participant selection', () => {
  it('uses posted conversation, selects only the recipient and reuses it on command replay', async () => {
    const select = vi.fn(async (_input: MeetingSelectionInput) => ['tester']);
    const f = await fixture({ selectParticipants: select });
    await f.send('selected', 'How would you reproduce it?');
    await f.meetings.idle(f.sessionId);
    expect(f.seen.map((input) => input.role.name)).toEqual(['Tester']);
    expect(await f.send('selected', 'How would you reproduce it?')).toMatchObject({ ok: true });
    expect(select).toHaveBeenCalledTimes(1);
    await f.send('followup', 'Why?');
    await f.meetings.idle(f.sessionId);
    expect(select.mock.calls[1]![0].history).toContainEqual({
      participantId: 'tester',
      text: 'Tester answers',
    });
    expect(f.seen).toHaveLength(2);
    expect(await f.send('selected', 'How would you reproduce it?', ['tester'])).toMatchObject({
      ok: false,
      error: 'conflict',
    });
  });

  it('explicit recipients bypass selection, including secretary requests', async () => {
    const select = vi.fn(async () => ['tester']);
    const f = await fixture({ selectParticipants: select });
    await f.send('explicit', '@Builder Explain your view.');
    await f.meetings.idle(f.sessionId);
    await f.send('minutes_only', 'Summarize the discussion.', [SECRETARY_ID]);
    await f.meetings.idle(f.sessionId);
    expect(select).not.toHaveBeenCalled();
    expect(f.seen.map((input) => input.role.name)).toEqual(['Builder', 'Secretary']);
  });

  it.each([null, [], ['foreign'], [SECRETARY_ID], ['tester', 'tester']])(
    'falls back safely on an unusable selection %j',
    async (selected) => {
      const f = await fixture({ selectParticipants: async () => selected });
      await f.send('fallback', 'Compare your views.');
      await f.meetings.idle(f.sessionId);
      expect(f.seen).toHaveLength(CONFIG.participants.length);
    },
  );

  it('does not apply a late selection after the session revision changes', async () => {
    let release!: (ids: string[]) => void;
    const pending = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    const select = vi.fn(() => pending);
    const f = await fixture({ selectParticipants: select });
    const sent = f.send('late_selection', 'Which approach fits?');
    await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
    const session = (await f.repository.getSession(f.sessionId))!;
    await f.repository.updateSession(f.sessionId, {
      expectedRevision: session.revision,
      title: 'Changed',
    });
    release(['tester']);
    expect(await sent).toMatchObject({ ok: false, error: 'conflict' });
    expect(f.seen).toHaveLength(0);
  });
});

describe('meeting messages', () => {
  it('each participant reuses its own completed context and receives only newly posted messages', async () => {
    const f = await fixture({ persistent: true });
    await f.send('first_context', 'ORIGINAL_MEETING_INPUT');
    await expect
      .poll(async () =>
        (await f.meetings.view(f.sessionId))?.rounds[0]?.answers.every(
          (a) => a.status === 'answered',
        ),
      )
      .toBe(true);
    await f.send('second_context', 'FOLLOW_UP_ONLY');
    await expect
      .poll(async () =>
        (await f.meetings.view(f.sessionId))?.rounds[1]?.answers.every(
          (a) => a.status === 'answered',
        ),
      )
      .toBe(true);
    for (const input of f.seen.slice(0, 3)) expect(brief(input)).toContain('Conversation so far:');
    const second = f.seen.slice(3);
    expect(second).toHaveLength(3);
    for (const input of second) {
      expect(JSON.stringify(input.resumeContext)).toContain('ORIGINAL_MEETING_INPUT');
      expect(brief(input)).toContain('FOLLOW_UP_ONLY');
      expect(brief(input)).not.toContain('ORIGINAL_MEETING_INPUT');
      // a continuation names its content as new, not as the whole conversation.
      expect(brief(input)).toContain('Messages posted since your last reply:');
      expect(brief(input)).not.toContain('Conversation so far:');
      expect(JSON.stringify(input.resumeContext)).toContain(`${input.role.name} answers`);
      expect(brief(input)).not.toContain(`${input.role.name} answers`);
    }
  });
  it('neutral participants carry dinner suggestions into ordinary follow-up questions', async () => {
    const f = await fixture({
      config: {
        ...CONFIG,
        participants: CONFIG.participants.map((participant) => ({ ...participant, prompt: '' })),
      },
      reply: () => '김치찌개가 좋겠어요.',
    });
    await f.send('dinner', '오늘 저녁 뭐 먹을까?');
    await f.meetings.idle(f.sessionId);
    expect((await f.meetings.view(f.sessionId))!.minutes).toEqual([]);
    await f.send('why', '왜 그 메뉴를 추천해?', ['builder']);
    await f.meetings.idle(f.sessionId);
    const input = f.seen.at(-1)!;
    expect(input.role.name).toBe('Builder');
    expect(brief(input)).toContain('오늘 저녁 뭐 먹을까?');
    expect(brief(input)).toContain('김치찌개가 좋겠어요.');
    expect(brief(input)).toContain('왜 그 메뉴를 추천해?');
    const count = f.seen.length;
    await f.meetings.view(f.sessionId);
    expect(f.seen).toHaveLength(count);
    expect((await f.meetings.view(f.sessionId))!.minutes).toEqual([]);
  });

  it('independent replies share a snapshot and command replay does not duplicate their starts', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      onStart: async (input) => {
        await held;
      },
    });
    try {
      expect(await f.send('c1', '니들 배고프냐')).toMatchObject({ ok: true });
      expect(f.seen.map((input) => input.role.name)).toEqual(['Architect', 'Builder', 'Tester']);
      const waiting = (await f.meetings.view(f.sessionId))!.rounds[0]!;
      expect(waiting.active).toBe(true);
      expect(waiting.answers.map((item) => item.status)).toEqual(['running', 'running', 'running']);
      expect(waiting.answers.slice(1).every((item) => item.runId !== null)).toBe(true);
      expect(await f.send('c1', '니들 배고프냐')).toMatchObject({ ok: true });
      expect(f.seen).toHaveLength(3);
    } finally {
      release();
    }
    await f.meetings.idle(f.sessionId);
    expect(f.seen.map((input) => input.role.name)).toEqual(['Architect', 'Builder', 'Tester']);
    expect(brief(f.seen[0]!)).not.toContain('Builder answers');
    expect(brief(f.seen[1]!)).not.toContain('Architect answers');
    expect(brief(f.seen[1]!)).not.toContain('Tester answers');
    expect(brief(f.seen[2]!)).not.toContain('Architect answers');
    expect(brief(f.seen[2]!)).not.toContain('Builder answers');
    expect(new Set(f.seen.map(brief)).size).toBe(1);
    for (const input of f.seen) {
      expect(input.role.allowedWorkTools).toEqual(['write_artifact']);
      expect(input.role.allowedCollaborationTools).toEqual(['submit_result']);
    }
    const first = (await f.meetings.view(f.sessionId))!.rounds[0]!;
    expect(first.answers.map((item) => item.status)).toEqual(['answered', 'answered', 'answered']);
    expect((await f.transport.getSnapshot(first.answers[0]!.runId!)).projection.usageLimits).toBe(
      'none',
    );
  });

  it('shuffles each message once and keeps the saved order on replay and reopen', async () => {
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(0.999);
    const f = await fixture({ random });
    await f.send('c1', 'First');
    await f.meetings.idle(f.sessionId);
    expect(f.seen.map((input) => input.role.name)).toEqual(['Builder', 'Tester', 'Architect']);
    const first = (await f.meetings.view(f.sessionId))!.rounds[0]!;
    expect(first.participantIds).toEqual(['builder', 'tester', 'architect']);
    expect(await f.send('c1', 'First')).toMatchObject({ ok: true, roundId: first.roundId });
    expect((await f.service().view(f.sessionId))!.rounds[0]!.participantIds).toEqual(
      first.participantIds,
    );
    expect(random).toHaveBeenCalledTimes(2);
    expect(f.seen).toHaveLength(3);
    await f.send('c2', 'Second');
    await f.meetings.idle(f.sessionId);
    expect(f.seen.slice(3).map((input) => input.role.name)).toEqual([
      'Architect',
      'Builder',
      'Tester',
    ]);
    expect(random).toHaveBeenCalledTimes(4);
  });

  it('only the speaking participant receives its role instructions', async () => {
    const f = await fixture();
    await f.send('c1', 'How are you?');
    await f.meetings.idle(f.sessionId);
    for (const input of f.seen) {
      const own = CONFIG.participants.find((participant) => participant.name === input.role.name)!;
      expect(input.role.prompt).toContain(own.prompt);
      for (const other of CONFIG.participants.filter((participant) => participant !== own)) {
        expect(brief(input)).not.toContain(other.prompt);
        expect(input.role.prompt).not.toContain(other.prompt);
      }
    }
  });

  it('stopping the independent batch cancels every started reply', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({ onStart: () => held });
    await f.send('c1', 'Pause before anyone else speaks');
    const id = (await f.meetings.view(f.sessionId))!.rounds[0]!.roundId;
    await f.meetings.stop(f.sessionId, id);
    release();
    await f.meetings.idle(f.sessionId);
    expect(f.seen).toHaveLength(3);
    const after = (await f.meetings.view(f.sessionId))!.rounds[0]!;
    expect(after.answers.map((item) => item.status)).toEqual(['stopped', 'stopped', 'stopped']);
    expect(after.active).toBe(false);
  });

  it('reopening pending speakers after restart never calls them automatically', async () => {
    const f = await fixture();
    await f.send('c1', 'Saved conversation');
    await f.meetings.idle(f.sessionId);
    const session = (await f.repository.getSession(f.sessionId))!;
    const first = session.meeting!.rounds[0]!;
    await f.repository.updateSession(f.sessionId, {
      expectedRevision: session.revision,
      meeting: {
        ...session.meeting!,
        rounds: [
          {
            ...first,
            answers: first.answers.map((answer, index) =>
              index === 0
                ? answer
                : {
                    ...answer,
                    state: 'queued',
                    runId: null,
                  },
            ),
          },
        ],
      },
    });
    const reopened = await f.service().view(f.sessionId);
    expect(reopened!.rounds[0]!.answers.map((answer) => answer.status)).toEqual([
      'answered',
      'not_started',
      'not_started',
    ]);
    expect(reopened!.rounds[0]!.active).toBe(false);
    expect(f.seen).toHaveLength(3);
  });

  it('@mentions narrow a round, and the secretary is called on its own', async () => {
    const f = await fixture();
    await f.send('c1', '@builder how long would it take?');
    await f.meetings.idle(f.sessionId);
    await f.send('c2', 'And the risks?', ['tester']);
    await f.meetings.idle(f.sessionId);
    await f.send('c3', '@비서 summarise please');
    await f.meetings.idle(f.sessionId);
    const view = (await f.meetings.view(f.sessionId))!;
    expect(view.rounds.map((round) => [round.kind, round.participantIds])).toEqual([
      ['mention', ['builder']],
      ['mention', ['tester']],
      ['secretary', [SECRETARY_ID]],
    ]);
    const secretary = f.seen.at(-1)!;
    expect(secretary.modelProfile).toBe('model-b');
    expect(secretary.role.prompt).toMatch(/do not give opinions/i);
    expect(await f.send('c4', '@secretary and @builder together?')).toMatchObject({
      ok: false,
      error: 'invalid',
    });
  });

  it('legacy reply requests preserve context without a two-reply product limit', async () => {
    const f = await fixture();
    expect(await f.rebut('r0')).toMatchObject({ ok: false, error: 'invalid' });
    await f.send('c1', 'Monolith or services?', ['architect', 'builder']);
    await f.meetings.idle(f.sessionId);
    expect((await f.meetings.view(f.sessionId))!.rebuttal).toEqual({
      basedOnRoundId: (await f.meetings.view(f.sessionId))!.rounds[0]!.roundId,
      rebuttalNo: 1,
    });
    expect(await f.rebut('r1')).toMatchObject({ ok: true, outcome: 'started' });
    await f.meetings.idle(f.sessionId);
    const rebuttal = f.seen.slice(2);
    expect(rebuttal.map((input) => input.role.name)).toEqual(['Architect', 'Builder']);
    for (const input of rebuttal) {
      expect(brief(input)).toContain('Architect answers');
      expect(brief(input)).toContain('Builder answers');
      expect(brief(input)).toMatch(/respond.*messages/i);
    }
    expect(await f.rebut('r2', ['builder'])).toMatchObject({ ok: true });
    await f.meetings.idle(f.sessionId);
    expect(await f.rebut('r3')).toMatchObject({ ok: true });
    await f.meetings.idle(f.sessionId);
    const view = (await f.meetings.view(f.sessionId))!;
    expect(
      view.rounds.map((round) => [round.kind, round.rebuttalNo, round.participantIds]),
    ).toEqual([
      ['mention', null, ['architect', 'builder']],
      ['rebuttal', 1, ['architect', 'builder']],
      ['rebuttal', 2, ['builder']],
      ['rebuttal', 3, ['builder']],
    ]);
    expect(view.rebuttal?.rebuttalNo).toBe(4);
  });

  it('agent mentions call the named participant, including a previous speaker, once per posted answer', async () => {
    let architectReplies = 0;
    const f = await fixture({
      reply: (input) =>
        input.role.name === 'Architect'
          ? ++architectReplies === 1
            ? '@Tester what do you think? @Tester'
            : 'Agreed.'
          : '@Architect I prefer soup. @Unknown @Tester @비서',
    });
    const first = await f.send('c1', 'Pick dinner', ['architect']);
    await f.meetings.idle(f.sessionId);
    expect(f.seen.map((input) => input.role.name)).toEqual(['Architect', 'Tester', 'Architect']);
    expect(brief(f.seen[1]!)).toContain('@Tester what do you think?');
    expect(brief(f.seen[2]!)).toContain('I prefer soup.');
    const view = (await f.meetings.view(f.sessionId))!;
    expect(view.rounds[1]).toMatchObject({
      message: null,
      replyTo: { roundId: view.rounds[0]!.roundId, participantId: 'architect' },
    });
    expect(view.minutes).toEqual([]);
    expect(await f.send('c1', 'Pick dinner', ['architect'])).toEqual(first);
    await f.service().view(f.sessionId);
    expect(f.seen).toHaveLength(3);
  });

  it('a posted mention follows the independent batch as a separate sequential response', async () => {
    const f = await fixture({
      reply: (input) =>
        input.role.name === 'Architect' ? '@Tester please weigh in.' : 'My opinion.',
    });
    await f.send('c1', 'Dinner?');
    await f.meetings.idle(f.sessionId);
    expect(f.seen.map((input) => input.role.name)).toEqual([
      'Architect',
      'Builder',
      'Tester',
      'Tester',
    ]);
    expect(brief(f.seen[3]!)).toContain('@Tester please weigh in.');
    expect(brief(f.seen[3]!)).toContain('My opinion.');
  });

  it('a formatted mention still addresses the named participant', async () => {
    const f = await fixture({
      reply: (input) => (input.role.name === 'Architect' ? '**@Tester**, do you agree?' : 'Yes.'),
    });
    await f.send('c1', 'Go', ['architect']);
    await f.meetings.idle(f.sessionId);
    expect(f.seen.map((input) => input.role.name)).toEqual(['Architect', 'Tester']);
  });

  it('plain names, quoted tags, code and self tags do not call participants or the secretary', async () => {
    const f = await fixture({
      reply: () => 'Tester could help. @Architect @비서 @Unknown\n> @Tester quoted\n`@Builder`',
    });
    await f.send('c1', 'Go', ['architect']);
    await f.meetings.idle(f.sessionId);
    expect(f.seen).toHaveLength(1);
  });

  it('multiple human messages post immediately and replace unstarted replies after the current speaker finishes', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({ onStart: () => held, reply: () => 'I heard you.' });
    try {
      await f.send('c1', 'first question');
      expect(await f.send('c2', 'second question')).toMatchObject({ ok: true, outcome: 'started' });
      expect(await f.send('c3', 'third question', ['builder'])).toMatchObject({ ok: true });
      expect(await f.send('c3', 'third question', ['builder'])).toMatchObject({ ok: true });
      const pending = (await f.meetings.view(f.sessionId))!;
      expect(pending.rounds.map((round) => round.message)).toEqual([
        'first question',
        'second question',
        'third question',
      ]);
      expect(pending.queued).toBeNull();
      expect(f.seen).toHaveLength(3);
    } finally {
      release();
    }
    await f.meetings.idle(f.sessionId);
    expect(f.seen.map((input) => input.role.name)).toEqual([
      'Architect',
      'Builder',
      'Tester',
      'Builder',
    ]);
    expect(brief(f.seen[3]!)).toContain('second question');
    expect(brief(f.seen[3]!)).toContain('third question');
    expect(brief(f.seen[3]!)).toContain('I heard you.');
  });

  it('a new human message supersedes late agent mentions and stop cancels pending replies too', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({ onStart: () => held, reply: () => '@Tester answer me.' });
    await f.send('c1', 'First', ['architect']);
    await f.send('c2', 'Latest', ['builder']);
    const current = (await f.meetings.view(f.sessionId))!;
    await f.meetings.stop(f.sessionId, current.rounds[0]!.roundId);
    release();
    await f.meetings.idle(f.sessionId);
    expect(f.seen).toHaveLength(1);
    expect((await f.meetings.view(f.sessionId))!.rounds.every((round) => !round.active)).toBe(true);
  });

  it('a late mention yields to newer human input, and a stale stop cannot cancel that input', async () => {
    let release!: () => void;
    let releaseBuilder!: () => void;
    const architect = new Promise<void>((resolve) => {
      release = resolve;
    });
    const builder = new Promise<void>((resolve) => {
      releaseBuilder = resolve;
    });
    const f = await fixture({
      onStart: (input) => (input.role.name === 'Architect' ? architect : builder),
      reply: (input) =>
        input.role.name === 'Architect' ? '@Tester please respond.' : 'New message received.',
    });
    try {
      await f.send('c1', 'First', ['architect']);
      const first = (await f.meetings.view(f.sessionId))!.rounds[0]!;
      await f.send('c2', 'Latest', ['builder']);
      release();
      await vi.waitFor(() => expect(f.seen).toHaveLength(2));
      expect(f.seen[1]!.role.name).toBe('Builder');
      await f.meetings.stop(f.sessionId, first.roundId);
      expect((await f.meetings.view(f.sessionId))!.rounds[1]!.active).toBe(true);
    } finally {
      release();
      releaseBuilder();
    }
    await f.meetings.idle(f.sessionId);
    expect(f.seen).toHaveLength(2);
    expect((await f.meetings.view(f.sessionId))!.rounds[1]!.answers[0]!.status).toBe('answered');
  });

  it('stopping a round cancels every answer, keeps what arrived, and a late answer stays out', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      onStart: async (input) => {
        if (input.role.name === 'Builder') await held;
      },
    });
    await f.send('c1', 'question');
    await vi.waitFor(async () =>
      expect(
        (await f.meetings.view(f.sessionId))!.rounds[0]!.answers.find(
          (a) => a.participantId === 'architect',
        )?.status,
      ).toBe('answered'),
    );
    const roundId = (await f.meetings.view(f.sessionId))!.rounds[0]!.roundId;
    expect(await f.meetings.stop(f.sessionId, roundId)).toMatchObject({ ok: true });
    release();
    await f.meetings.idle(f.sessionId);
    const round = (await f.meetings.view(f.sessionId))!.rounds[0]!;
    expect(round.stoppedAt).not.toBeNull();
    expect(round.active).toBe(false);
    expect(round.answers.find((a) => a.participantId === 'architect')).toMatchObject({
      status: 'answered',
      text: 'Architect answers',
    });
    expect(round.answers.find((a) => a.participantId === 'builder')?.status).toBe('stopped');
    expect(round.answers.find((a) => a.participantId === 'builder')?.text).toBeNull();
  });

  it('a failed participant shows as failed, the rest answer, and nothing retries', async () => {
    const f = await fixture({
      onStart: (input) => {
        if (input.role.name === 'Builder') throw new Error('HTTP 500: provider unavailable');
      },
    });
    await f.send('c1', 'question');
    await f.meetings.idle(f.sessionId);
    const round = (await f.meetings.view(f.sessionId))!.rounds[0]!;
    expect(round.answers.map((a) => a.status)).toEqual(['answered', 'failed', 'answered']);
    expect(round.answers.find((answer) => answer.status === 'failed')?.detail).toContain(
      'HTTP 500: provider unavailable',
    );
    expect(f.seen).toHaveLength(3);
  });

  it('reopening only reads; a waiting message left by a restart needs the person to send it', async () => {
    const f = await fixture();
    await f.send('c1', 'first');
    await f.meetings.idle(f.sessionId);
    const runs = (await f.coordinator.listRuns()).length;
    const session = (await f.repository.getSession(f.sessionId))!;
    // A restart left a message waiting: storage has it, no service is driving it.
    await f.repository.updateSession(f.sessionId, {
      expectedRevision: session.revision,
      meeting: {
        ...session.meeting!,
        queued: { commandId: 'waiting', mode: 'mock', text: 'left over', mentions: [] },
      },
    });
    const restarted = f.service();
    const reopened = (await restarted.view(f.sessionId))!;
    expect(reopened.rounds).toHaveLength(1);
    expect(reopened.queued?.text).toBe('left over');
    expect((await f.coordinator.listRuns()).length).toBe(runs);
    expect(await restarted.sendQueued(f.sessionId)).toMatchObject({ ok: true, outcome: 'started' });
    await restarted.idle(f.sessionId);
    const after = (await restarted.view(f.sessionId))!;
    expect(after.rounds.map((round) => round.message)).toEqual(['first', 'left over']);
    expect(after.queued).toBeNull();
  });

  it('the same message command again returns the same round without new answers', async () => {
    const f = await fixture();
    const first = await f.send('c1', 'question');
    await f.meetings.idle(f.sessionId);
    const again = await f.send('c1', 'question');
    expect(again).toMatchObject({
      ok: true,
      outcome: 'started',
      roundId: (first as { roundId: string }).roundId,
    });
    expect(f.seen).toHaveLength(3);
    expect(await f.send('c1', 'a different question')).toMatchObject({
      ok: false,
      error: 'conflict',
    });
  });

  it('a meeting origin cannot lift limits from a Run with tools or from another session', async () => {
    const f = await fixture();
    const definition = meetingAnswerDefinition(CONFIG, 'builder', 'round_x', 'brief');
    const start = (
      commandId: string,
      change: Partial<Parameters<typeof f.transport.startRun>[0]>,
    ) =>
      f.transport.startRun({
        schemaVersion: '0.1',
        commandId,
        definition,
        mode: 'mock',
        sessionId: f.sessionId,
        meeting: { sessionId: f.sessionId, roundId: 'round_x', participantId: 'builder' },
        ...change,
      } as Parameters<typeof f.transport.startRun>[0]);
    const withFiles = JSON.parse(JSON.stringify(definition)) as typeof definition;
    withFiles.roles[0]!.allowedWorkTools = ['write_artifact', 'read_file'];
    for (const [commandId, change] of [
      ['files', { definition: withFiles }],
      ['elsewhere', { sessionId: 'session_other' }],
    ] as const) {
      const refused = await start(commandId, change);
      expect(refused.runId).toBeNull();
      expect(refused.receipt.error?.code).toBe('CAPABILITY_DENIED');
    }
    expect((await start('fine', {})).runId).toBeTruthy();
  });

  it('retries cannot change the participants, mode, or command kind', async () => {
    const f = await fixture();
    await f.send('c1', 'question', ['architect']);
    await f.meetings.idle(f.sessionId);
    expect(await f.send('c1', 'question', ['builder'])).toMatchObject({
      ok: false,
      error: 'conflict',
    });
    expect(
      await f.meetings.send(f.sessionId, {
        kind: 'message',
        commandId: 'c1',
        mode: 'live',
        text: 'question',
        mentions: ['architect'],
      }),
    ).toMatchObject({ ok: false, error: 'conflict' });
    await f.rebut('r1', ['architect']);
    await f.meetings.idle(f.sessionId);
    expect(await f.rebut('r1', ['builder'])).toMatchObject({ ok: false, error: 'conflict' });
    expect(f.seen).toHaveLength(2);
  });

  it('typed mentions match multiword participant names and do not treat email addresses as mentions', async () => {
    const f = await fixture({
      config: {
        ...CONFIG,
        participants: CONFIG.participants.map((participant) =>
          participant.participantId === 'architect'
            ? { ...participant, name: 'Lead Architect' }
            : participant,
        ),
      },
    });
    await f.send('c1', '@Lead Architect, check this.');
    await f.meetings.idle(f.sessionId);
    expect((await f.meetings.view(f.sessionId))!.rounds[0]!.participantIds).toEqual(['architect']);
    await f.send('c2', 'Send mail to support@builder');
    await f.meetings.idle(f.sessionId);
    expect((await f.meetings.view(f.sessionId))!.rounds[1]!.participantIds).toEqual([
      'architect',
      'builder',
      'tester',
    ]);
    expect(await f.send('c3', '@Nobody please answer')).toMatchObject({
      ok: false,
      error: 'invalid',
    });
  });

  it('a waiting message can be edited without starting it, and stale edits cannot replace a later message', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      onStart: async (input) => {
        if (brief(input).includes('first question')) await held;
      },
    });
    try {
      await f.send('c1', 'first question');
      const session = (await f.repository.getSession(f.sessionId))!;
      await f.repository.updateSession(f.sessionId, {
        expectedRevision: session.revision,
        meeting: {
          ...session.meeting!,
          queued: { commandId: 'c2', mode: 'mock', text: 'old question', mentions: [] },
        },
      });
      expect(
        await f.meetings.editQueued(f.sessionId, {
          commandId: 'c2',
          mode: 'mock',
          text: '@builder corrected question',
          mentions: [],
        }),
      ).toMatchObject({ ok: true, outcome: 'updated' });
      expect(
        await f.meetings.editQueued(f.sessionId, {
          commandId: 'old-command',
          mode: 'mock',
          text: 'stale edit',
          mentions: [],
        }),
      ).toMatchObject({ ok: false, error: 'conflict' });
      expect(f.seen).toHaveLength(3);
    } finally {
      release();
    }
    await f.meetings.idle(f.sessionId);
    const view = (await f.meetings.view(f.sessionId))!;
    expect(view.rounds[1]).toMatchObject({
      message: '@builder corrected question',
      participantIds: ['builder'],
    });
    expect(f.seen).toHaveLength(4);
  });

  it('a failed answer-record save cancels dispatched runs and reports the storage failure', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({ onStart: () => held });
    const update = f.repository.updateSession.bind(f.repository);
    vi.spyOn(f.repository, 'updateSession').mockImplementation((sessionId, input) =>
      input.meeting?.rounds.some((round) =>
        round.answers.some((answer) => answer.state === 'started'),
      )
        ? Promise.resolve({ ok: false, error: 'storage_unavailable', message: 'Disk full' })
        : update(sessionId, input),
    );
    try {
      expect(await f.send('c1', 'question')).toMatchObject({
        ok: false,
        error: 'storage_unavailable',
      });
      const runs = await f.coordinator.listRuns();
      expect(runs).toHaveLength(1);
      release();
      await vi.waitFor(async () => {
        for (const run of runs)
          expect((await f.transport.getSnapshot(run.runId)).projection.status).toBe('cancelled');
      });
    } finally {
      release();
    }
  });

  it('an unavailable snapshot cannot start another round while the participant may still be running', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({ onStart: () => held });
    await f.send('c1', 'first question');
    const snapshot = vi
      .spyOn(f.transport, 'getSnapshot')
      .mockRejectedValue(new Error('Temporarily unavailable'));
    try {
      expect(await f.send('c2', 'second question')).toMatchObject({ ok: true, outcome: 'started' });
      expect((await f.meetings.view(f.sessionId))!.rounds).toHaveLength(2);
      expect(f.seen).toHaveLength(3);
    } finally {
      snapshot.mockRestore();
      release();
    }
    await f.meetings.idle(f.sessionId);
  });

  it('/반론 remains ordinary message text and does not require a prior discussion', async () => {
    const f = await fixture();
    expect(await f.send('r1', '/반론 @Builder 이 의견은 어때?')).toMatchObject({ ok: true });
    await f.meetings.idle(f.sessionId);
    expect((await f.meetings.view(f.sessionId))!.rounds[0]).toMatchObject({
      kind: 'mention',
      message: '/반론 @Builder 이 의견은 어때?',
      rebuttalNo: null,
      participantIds: ['builder'],
    });
  });

  it('selected evidence is captured in every participant input and immutable for retries', async () => {
    const f = await fixture();
    const attachment = createTextAttachment(
      'chosen.txt',
      'text/plain',
      'Only this selected evidence.',
    );
    const request = {
      kind: 'message' as const,
      commandId: 'c1',
      mode: 'mock' as const,
      text: 'Discuss this evidence.',
      attachments: [attachment],
    };
    expect(await f.meetings.send(f.sessionId, request)).toMatchObject({ ok: true });
    await f.meetings.idle(f.sessionId);
    for (const input of f.seen) expect(brief(input)).toContain(attachment.text);
    expect((await f.meetings.view(f.sessionId))!.rounds[0]!.attachments).toEqual([attachment]);
    expect(await f.meetings.send(f.sessionId, { ...request, attachments: [] })).toMatchObject({
      ok: false,
      error: 'conflict',
    });
    expect(
      await f.meetings.send(f.sessionId, {
        ...request,
        commandId: 'c2',
        attachments: [{ ...attachment, text: 'Changed without rehashing' }],
      }),
    ).toMatchObject({ ok: false, error: 'invalid' });
    expect(f.seen).toHaveLength(3);
  });

  it('total saved rounds have no meeting usage cap', async () => {
    const f = await fixture();
    const session = (await f.repository.getSession(f.sessionId))!;
    const rounds: MeetingRound[] = Array.from({ length: 1000 }, (_, index) => ({
      roundId: `history_${index}`,
      commandId: `history_command_${index}`,
      mode: 'mock',
      kind: 'all',
      message: 'Recorded question',
      basedOnRoundId: null,
      rebuttalNo: null,
      participantIds: CONFIG.participants.map((participant) => participant.participantId),
      answers: CONFIG.participants.map((participant) => ({
        participantId: participant.participantId,
        state: 'not_started',
        runId: null,
        detail: null,
      })),
      createdAt: f.clock.nowIso(),
      stoppedAt: null,
    }));
    expect(
      await f.repository.updateSession(f.sessionId, {
        expectedRevision: session.revision,
        meeting: { ...session.meeting!, rounds },
      }),
    ).toMatchObject({ ok: true });
    expect(await f.send('next', 'The next question')).toMatchObject({
      ok: true,
      outcome: 'started',
    });
    await f.meetings.idle(f.sessionId);
    expect((await f.meetings.view(f.sessionId))!.rounds).toHaveLength(1001);
    expect(f.seen).toHaveLength(3);
  });
});

it('independent participants start together with the same posted-message snapshot', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ onStart: () => held });
  try {
    await f.send('parallel_message', 'Give your independent view.');
    await vi.waitFor(() => expect(f.seen).toHaveLength(3), { timeout: 250 });
    const briefs = f.seen.map((input) => input.inputs.map((source) => source.text).join('\n'));
    expect(new Set(briefs).size).toBe(1);
    expect(briefs[0]).not.toContain('Architect answers');
  } finally {
    release();
    await f.meetings.idle(f.sessionId);
  }
});

it('a parallel answer completing before the first participant still schedules its mention once', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let builderReplies = 0;
  const f = await fixture({
    onStart: (input) => (input.role.name === 'Architect' ? held : undefined),
    reply: (input) =>
      input.role.name === 'Builder' && builderReplies++ === 0
        ? '@Tester Please examine this.'
        : `${input.role.name} done`,
  });
  await f.send('mentions_parallel', 'Compare your views.');
  release();
  await f.meetings.idle(f.sessionId);
  expect(f.seen.filter((input) => input.role.name === 'Tester')).toHaveLength(2);
  const total = f.seen.length;
  await f.meetings.view(f.sessionId);
  expect(f.seen).toHaveLength(total);
});
