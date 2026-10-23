import {
  type Clock,
  type CorralDefinition,
  canonicalJson,
  DEFAULT_LIMITS,
  type MeetingAnswer,
  type MeetingAnswerView,
  type MeetingConfig,
  type MeetingRound,
  MeetingRoundRequest,
  type MeetingState,
  type MeetingView,
  QueuedMeetingMessage,
  SECRETARY_ID,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import { validTextAttachments } from './attachments.ts';
import { recordMeetingMinutes, SECRETARY_MINUTES_INSTRUCTIONS } from './meeting-decisions.ts';
import { formatMeetingEvidence } from './meeting-evidence.ts';
import type { CorralRepository, SessionResult, WorkSession } from './repository/index.ts';
import { type RuntimeTransport, waitForProjection } from './transport.ts';

// CR-049 C-174: the meeting's turn-taking rules. Only a person's message opens a round; every
// answer is its own read-only Run started through the runtime, so the Coordinator owns its
// execution, cancel and usage. This service only records rounds and reads their Runs.

export interface MeetingServiceDeps {
  repository: Pick<CorralRepository, 'createSession' | 'getSession' | 'updateSession'>;
  transport: RuntimeTransport;
  clock: Clock;
  newRoundId(): string;
}

export type MeetingResult =
  | { ok: true; outcome: 'started' | 'queued' | 'updated'; roundId?: string }
  | {
      ok: false;
      error: 'not_found' | 'invalid' | 'busy' | 'conflict' | 'storage_unavailable';
      message: string;
    };

const SECRETARY_NAMES = new Set([SECRETARY_ID, '비서']);
const MAX_REBUTTALS = 2;

const PARTICIPANT_RULES =
  'You take part in a meeting that a person runs. Answer the person from your role in your own voice. You see the meeting so far, but not what the other participants answer in this round. Do not speak for other participants, do not ask them to reply, and do not plan who speaks next: only the person opens rounds. You cannot change files or run anything; say what should be checked instead. Answer in the language of the person’s latest message. Write your answer as your artifact and submit it.';
const SECRETARY_RULES =
  'You are the meeting secretary. Do not give opinions of your own. Summarise the meeting so far: the issues, what each participant claimed, what they agree on, the disagreements that remain, unverified facts, decision candidates and next actions. Never count a participant who did not answer, or whose answer failed, as agreeing. Answer in the language of the person’s latest message. Write the summary as your artifact and submit it.';

const err = (error: Extract<MeetingResult, { ok: false }>['error'], message: string) =>
  ({ ok: false, error, message }) as const;

/** Mentions written as `@name` (a participant's name or ID, or the secretary). */
function mentionsIn(text: string, config: MeetingConfig): string[] | null {
  const found = new Set<string>();
  const names = [
    ...[...SECRETARY_NAMES].map((name) => ({ name, participantId: SECRETARY_ID })),
    ...config.participants.flatMap((participant) => [
      { name: participant.name.toLowerCase(), participantId: participant.participantId },
      { name: participant.participantId.toLowerCase(), participantId: participant.participantId },
    ]),
  ].sort((a, b) => b.name.length - a.name.length);
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])@/gu)) {
    const rest = text.slice(match.index + 1).toLowerCase();
    const participant = names.find(
      ({ name }) =>
        rest.startsWith(name) &&
        (!rest[name.length] || /[\s,.;:!?()[\]{}]/u.test(rest[name.length]!)),
    );
    if (!participant) return null;
    found.add(participant.participantId);
  }
  return [...found];
}

function messageMentions(text: string, selected: string[], config: MeetingConfig): string[] | null {
  const typed = mentionsIn(text, config);
  if (!typed) return null;
  const all = new Set([...selected, ...typed]);
  const known = [...config.participants.map((p) => p.participantId), SECRETARY_ID];
  if ([...all].some((id) => !known.includes(id)) || (all.has(SECRETARY_ID) && all.size > 1))
    return null;
  return known.filter((id) => all.has(id));
}

const sameParticipants = (first: string[], second: string[]) =>
  first.length === second.length && first.every((id, index) => id === second[index]);

function nameOf(config: MeetingConfig, participantId: string) {
  return participantId === SECRETARY_ID
    ? 'Secretary'
    : (config.participants.find((p) => p.participantId === participantId)?.name ?? participantId);
}

/** One answer's Run, as a single read-only role with only the meeting record as input. */
export function meetingAnswerDefinition(
  config: MeetingConfig,
  participantId: string,
  roundId: string,
  brief: string,
): CorralDefinition {
  const participant = config.participants.find((p) => p.participantId === participantId);
  const name = nameOf(config, participantId);
  const prompt = participant
    ? `${PARTICIPANT_RULES}\n\nYour name: ${name}\nYour role: ${participant.prompt}`
    : `${SECRETARY_RULES}${config.secretary.prompt ? `\n\n${config.secretary.prompt}` : ''}\n\n${SECRETARY_MINUTES_INSTRUCTIONS}`;
  return {
    schemaVersion: '0.1',
    id: `meeting_${roundId}`,
    name: `Meeting · ${name}`,
    entryNodeId: 'answer',
    input: { brief, criteria: [`Answer as ${name}, within the meeting rules.`] },
    roles: [
      {
        id: 'participant',
        name,
        prompt,
        modelProfile: participant?.modelProfile ?? config.secretary.modelProfile,
        allowedWorkTools: ['write_artifact'],
        allowedCollaborationTools: ['submit_result'],
        outputContract: 'text',
      },
    ],
    nodes: [
      {
        id: 'answer',
        type: 'agent',
        label: name,
        roleId: 'participant',
        invocation: 'scheduled',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'answer',
      },
      {
        id: 'output',
        type: 'output',
        label: 'Output',
        inputBindings: [{ kind: 'task_output', name: 'answer', sourceNodeId: 'answer' }],
        requireApproval: false,
      },
    ],
    controlEdges: [
      { id: 'e1', source: 'answer', sourcePort: 'out', target: 'output', targetPort: 'in' },
    ],
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
  };
}

type RoundView = MeetingView['rounds'][number];

export class MeetingService {
  private readonly deps: MeetingServiceDeps;
  /** One mutation at a time per meeting; storage CAS still guards other writers. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Rounds this process is waiting on, to start a waiting message when they end. */
  private readonly watchers = new Map<string, Set<Promise<void>>>();

  constructor(deps: MeetingServiceDeps) {
    this.deps = deps;
  }

  create(input: { projectId: string; title: string; config: MeetingConfig }) {
    return this.deps.repository.createSession({
      projectId: input.projectId,
      title: input.title,
      meeting: input.config,
    });
  }

  /** Reads the record and each answer's Run; never starts anything (CR-049 rule 15). */
  async view(sessionId: string): Promise<MeetingView | null> {
    let session = await this.deps.repository.getSession(sessionId);
    if (!session?.meeting) return null;
    for (const round of session.meeting.rounds) {
      if (
        round.kind === 'secretary' &&
        !session.meeting.minutes?.some((item) => item.roundId === round.roundId)
      )
        await recordMeetingMinutes(this.deps, sessionId, round.roundId);
    }
    session = await this.deps.repository.getSession(sessionId);
    if (!session?.meeting) return null;
    const rounds = await Promise.all(session.meeting.rounds.map((round) => this.roundView(round)));
    return {
      sessionId,
      revision: session.revision,
      config: session.meeting.config,
      rounds,
      queued: session.meeting.queued,
      minutes: session.meeting.minutes ?? [],
      decisions: session.meeting.decisions ?? [],
      decisionWithdrawals: session.meeting.decisionWithdrawals ?? [],
      rebuttal: rounds.some((round) => round.active) ? null : this.nextRebuttal(session.meeting),
    };
  }

  send(sessionId: string, input: MeetingRoundRequest): Promise<MeetingResult> {
    return this.locked(sessionId, async () => {
      const parsed = MeetingRoundRequest.safeParse(input);
      if (!parsed.success) return err('invalid', 'The meeting request is not valid.');
      let request = parsed.data;
      if (request.kind === 'message' && !validTextAttachments(request.attachments ?? []))
        return err('invalid', 'The selected evidence content does not match its recorded digest.');
      const session = await this.deps.repository.getSession(sessionId);
      if (!session?.meeting) return err('not_found', `Meeting ${sessionId} does not exist.`);
      const meeting = session.meeting;
      if (request.kind === 'message' && /^\/반론(?:\s|$)/u.test(request.text)) {
        if (request.attachments?.length)
          return err('invalid', 'Send new evidence in a message before opening a rebuttal.');
        const mentions = messageMentions(request.text, request.mentions ?? [], meeting.config);
        if (!mentions) return err('invalid', 'Mention participants from the previous round.');
        request = { kind: 'rebuttal', commandId: request.commandId, mode: request.mode, mentions };
      }
      const previous = meeting.rounds.find((round) => round.commandId === request.commandId);
      if (request.kind === 'message') {
        const mentions = messageMentions(request.text, request.mentions ?? [], meeting.config);
        if (!mentions)
          return err('invalid', 'Mention meeting participants, or call the secretary on its own.');
        const participantIds = mentions.length
          ? mentions
          : meeting.config.participants.map((p) => p.participantId);
        if (previous)
          return previous.message === request.text &&
            (previous.mode === undefined || previous.mode === request.mode) &&
            sameParticipants(previous.participantIds, participantIds) &&
            canonicalJson(previous.attachments ?? []) === canonicalJson(request.attachments ?? [])
            ? { ok: true, outcome: 'started', roundId: previous.roundId }
            : err('conflict', 'This command was already sent with different arguments.');
        if (meeting.queued?.commandId === request.commandId)
          return meeting.queued.text === request.text &&
            meeting.queued.mode === request.mode &&
            sameParticipants(meeting.queued.mentions, mentions) &&
            canonicalJson(meeting.queued.attachments ?? []) ===
              canonicalJson(request.attachments ?? [])
            ? { ok: true, outcome: 'queued' }
            : err('conflict', 'This command was already sent with different arguments.');
        if (await this.active(meeting)) {
          if (meeting.queued) return err('busy', 'A message is already waiting for this round.');
          return this.save(
            session,
            {
              ...meeting,
              queued: {
                commandId: request.commandId,
                mode: request.mode,
                text: request.text,
                mentions,
                ...(request.attachments ? { attachments: request.attachments } : {}),
              },
            },
            { ok: true, outcome: 'queued' },
          );
        }
        if (meeting.queued) return err('busy', 'Send or remove the waiting message first.');
        return this.start(session, {
          commandId: request.commandId,
          mode: request.mode,
          kind: mentions.includes(SECRETARY_ID) ? 'secretary' : mentions.length ? 'mention' : 'all',
          message: request.text,
          participantIds,
          ...(request.attachments ? { attachments: request.attachments } : {}),
          basedOnRoundId: null,
          rebuttalNo: null,
        });
      }
      if (previous) {
        const base = meeting.rounds.find((round) => round.roundId === previous.basedOnRoundId);
        const mentions = request.mentions ?? [];
        const participantIds = mentions.length
          ? (base?.participantIds.filter((id) => mentions.includes(id)) ?? [])
          : (base?.participantIds ?? []);
        return previous.kind === 'rebuttal' &&
          (previous.mode === undefined || previous.mode === request.mode) &&
          mentions.every((id) => base?.participantIds.includes(id)) &&
          sameParticipants(previous.participantIds, participantIds)
          ? { ok: true, outcome: 'started', roundId: previous.roundId }
          : err('conflict', 'This command was already sent with different arguments.');
      }
      if (meeting.queued || (await this.active(meeting)))
        return err('busy', 'A round is running or a message is waiting.');
      const next = this.nextRebuttal(meeting);
      if (!next)
        return err('invalid', 'There is no round to answer, or it already had two rebuttals.');
      const base = meeting.rounds.find((round) => round.roundId === next.basedOnRoundId)!;
      const mentions = request.mentions ?? [];
      if (mentions.some((id) => !base.participantIds.includes(id)))
        return err('invalid', 'A rebuttal round keeps the participants of the round it answers.');
      return this.start(session, {
        commandId: request.commandId,
        mode: request.mode,
        kind: 'rebuttal',
        message: null,
        participantIds: mentions.length
          ? base.participantIds.filter((id) => mentions.includes(id))
          : base.participantIds,
        basedOnRoundId: base.roundId,
        rebuttalNo: next.rebuttalNo,
      });
    });
  }

  /** Stops every answer of a round; what already arrived stays (CR-049 rule 14). */
  stop(sessionId: string, roundId: string): Promise<MeetingResult> {
    return this.locked(sessionId, async () => {
      const session = await this.deps.repository.getSession(sessionId);
      const round = session?.meeting?.rounds.find((item) => item.roundId === roundId);
      if (!session?.meeting || !round) return err('not_found', 'The round does not exist.');
      if (!round.stoppedAt) {
        const saved = await this.save(
          session,
          {
            ...session.meeting,
            rounds: session.meeting.rounds.map((item) =>
              item.roundId === roundId ? { ...item, stoppedAt: this.deps.clock.nowIso() } : item,
            ),
          },
          { ok: true, outcome: 'updated', roundId },
        );
        if (!saved.ok) return saved;
      }
      await this.cancelAnswers(roundId, round.answers);
      return { ok: true, outcome: 'updated', roundId };
    });
  }

  /** Starts the waiting message when no round runs; after a restart only a person does this. */
  sendQueued(sessionId: string): Promise<MeetingResult> {
    return this.locked(sessionId, () => this.startQueued(sessionId));
  }

  editQueued(sessionId: string, input: QueuedMeetingMessage): Promise<MeetingResult> {
    return this.locked(sessionId, async () => {
      const parsed = QueuedMeetingMessage.safeParse(input);
      if (!parsed.success || !parsed.data.text.trim())
        return err('invalid', 'The waiting message is not valid.');
      if (!validTextAttachments(parsed.data.attachments ?? []))
        return err('invalid', 'The selected evidence content does not match its recorded digest.');
      const session = await this.deps.repository.getSession(sessionId);
      if (!session?.meeting) return err('not_found', `Meeting ${sessionId} does not exist.`);
      if (session.meeting.queued?.commandId !== parsed.data.commandId)
        return err('conflict', 'The waiting message has already changed or started.');
      const text = parsed.data.text.trim();
      const mentions = messageMentions(text, parsed.data.mentions, session.meeting.config);
      if (!mentions)
        return err('invalid', 'Mention meeting participants, or call the secretary on its own.');
      return this.save(
        session,
        { ...session.meeting, queued: { ...parsed.data, text, mentions } },
        { ok: true, outcome: 'updated' },
      );
    });
  }

  dropQueued(sessionId: string): Promise<MeetingResult> {
    return this.locked(sessionId, async () => {
      const session = await this.deps.repository.getSession(sessionId);
      if (!session?.meeting) return err('not_found', `Meeting ${sessionId} does not exist.`);
      if (!session.meeting.queued) return { ok: true, outcome: 'updated' };
      return this.save(
        session,
        { ...session.meeting, queued: null },
        { ok: true, outcome: 'updated' },
      );
    });
  }

  /** Resolves once the rounds this process watches have ended and their waiting message started. */
  async idle(sessionId: string): Promise<void> {
    for (;;) {
      const pending = [...(this.watchers.get(sessionId) ?? [])];
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private locked<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(
      sessionId,
      next.catch(() => {}),
    );
    return next;
  }

  private async save(
    session: WorkSession,
    meeting: MeetingState,
    success: Extract<MeetingResult, { ok: true }>,
  ): Promise<MeetingResult> {
    const saved: SessionResult = await this.deps.repository.updateSession(session.sessionId, {
      expectedRevision: session.revision,
      meeting,
    });
    if (saved.ok) return success;
    return err(
      saved.error === 'revision_conflict'
        ? 'conflict'
        : saved.error === 'storage_unavailable'
          ? 'storage_unavailable'
          : saved.error === 'not_found'
            ? 'not_found'
            : 'invalid',
      saved.message,
    );
  }

  private nextRebuttal(meeting: MeetingState) {
    const last = meeting.rounds.at(-1);
    if (!last || last.kind === 'secretary') return null;
    const rebuttalNo = last.kind === 'rebuttal' ? (last.rebuttalNo ?? MAX_REBUTTALS) + 1 : 1;
    return rebuttalNo > MAX_REBUTTALS ? null : { basedOnRoundId: last.roundId, rebuttalNo };
  }

  private async active(meeting: MeetingState) {
    const last = meeting.rounds.at(-1);
    return last ? (await this.roundView(last)).active : false;
  }

  private async answerView(round: MeetingRound, answer: MeetingAnswer): Promise<MeetingAnswerView> {
    const base: Pick<MeetingAnswerView, 'participantId' | 'runId' | 'detail' | 'usage'> = {
      participantId: answer.participantId,
      runId: answer.runId,
      detail: answer.detail,
      usage: null,
    };
    if (answer.state !== 'started' || !answer.runId)
      return {
        ...base,
        status: answer.state === 'refused' ? 'refused' : 'not_started',
        text: null,
      };
    let projection: Awaited<ReturnType<RuntimeTransport['getSnapshot']>>['projection'];
    try {
      ({ projection } = await this.deps.transport.getSnapshot(answer.runId));
    } catch {
      // A failed read is not evidence that the Run stopped; keep the next round waiting.
      return {
        ...base,
        status: 'running',
        detail: 'The answer status is temporarily unavailable.',
        text: null,
      };
    }
    const { budget } = projection;
    base.usage = {
      modelCalls: budget.modelCalls,
      outputTokens: budget.spent,
      unknown: budget.unknownOutstanding > 0,
    };
    if (!TERMINAL_RUN_STATUSES.has(projection.status))
      return { ...base, status: 'running', text: null };
    if (projection.status === 'succeeded') {
      const texts = await Promise.all(
        (projection.output?.artifactVersionIds ?? []).map((id) =>
          this.deps.transport.getArtifactText(answer.runId!, id),
        ),
      );
      return {
        ...base,
        status: 'answered',
        text: texts.filter((text): text is string => text !== null).join('\n\n'),
      };
    }
    return {
      ...base,
      status:
        projection.status === 'interrupted'
          ? 'interrupted'
          : projection.status === 'cancelled' || round.stoppedAt
            ? 'stopped'
            : 'failed',
      text: null,
      detail: answer.detail ?? projection.statusReason ?? null,
    };
  }

  private async roundView(round: MeetingRound): Promise<RoundView> {
    const answers = await Promise.all(
      round.answers.map((answer) => this.answerView(round, answer)),
    );
    return { ...round, answers, active: answers.some((answer) => answer.status === 'running') };
  }

  /** What every answer of a new round reads: the meeting up to, not including, this round. */
  private async brief(meeting: MeetingState, round: Omit<MeetingRound, 'answers'>) {
    const { config } = meeting;
    const lines = [
      'Participants:',
      ...config.participants.map((p) => `- ${p.name}: ${p.prompt}`),
      '',
      'Meeting so far:',
    ];
    if (!meeting.rounds.length) lines.push('(nothing yet)');
    for (const [index, past] of meeting.rounds.entries()) {
      const view = await this.roundView(past);
      lines.push(
        '',
        past.message === null
          ? `Round ${index + 1} [roundId=${past.roundId}] — rebuttal round ${past.rebuttalNo}`
          : `Round ${index + 1} [roundId=${past.roundId}] — Person: ${past.message}`,
        formatMeetingEvidence(past.attachments),
      );
      for (const answer of view.answers)
        lines.push(
          `${nameOf(config, answer.participantId)} [participantId=${answer.participantId}]: ${
            answer.status === 'answered' ? answer.text : `(no answer: ${answer.status})`
          }`,
        );
    }
    lines.push(
      '',
      round.message === null
        ? `This round: rebuttal round ${round.rebuttalNo}. Read the answers of the round just before and respond to them by name: what you agree with, what you dispute and why, and what was missed.`
        : `This round — Person: ${round.message}`,
      formatMeetingEvidence(round.attachments),
    );
    return lines.join('\n');
  }

  private async start(
    session: WorkSession,
    spec: Omit<MeetingRound, 'roundId' | 'answers' | 'createdAt' | 'stoppedAt'> & {
      mode: 'mock' | 'live';
    },
    consumeQueue = false,
  ): Promise<MeetingResult> {
    const meeting = session.meeting!;
    const { mode } = spec;
    const round: MeetingRound = {
      ...spec,
      roundId: this.deps.newRoundId(),
      createdAt: this.deps.clock.nowIso(),
      stoppedAt: null,
      answers: spec.participantIds.map((participantId) => ({
        participantId,
        runId: null,
        state: 'not_started',
        detail: null,
      })),
    };
    const brief = await this.brief(meeting, round);
    const recorded = await this.save(
      session,
      { ...meeting, rounds: [...meeting.rounds, round], ...(consumeQueue ? { queued: null } : {}) },
      { ok: true, outcome: 'started', roundId: round.roundId },
    );
    if (!recorded.ok) return recorded;
    // Every answer starts from the same record, so no answer can see another of this round.
    const answers = await Promise.all(
      round.answers.map(async (answer): Promise<MeetingAnswer> => {
        try {
          const result = await this.deps.transport.startRun({
            schemaVersion: '0.1',
            commandId: `meeting_${round.roundId}_${answer.participantId}`,
            definition: meetingAnswerDefinition(
              meeting.config,
              answer.participantId,
              round.roundId,
              brief,
            ),
            mode,
            sessionId: session.sessionId,
            meeting: {
              sessionId: session.sessionId,
              roundId: round.roundId,
              participantId: answer.participantId,
            },
          });
          return result.runId
            ? { ...answer, runId: result.runId, state: 'started' }
            : {
                ...answer,
                state: 'refused',
                detail: result.receipt.error?.message ?? 'The runtime refused this answer.',
              };
        } catch (error) {
          return { ...answer, state: 'refused', detail: String(error) };
        }
      }),
    );
    const saved = await this.recordAnswers(session.sessionId, round.roundId, answers);
    if (!saved.ok) {
      await this.cancelAnswers(round.roundId, answers);
      return saved;
    }
    this.watch(session.sessionId, round);
    return recorded;
  }

  private async recordAnswers(
    sessionId: string,
    roundId: string,
    answers: MeetingAnswer[],
  ): Promise<MeetingResult> {
    // Another writer (a title change) may have moved the revision; re-read and retry.
    for (let attempt = 0; attempt < 5; attempt++) {
      const session = await this.deps.repository.getSession(sessionId);
      if (!session?.meeting) return err('not_found', 'The meeting no longer exists.');
      const saved = await this.save(
        session,
        {
          ...session.meeting,
          rounds: session.meeting.rounds.map((round) =>
            round.roundId === roundId ? { ...round, answers } : round,
          ),
        },
        { ok: true, outcome: 'updated', roundId },
      );
      if (saved.ok || saved.error !== 'conflict') return saved;
    }
    return err('conflict', 'The answer runs could not be recorded.');
  }

  private async cancelAnswers(roundId: string, answers: MeetingAnswer[]) {
    await Promise.all(
      answers.flatMap((answer) =>
        answer.runId
          ? [
              this.deps.transport
                .sendCommand({
                  schemaVersion: '0.1',
                  runId: answer.runId,
                  commandId: `meeting_stop_${roundId}_${answer.participantId}`,
                  type: 'cancel',
                  payload: { scope: { kind: 'run' }, reason: 'meeting_round_stopped' },
                })
                .catch(() => null),
            ]
          : [],
      ),
    );
  }

  private watch(sessionId: string, round: MeetingRound) {
    const runs = (async () => {
      const session = await this.deps.repository.getSession(sessionId);
      const recorded = session?.meeting?.rounds.find((item) => item.roundId === round.roundId);
      await Promise.allSettled(
        (recorded?.answers ?? []).flatMap((answer) =>
          answer.runId
            ? [
                waitForProjection(this.deps.transport, answer.runId, (p) =>
                  TERMINAL_RUN_STATUSES.has(p.status),
                ),
              ]
            : [],
        ),
      );
      if (round.kind === 'secretary')
        await recordMeetingMinutes(this.deps, sessionId, round.roundId);
      await this.locked(sessionId, () => this.startQueued(sessionId));
    })();
    const set = this.watchers.get(sessionId) ?? new Set<Promise<void>>();
    this.watchers.set(sessionId, set);
    const tracked = runs.finally(() => {
      set.delete(tracked);
      if (!set.size) this.watchers.delete(sessionId);
    });
    set.add(tracked);
  }

  private async startQueued(sessionId: string): Promise<MeetingResult> {
    const session = await this.deps.repository.getSession(sessionId);
    if (!session?.meeting) return err('not_found', `Meeting ${sessionId} does not exist.`);
    const queued = session.meeting.queued;
    if (!queued) return { ok: true, outcome: 'updated' };
    if (await this.active(session.meeting)) return err('busy', 'A round is still running.');
    const mentions = queued.mentions;
    return this.start(
      session,
      {
        commandId: queued.commandId,
        mode: queued.mode,
        ...(queued.attachments ? { attachments: queued.attachments } : {}),
        kind: mentions.includes(SECRETARY_ID) ? 'secretary' : mentions.length ? 'mention' : 'all',
        message: queued.text,
        participantIds: mentions.length
          ? [
              ...session.meeting.config.participants
                .map((p) => p.participantId)
                .filter((id) => mentions.includes(id)),
              ...(mentions.includes(SECRETARY_ID) ? [SECRETARY_ID] : []),
            ]
          : session.meeting.config.participants.map((p) => p.participantId),
        basedOnRoundId: null,
        rebuttalNo: null,
      },
      true,
    );
  }
}
