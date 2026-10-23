import {
  type AgentStartInput,
  type MeetingConfig,
  type MeetingRound,
  SECRETARY_ID,
} from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
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

// CR-049 rules 1–17: only a person opens a round; no mention means everyone answers once;
// answers in a round are independent; rebuttals are opened by the person, at most two.

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
    store: new InMemoryRunStore(),
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: {
      start: async (input, host) => {
        seen.push(input);
        await options.onStart?.(input);
        return scripted.start(input, host);
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
    new MeetingService({ repository, transport, clock, newRoundId: () => `round_${++rounds}` });
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
      mode: 'mock',
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

describe('CR-049 meeting rounds', () => {
  it('[TC-MEET-001-H] no mention asks every participant once, independently, shown in participant order', async () => {
    let testerStarted!: () => void;
    const tester = new Promise<void>((resolve) => {
      testerStarted = resolve;
    });
    const f = await fixture({
      // The tester answers before the others; the meeting still shows the configured order.
      onStart: async (input) => {
        if (input.role.name === 'Tester') testerStarted();
        else await tester;
      },
    });
    const started = await f.send('c1', 'Should we split the service?');
    expect(started).toMatchObject({ ok: true, outcome: 'started' });
    await f.meetings.idle(f.sessionId);
    const first = (await f.meetings.view(f.sessionId))!;
    expect(first.rounds).toHaveLength(1);
    expect(first.rounds[0]).toMatchObject({
      kind: 'all',
      active: false,
      message: 'Should we split the service?',
    });
    expect(first.rounds[0]!.answers.map((a) => [a.participantId, a.status, a.text])).toEqual([
      ['architect', 'answered', 'Architect answers'],
      ['builder', 'answered', 'Builder answers'],
      ['tester', 'answered', 'Tester answers'],
    ]);
    expect(f.seen).toHaveLength(3);
    // A second round sees the first round's answers, never its own round's.
    await f.send('c2', 'And the database?');
    await f.meetings.idle(f.sessionId);
    const second = f.seen.slice(3);
    expect(second).toHaveLength(3);
    for (const input of second) {
      expect(brief(input)).toContain('Architect answers');
      expect(brief(input)).toContain('And the database?');
    }
    // Participants work only with an artifact and a submission: no files, commands or checks.
    for (const input of f.seen) {
      expect(input.role.allowedWorkTools).toEqual(['write_artifact']);
      expect(input.role.allowedCollaborationTools).toEqual(['submit_result']);
    }
    const runId = first.rounds[0]!.answers[0]!.runId!;
    expect((await f.transport.getSnapshot(runId)).projection.usageLimits).toBe('none');
  });

  it('[TC-MEET-001-H] @mentions narrow a round, and the secretary is called on its own', async () => {
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

  it('[TC-MEET-001-H] a rebuttal round answers the round before; at most two per message', async () => {
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
      expect(brief(input)).toMatch(/rebuttal/i);
    }
    expect(await f.rebut('r2', ['builder'])).toMatchObject({ ok: true });
    await f.meetings.idle(f.sessionId);
    expect(await f.rebut('r3')).toMatchObject({ ok: false, error: 'invalid' });
    const view = (await f.meetings.view(f.sessionId))!;
    expect(
      view.rounds.map((round) => [round.kind, round.rebuttalNo, round.participantIds]),
    ).toEqual([
      ['mention', null, ['architect', 'builder']],
      ['rebuttal', 1, ['architect', 'builder']],
      ['rebuttal', 2, ['builder']],
    ]);
    expect(view.rebuttal).toBeNull();
  });

  it('[TC-MEET-001-N] an agent naming who speaks next opens nothing, and rebuttals cannot add people', async () => {
    const f = await fixture({
      reply: () => '@Tester should answer next. @비서 please write minutes.',
    });
    await f.send('c1', 'Go', ['architect']);
    await f.meetings.idle(f.sessionId);
    const view = (await f.meetings.view(f.sessionId))!;
    expect(view.rounds).toHaveLength(1);
    expect(f.seen).toHaveLength(1);
    expect(await f.rebut('r1', ['tester'])).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('[TC-MEET-001-F] a message during a round waits once, starts when the round ends, and a second one is refused', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      onStart: async (input) => {
        if (brief(input).includes('first question')) await held;
      },
    });
    await f.send('c1', 'first question');
    expect(await f.send('c2', 'second question')).toMatchObject({ ok: true, outcome: 'queued' });
    expect(await f.send('c3', 'third question')).toMatchObject({ ok: false, error: 'busy' });
    expect(await f.rebut('r1')).toMatchObject({ ok: false, error: 'busy' });
    // The same command again is the same answer, not another message.
    expect(await f.send('c2', 'second question')).toMatchObject({ ok: true, outcome: 'queued' });
    expect((await f.meetings.view(f.sessionId))!.queued?.text).toBe('second question');
    release();
    await f.meetings.idle(f.sessionId);
    const view = (await f.meetings.view(f.sessionId))!;
    expect(view.rounds.map((round) => round.message)).toEqual([
      'first question',
      'second question',
    ]);
    expect(view.queued).toBeNull();
    expect(f.seen).toHaveLength(6);
  });

  it('[TC-MEET-001-F] stopping a round cancels every answer, keeps what arrived, and a late answer stays out', async () => {
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

  it('[TC-MEET-001-F] a failed participant shows as failed, the rest answer, and nothing retries', async () => {
    const f = await fixture({
      onStart: (input) => {
        if (input.role.name === 'Builder') throw new Error('provider unavailable');
      },
    });
    await f.send('c1', 'question');
    await f.meetings.idle(f.sessionId);
    const round = (await f.meetings.view(f.sessionId))!.rounds[0]!;
    expect(round.answers.map((a) => a.status)).toEqual(['answered', 'failed', 'answered']);
    expect(f.seen).toHaveLength(3);
  });

  it('[TC-MEET-001-F] reopening only reads; a waiting message left by a restart needs the person to send it', async () => {
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

  it('[TC-MEET-001-F] the same message command again returns the same round without new answers', async () => {
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

  it('[TC-MEET-001-N] a meeting origin cannot lift limits from a Run with tools or from another session', async () => {
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

  it('[TC-MEET-001-N] retries cannot change the participants, mode, or command kind', async () => {
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

  it('[TC-MEET-001-H] typed mentions match multiword participant names and do not treat email addresses as mentions', async () => {
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

  it('[TC-MEET-001-H] a waiting message can be edited without starting it, and stale edits cannot replace a later message', async () => {
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
      await f.send('c2', 'old question');
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

  it('[TC-MEET-001-F] a failed answer-record save cancels dispatched runs and reports the storage failure', async () => {
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
      expect(runs).toHaveLength(3);
      release();
      await vi.waitFor(async () => {
        for (const run of runs)
          expect((await f.transport.getSnapshot(run.runId)).projection.status).toBe('cancelled');
      });
    } finally {
      release();
    }
  });

  it('[TC-MEET-001-F] an unavailable snapshot cannot start another round while the participant may still be running', async () => {
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
      expect(await f.send('c2', 'second question')).toMatchObject({ ok: true, outcome: 'queued' });
      expect((await f.meetings.view(f.sessionId))!.rounds).toHaveLength(1);
    } finally {
      snapshot.mockRestore();
      release();
    }
    await f.meetings.idle(f.sessionId);
  });

  it('[TC-MEET-001-H] /반론 opens a rebuttal with typed mentions and the same two-round limit', async () => {
    const f = await fixture();
    await f.send('c1', 'question', ['architect', 'builder']);
    await f.meetings.idle(f.sessionId);
    await f.send('r1', '/반론 @Builder');
    await f.meetings.idle(f.sessionId);
    expect((await f.meetings.view(f.sessionId))!.rounds[1]).toMatchObject({
      kind: 'rebuttal',
      rebuttalNo: 1,
      participantIds: ['builder'],
    });
    await f.send('r2', '/반론');
    await f.meetings.idle(f.sessionId);
    expect(await f.send('r3', '/반론')).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('[TC-MEET-001-N] selected evidence is captured in every participant input and immutable for retries', async () => {
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

  it('[TC-MEET-001-H] total saved rounds have no meeting usage cap', async () => {
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
