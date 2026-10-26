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
  type MeetingRunOrigin,
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

// Chat messages ask for read-only replies through the Coordinator. Persisted
// batch IDs remain stable for cancellation, replay and references from existing minutes.

export interface MeetingServiceDeps {
  repository: Pick<CorralRepository, 'createSession' | 'getSession' | 'updateSession'>;
  transport: RuntimeTransport;
  clock: Clock;
  newRoundId(): string;
  random(): number;
  continuation?(
    runId: string,
    sessionId: string,
    participantId: string,
    definition: CorralDefinition,
    mode: 'mock' | 'live',
  ): MeetingRunOrigin['contextSource'] | null;
}

export type MeetingResult =
  | { ok: true; outcome: 'started' | 'queued' | 'updated'; roundId?: string }
  | {
      ok: false;
      error: 'not_found' | 'invalid' | 'busy' | 'conflict' | 'storage_unavailable';
      message: string;
    };

const SECRETARY_NAMES = new Set([SECRETARY_ID, '비서']);
const PARTICIPANT_RULES =
  'You are a participant in a group chat with a person and other AI models. Respond naturally to the latest message in its language, using the conversation so far. For a simple everyday question, offer your own answer briefly, usually in one to three sentences, and leave room for follow-up. Follow-up questions such as "why?" refer to the earlier conversation; explain or revise your opinion as the person adds preferences. Read the messages already posted before yours and respond to them where relevant instead of repeating the same answer. Speak only for yourself. Do not predict or invent another participant’s future words, intentions, reactions or personality; refer to what they have actually said. Role guidance below is optional and applies only when relevant to the current topic: an everyday question does not become a software task or a risk audit. Use detailed analysis, checklists or implementation plans only when the person requests them or the topic calls for that detail. Ask a short clarifying question when needed instead of forcing a finished proposal. You cannot change project files or execute commands. When addressing another participant, use @ followed by their exact display name and a space or punctuation. An explicit @mention asks that participant to reply next, even if they already spoke. Use mentions only when you want a response, not for every reference or courtesy acknowledgement; do not echo a tag automatically. Do not mention yourself. Only the person can request secretary minutes. Conversation does not adopt a decision or start implementation.';
const SECRETARY_RULES =
  'You are the meeting secretary, called explicitly by the person to organise the conversation. Do not give opinions of your own. Summarise what was actually discussed, the participants’ views, emerging conclusions, unresolved disagreements and unverified facts. When the person asks for a development plan, turn the supported conclusions into proposed implementation steps, scope and completion criteria. Do not force a software plan onto an everyday conversation or invent a conclusion while the discussion is still open; decision candidates may be empty. Never count silence or a failed answer as agreement. Plans remain proposals for the person to review and adopt before handing them to an implementation session. Answer in the language of the person’s latest message.';

const err = (error: Extract<MeetingResult, { ok: false }>['error'], message: string) =>
  ({ ok: false, error, message }) as const;

/** Mentions written as `@name` (a participant's name or ID, or the secretary). */
function mentionsIn(text: string, config: MeetingConfig, strict = true): string[] | null {
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
        (!rest[name.length] || /[\s,.;:!?()[\]{}*]/u.test(rest[name.length]!)),
    );
    if (!participant) {
      if (strict) return null;
      continue;
    }
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
  first.length === second.length && first.every((id) => second.includes(id));

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
    ? `Your display name: ${name}${participant.prompt ? `\nBackground role guidance (only for related topics): ${participant.prompt}` : ''}\n\n${PARTICIPANT_RULES}\n\nFor a message unrelated to that role, ignore the role guidance for this reply and answer normally. Do not announce your role, invent an evaluation framework, or report who has not spoken unless the person asks.`
    : `${SECRETARY_RULES}${config.secretary.prompt ? `\n\n${config.secretary.prompt}` : ''}\n\n${SECRETARY_MINUTES_INSTRUCTIONS}`;
  return {
    schemaVersion: '0.1',
    id: `meeting_${roundId}`,
    name: `Meeting · ${name}`,
    entryNodeId: 'answer',
    input: { brief, criteria: [`Reply as ${name} to the latest message using the conversation.`] },
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
type Speaker = { round: MeetingRound; answer: MeetingAnswer };

// Legacy records keep their original grouped order; new messages and replies share one timeline.
const roundOrder = (round: MeetingRound, index: number) => round.order ?? index * 7;
const answerOrder = (round: MeetingRound, index: number, answer: MeetingAnswer, n: number) =>
  answer.order ?? roundOrder(round, index) + n + 1;
function nextOrder(meeting: MeetingState) {
  return (
    1 +
    Math.max(
      -1,
      ...meeting.rounds.flatMap((round, index) => [
        roundOrder(round, index),
        ...round.answers
          .filter((answer) => answer.state !== 'queued')
          .map((answer, n) => answerOrder(round, index, answer, n)),
      ]),
    )
  );
}

export class MeetingService {
  private readonly deps: MeetingServiceDeps;
  /** One mutation at a time per meeting; storage CAS still guards other writers. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** One serial conversation driver per session; reading history never creates one. */
  private readonly watchers = new Map<string, Promise<void>>();
  private readonly answering = new Set<string>();

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

  /** Reads the record and each answer's Run; never starts anything. */
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
    const rounds = await Promise.all(
      session.meeting.rounds.map((round) => this.roundView(sessionId, round)),
    );
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
      const request = parsed.data;
      if (request.kind === 'message' && !validTextAttachments(request.attachments ?? []))
        return err('invalid', 'The selected evidence content does not match its recorded digest.');
      const session = await this.deps.repository.getSession(sessionId);
      if (!session?.meeting) return err('not_found', `Meeting ${sessionId} does not exist.`);
      const meeting = session.meeting;
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
      if (meeting.queued || (await this.active(session)))
        return err('busy', 'Replies are in progress or a message is waiting.');
      const next = this.nextRebuttal(meeting);
      if (!next) return err('invalid', 'There are no participant messages to respond to.');
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

  /** Stops every answer of a round; what already arrived stays. */
  stop(sessionId: string, roundId: string): Promise<MeetingResult> {
    return this.locked(sessionId, async () => {
      const session = await this.deps.repository.getSession(sessionId);
      const round = session?.meeting?.rounds.find((item) => item.roundId === roundId);
      if (!session?.meeting || !round) return err('not_found', 'The round does not exist.');
      if (round.stoppedAt) return { ok: true, outcome: 'updated', roundId };
      const current = (await this.roundView(sessionId, round)).active;
      const active: MeetingRound[] = [];
      for (const item of session.meeting.rounds) {
        if (item.roundId === roundId || (current && (await this.roundView(sessionId, item)).active))
          active.push(item);
      }
      const saved = await this.save(
        session,
        {
          ...session.meeting,
          rounds: session.meeting.rounds.map((item) =>
            active.includes(item) ? { ...item, stoppedAt: this.deps.clock.nowIso() } : item,
          ),
        },
        { ok: true, outcome: 'updated', roundId },
      );
      if (!saved.ok) return saved;
      for (const item of active) await this.cancelAnswers(item.roundId, item.answers);
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
    while (this.watchers.has(sessionId)) await this.watchers.get(sessionId);
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
    const rebuttalNo = last.kind === 'rebuttal' ? (last.rebuttalNo ?? 0) + 1 : 1;
    return { basedOnRoundId: last.roundId, rebuttalNo };
  }

  private async active(session: WorkSession) {
    for (const round of session.meeting?.rounds ?? []) {
      if ((await this.roundView(session.sessionId, round)).active) return true;
    }
    return false;
  }

  private async answerView(
    sessionId: string,
    round: MeetingRound,
    answer: MeetingAnswer,
  ): Promise<MeetingAnswerView> {
    const base: Pick<MeetingAnswerView, 'participantId' | 'runId' | 'order' | 'detail' | 'usage'> =
      {
        participantId: answer.participantId,
        runId: answer.runId,
        ...(answer.order === undefined ? {} : { order: answer.order }),
        detail: answer.detail,
        usage: null,
      };
    if (answer.state !== 'started' || !answer.runId)
      return {
        ...base,
        status:
          answer.state === 'queued'
            ? round.stoppedAt
              ? 'stopped'
              : this.answering.has(`${sessionId}/${round.roundId}`)
                ? 'waiting'
                : 'not_started'
            : answer.state === 'refused'
              ? 'refused'
              : 'not_started',
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

  private async roundView(sessionId: string, round: MeetingRound): Promise<RoundView> {
    const answers = await Promise.all(
      round.answers.map((answer) => this.answerView(sessionId, round, answer)),
    );
    return {
      ...round,
      answers,
      active: answers.some((answer) => answer.status === 'running' || answer.status === 'waiting'),
    };
  }

  /** Builds each speaker's input immediately before starting it, from posted messages only. */
  private async brief(session: WorkSession, round: MeetingRound) {
    const meeting = session.meeting!;
    const { config } = meeting;
    const lines = ['Participants:', ...config.participants.map((p) => `- ${p.name}`), ''];
    const messages: { order: number; text: string; runId?: string }[] = [];
    for (const [index, past] of meeting.rounds.entries()) {
      if (past.message !== null)
        messages.push({
          order: roundOrder(past, index),
          text: `Message ${index + 1} [roundId=${past.roundId}] — Person: ${past.message}\n${formatMeetingEvidence(past.attachments)}`,
        });
      const view = await this.roundView(session.sessionId, past);
      for (const [n, answer] of view.answers.entries()) {
        if (answer.status === 'waiting' || answer.status === 'running' || !answer.runId) continue;
        messages.push({
          order: answerOrder(past, index, past.answers[n]!, n),
          runId: answer.runId,
          text: `[roundId=${past.roundId}] ${nameOf(config, answer.participantId)} [participantId=${answer.participantId}]: ${answer.status === 'answered' ? answer.text : `(no answer: ${answer.status})`}`,
        });
      }
    }
    messages.sort((a, b) => a.order - b.order);
    const tail: string[] = [];
    if (round.replyTo)
      tail.push(
        `You were mentioned by ${nameOf(config, round.replyTo.participantId)}. Reply to their posted message using the conversation above.`,
      );
    tail.push(
      '',
      round.message === null
        ? 'Latest request: respond to the other participants’ preceding messages, explaining your view naturally.'
        : 'It is your turn to reply as yourself. Continue from the most recent posted messages above. React or add a new point instead of repeating a suggestion or question that was just posted.',
    );
    return {
      throughOrder: Math.max(0, ...messages.map((message) => message.order)),
      render: (afterOrder = -1, previousRunId?: string) =>
        [
          ...lines,
          // a continuation's earlier messages are already in its own context.
          previousRunId ? 'Messages posted since your last reply:' : 'Conversation so far:',
          ...messages
            .filter(
              (message) =>
                message.order > afterOrder && (!previousRunId || message.runId !== previousRunId),
            )
            .map((message) => message.text),
          ...tail,
        ].join('\n'),
    };
  }

  private async start(
    session: WorkSession,
    spec: Omit<MeetingRound, 'roundId' | 'answers' | 'createdAt' | 'stoppedAt'> & {
      mode: 'mock' | 'live';
    },
    consumeQueue = false,
  ): Promise<MeetingResult> {
    const meeting = session.meeting!;
    const participantIds = [...spec.participantIds];
    for (let i = participantIds.length - 1; i > 0; i--) {
      const j = Math.floor(this.deps.random() * (i + 1));
      [participantIds[i], participantIds[j]] = [participantIds[j]!, participantIds[i]!];
    }
    const round: MeetingRound = {
      ...spec,
      participantIds,
      roundId: this.deps.newRoundId(),
      createdAt: this.deps.clock.nowIso(),
      stoppedAt: null,
      order: nextOrder(meeting),
      answers: participantIds.map((participantId) => ({
        participantId,
        runId: null,
        state: 'queued',
        detail: null,
      })),
    };
    const recorded = await this.save(
      session,
      {
        ...meeting,
        rounds: [
          ...meeting.rounds.map((past) => ({
            ...past,
            // New human input supersedes unstarted replies; a tag moves its recipients next.
            answers: past.answers.filter(
              (answer) => answer.state !== 'queued' || Boolean(spec.replyTo),
            ),
          })),
          round,
        ],
        ...(consumeQueue ? { queued: null } : {}),
      },
      { ok: true, outcome: 'started', roundId: round.roundId },
    );
    if (!recorded.ok) return recorded;
    this.answering.add(`${session.sessionId}/${round.roundId}`);
    if (this.watchers.has(session.sessionId)) return recorded;
    const first = await this.startNext(session.sessionId).catch(() =>
      err('storage_unavailable', 'The conversation could not be prepared.'),
    );
    if (!first.ok) {
      this.answering.delete(`${session.sessionId}/${round.roundId}`);
      return first;
    }
    this.watch(session.sessionId, first.speaker);
    return recorded;
  }

  /** Called under the meeting lock; waits for dispatch/recording, never for model completion. */
  private async startNext(
    sessionId: string,
  ): Promise<{ ok: true; speaker: Speaker | null } | Extract<MeetingResult, { ok: false }>> {
    const session = await this.deps.repository.getSession(sessionId);
    if (!session?.meeting) return { ok: true, speaker: null };
    // A newly posted message may follow a Run still owned by an earlier process.
    for (const past of session.meeting.rounds) {
      for (const answer of past.answers) {
        if (answer.state === 'started' && !answer.followed)
          return { ok: true, speaker: { round: past, answer } };
      }
    }
    const round = [...session.meeting.rounds]
      .reverse()
      .find(
        (item) =>
          !item.stoppedAt &&
          this.answering.has(`${sessionId}/${item.roundId}`) &&
          item.answers.some((answer) => answer.state === 'queued'),
      );
    if (!round) return { ok: true, speaker: null };
    const roundId = round.roundId;
    const pending = round.answers.filter((answer) => answer.state === 'queued');
    if (!round.mode) return err('invalid', 'The reply has no saved execution mode.');
    // All independent replies see the same posted-message snapshot, even if an earlier model finishes quickly.
    const brief = await this.brief(session, round);
    const batch = round.replyTo ? pending.slice(0, 1) : pending;
    const started: MeetingAnswer[] = [];
    for (const [index, next] of batch.entries()) {
      let answer: MeetingAnswer;
      try {
        const definition = meetingAnswerDefinition(
          session.meeting.config,
          next.participantId,
          roundId,
          brief.render(),
        );
        let contextSource: MeetingRunOrigin['contextSource'];
        if (this.deps.continuation) {
          const previous = session.meeting.rounds
            .flatMap((item) => item.answers)
            .filter(
              (item) =>
                item.participantId === next.participantId &&
                item.runId &&
                item.contextOrder !== undefined,
            )
            .reverse();
          for (const candidate of previous) {
            const source = this.deps.continuation(
              candidate.runId!,
              sessionId,
              next.participantId,
              definition,
              round.mode,
            );
            if (!source) continue;
            contextSource = source;
            definition.input.brief = brief.render(candidate.contextOrder, candidate.runId!);
            break;
          }
        }
        const result = await this.deps.transport.startRun({
          schemaVersion: '0.1',
          commandId: `meeting_${roundId}_${next.participantId}`,
          definition,
          mode: round.mode,
          sessionId,
          meeting: {
            sessionId,
            roundId,
            participantId: next.participantId,
            ...(contextSource ? { contextSource } : {}),
          },
        });
        answer = result.runId
          ? { ...next, runId: result.runId, state: 'started' }
          : {
              ...next,
              state: 'refused',
              detail: result.receipt.error?.message ?? 'The runtime refused this answer.',
            };
      } catch {
        await this.cancelAnswers(roundId, started);
        return err('storage_unavailable', 'The reply start could not be confirmed.');
      }
      answer = {
        ...answer,
        order: nextOrder(session.meeting) + index,
        contextOrder: brief.throughOrder,
      };
      started.push(answer);
      const saved = await this.recordAnswer(sessionId, roundId, answer);
      if (!saved.ok) {
        await this.cancelAnswers(roundId, started);
        return saved;
      }
    }
    return { ok: true, speaker: started[0] ? { round, answer: started[0] } : null };
  }

  private async recordAnswer(
    sessionId: string,
    roundId: string,
    answer: MeetingAnswer,
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
            round.roundId === roundId
              ? {
                  ...round,
                  answers: round.answers.map((current) =>
                    current.participantId === answer.participantId ? answer : current,
                  ),
                }
              : round,
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

  /** Only a completed participant message can request another chat reply. */
  private async followMentions(sessionId: string, speaker: Speaker): Promise<MeetingResult> {
    const session = await this.deps.repository.getSession(sessionId);
    if (!session?.meeting) return err('not_found', 'The meeting no longer exists.');
    const { meeting } = session;
    const index = meeting.rounds.findIndex((item) => item.roundId === speaker.round.roundId);
    const source = meeting.rounds[index];
    if (
      !source ||
      source.stoppedAt ||
      !source.mode ||
      source.kind === 'secretary' ||
      meeting.rounds.slice(index + 1).some((item) => item.message !== null) ||
      meeting.rounds.some(
        (item) =>
          item.replyTo?.roundId === source.roundId &&
          item.replyTo.participantId === speaker.answer.participantId,
      )
    )
      return { ok: true, outcome: 'updated' };
    const answer = await this.answerView(sessionId, source, speaker.answer);
    if (answer.status !== 'answered' || !answer.text) return { ok: true, outcome: 'updated' };
    const text = answer.text.replace(/```[\s\S]*?```|`[^`]*`|^\s*>.*$/gmu, '');
    const participantIds = (mentionsIn(text, meeting.config, false) ?? []).filter(
      (id) => id !== speaker.answer.participantId && id !== SECRETARY_ID,
    );
    if (!participantIds.length) return { ok: true, outcome: 'updated' };
    return this.start(session, {
      commandId: this.deps.newRoundId(),
      mode: source.mode,
      kind: 'mention',
      message: null,
      participantIds,
      basedOnRoundId: source.roundId,
      rebuttalNo: null,
      replyTo: { roundId: source.roundId, participantId: speaker.answer.participantId },
    });
  }

  private watch(sessionId: string, first: Speaker | null) {
    const retire = () => {
      this.watchers.delete(sessionId);
      for (const key of this.answering)
        if (key.startsWith(`${sessionId}/`)) this.answering.delete(key);
    };
    const runs = (async () => {
      let speaker = first;
      for (;;) {
        if (speaker?.answer.runId)
          await waitForProjection(this.deps.transport, speaker.answer.runId, (p) =>
            TERMINAL_RUN_STATUSES.has(p.status),
          );
        if (speaker?.round.kind === 'secretary')
          await recordMeetingMinutes(this.deps, sessionId, speaker.round.roundId);
        const completed = speaker;
        const next = await this.locked(sessionId, async () => {
          if (completed) {
            const mentioned = await this.followMentions(sessionId, completed);
            if (!mentioned.ok) return mentioned;
            const recorded = await this.recordAnswer(sessionId, completed.round.roundId, {
              ...completed.answer,
              followed: true,
            });
            if (!recorded.ok) return recorded;
          }
          const pending = await this.startNext(sessionId);
          if (pending.ok && !pending.speaker) {
            // Retire under the same lock as send, so a new message cannot lose its driver.
            retire();
            await this.startQueued(sessionId);
          }
          return pending;
        });
        if (!next.ok || !next.speaker) return;
        speaker = next.speaker;
      }
    })();
    // A lost observation cannot authorize the next speaker; a later view never restarts it.
    const tracked = runs
      .catch(() => {})
      .finally(() =>
        this.locked(sessionId, async () => {
          if (this.watchers.get(sessionId) === tracked) retire();
        }),
      );
    this.watchers.set(sessionId, tracked);
  }

  private async startQueued(sessionId: string): Promise<MeetingResult> {
    const session = await this.deps.repository.getSession(sessionId);
    if (!session?.meeting) return err('not_found', `Meeting ${sessionId} does not exist.`);
    const queued = session.meeting.queued;
    if (!queued) return { ok: true, outcome: 'updated' };
    if (await this.active(session)) return err('busy', 'A round is still running.');
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
