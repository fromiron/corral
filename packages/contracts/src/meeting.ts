import { z } from 'zod';
import { TextAttachments } from './attachments.ts';
import { Identifier } from './ids.ts';

// CR-049: a meeting is a work session with role agents. Only a person's message opens a round;
// each answer is its own read-only Run. The state is changed only by the meeting service.

/** The participant ID that addresses the secretary in mentions and answers. */
export const SECRETARY_ID = 'secretary';

export const MeetingParticipant = z.strictObject({
  participantId: Identifier,
  name: z.string().trim().min(1).max(40),
  /** The role: what this agent looks at and argues for. */
  prompt: z.string().trim().min(1).max(4000),
  modelProfile: Identifier,
});
export type MeetingParticipant = z.infer<typeof MeetingParticipant>;

export const MeetingConfig = z
  .strictObject({
    version: z.literal(1),
    participants: z.array(MeetingParticipant).min(2).max(6),
    secretary: z.strictObject({
      modelProfile: Identifier,
      prompt: z.string().trim().min(1).max(4000).optional(),
    }),
  })
  .refine(
    ({ participants }) =>
      new Set(participants.map((p) => p.participantId.toLowerCase())).size ===
        participants.length &&
      new Set(participants.map((p) => p.name.toLowerCase())).size === participants.length &&
      participants.every(
        (p) =>
          ![SECRETARY_ID, '비서'].includes(p.participantId.toLowerCase()) &&
          ![SECRETARY_ID, '비서'].includes(p.name.toLowerCase()) &&
          !participants.some(
            (other) => other !== p && other.participantId.toLowerCase() === p.name.toLowerCase(),
          ),
      ),
    'Participants need distinct IDs and names, and none may be the secretary',
  );
export type MeetingConfig = z.infer<typeof MeetingConfig>;

/** What was recorded when a round asked one participant; its progress is the Run's. */
export const MeetingAnswer = z.strictObject({
  participantId: Identifier,
  runId: Identifier.nullable(),
  /** started: the Run exists; refused: the runtime said no; not_started: never dispatched. */
  state: z.enum(['started', 'refused', 'not_started']),
  detail: z.string().max(2000).nullable(),
});
export type MeetingAnswer = z.infer<typeof MeetingAnswer>;

export const MeetingRound = z.strictObject({
  roundId: Identifier,
  commandId: Identifier,
  mode: z.enum(['mock', 'live']).optional(),
  attachments: TextAttachments.optional(),
  /** all: no mention; mention: only the mentioned; rebuttal: answers the round before; secretary. */
  kind: z.enum(['all', 'mention', 'rebuttal', 'secretary']),
  /** The person's message; null for a rebuttal round, which has none. */
  message: z.string().min(1).max(20000).nullable(),
  /** For a rebuttal: the round whose answers it responds to, and which rebuttal it is (1–2). */
  basedOnRoundId: Identifier.nullable(),
  rebuttalNo: z.int().min(1).max(2).nullable(),
  participantIds: z.array(Identifier).min(1).max(6),
  answers: z.array(MeetingAnswer).max(6),
  createdAt: z.string(),
  stoppedAt: z.string().nullable(),
});
export type MeetingRound = z.infer<typeof MeetingRound>;

export const QueuedMeetingMessage = z.strictObject({
  commandId: Identifier,
  mode: z.enum(['mock', 'live']),
  text: z.string().min(1).max(20000),
  attachments: TextAttachments.optional(),
  mentions: z.array(Identifier).max(7),
});
export type QueuedMeetingMessage = z.infer<typeof QueuedMeetingMessage>;

/** Secretary statements cite an actual answer, so failure and silence cannot become agreement. */
export const MeetingAnswerReference = z.strictObject({
  roundId: Identifier,
  participantId: Identifier,
});
export type MeetingAnswerReference = z.infer<typeof MeetingAnswerReference>;

const DecisionLines = z.array(z.string().trim().min(1).max(4000)).max(100);
export const MeetingDecisionContent = z.strictObject({
  goal: z.string().trim().min(1).max(4000),
  scope: DecisionLines,
  excludedScope: DecisionLines,
  acceptanceCriteria: DecisionLines,
  remainingDissent: DecisionLines,
  evidence: DecisionLines,
  risks: DecisionLines,
  actions: DecisionLines,
  rejectedAlternatives: DecisionLines,
});
export type MeetingDecisionContent = z.infer<typeof MeetingDecisionContent>;

export const MeetingMinutesDocument = z.strictObject({
  issues: DecisionLines,
  claims: z
    .array(MeetingAnswerReference.extend({ text: z.string().trim().min(1).max(4000) }))
    .max(200),
  agreements: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(4000),
        supporters: z.array(MeetingAnswerReference).min(1).max(200),
      }),
    )
    .max(100),
  remainingDissent: z
    .array(MeetingAnswerReference.extend({ text: z.string().trim().min(1).max(4000) }))
    .max(200),
  unverifiedFacts: DecisionLines,
  candidates: z
    .array(z.strictObject({ candidateId: Identifier, content: MeetingDecisionContent }))
    .max(30)
    .refine(
      (items) => new Set(items.map((item) => item.candidateId)).size === items.length,
      'Decision candidates need distinct IDs',
    ),
});
export type MeetingMinutesDocument = z.infer<typeof MeetingMinutesDocument>;

export const MeetingMinutes = z.strictObject({
  minutesId: Identifier,
  roundId: Identifier,
  createdAt: z.string(),
  document: MeetingMinutesDocument.nullable(),
  error: z.string().max(2000).nullable(),
});
export type MeetingMinutes = z.infer<typeof MeetingMinutes>;

export const MeetingDecisionVersion = z.strictObject({
  versionId: Identifier,
  commandId: Identifier,
  minutesId: Identifier,
  candidateId: Identifier,
  supersedesVersionId: Identifier.nullable(),
  content: MeetingDecisionContent,
  createdAt: z.string(),
});
export type MeetingDecisionVersion = z.infer<typeof MeetingDecisionVersion>;

export const MeetingDecisionWithdrawal = z.strictObject({
  commandId: Identifier,
  versionId: Identifier,
  reason: z.string().trim().min(1).max(4000),
  createdAt: z.string(),
});
export type MeetingDecisionWithdrawal = z.infer<typeof MeetingDecisionWithdrawal>;

export const MeetingAdoptDecisionRequest = z.strictObject({
  commandId: Identifier,
  minutesId: Identifier,
  candidateId: Identifier,
  content: MeetingDecisionContent,
  supersedesVersionId: Identifier.optional(),
});
export type MeetingAdoptDecisionRequest = z.infer<typeof MeetingAdoptDecisionRequest>;

export const MeetingWithdrawDecisionRequest = MeetingDecisionWithdrawal.omit({ createdAt: true });
export type MeetingWithdrawDecisionRequest = z.infer<typeof MeetingWithdrawDecisionRequest>;

export const MeetingState = z.strictObject({
  config: MeetingConfig,
  rounds: z.array(MeetingRound),
  /** At most one message waits while a round runs (CR-049 rule 2). */
  queued: QueuedMeetingMessage.nullable(),
  minutes: z.array(MeetingMinutes).optional(),
  decisions: z.array(MeetingDecisionVersion).optional(),
  decisionWithdrawals: z.array(MeetingDecisionWithdrawal).optional(),
});
export type MeetingState = z.infer<typeof MeetingState>;

/** Marks a Run as one meeting answer; only the meeting service sets it (CR-049 C-174). */
export const MeetingRunOrigin = z.strictObject({
  sessionId: Identifier,
  roundId: Identifier,
  participantId: Identifier,
});
export type MeetingRunOrigin = z.infer<typeof MeetingRunOrigin>;

/** A person's message, or a rebuttal round they opened. */
export const MeetingRoundRequest = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('message'),
    commandId: Identifier,
    mode: z.enum(['mock', 'live']),
    text: z.string().trim().min(1).max(20000),
    attachments: TextAttachments.optional(),
    /** Participant IDs or the secretary chosen in the composer, besides `@name` in the text. */
    mentions: z.array(Identifier).max(7).optional(),
  }),
  z.strictObject({
    kind: z.literal('rebuttal'),
    commandId: Identifier,
    mode: z.enum(['mock', 'live']),
    mentions: z.array(Identifier).max(6).optional(),
  }),
]);
export type MeetingRoundRequest = z.infer<typeof MeetingRoundRequest>;

/** One answer as the meeting shows it: the Run's state and, once finished, its text. */
export const MeetingAnswerView = z.strictObject({
  participantId: Identifier,
  runId: Identifier.nullable(),
  status: z.enum([
    'not_started',
    'refused',
    'running',
    'answered',
    'failed',
    'stopped',
    'interrupted',
  ]),
  text: z.string().nullable(),
  detail: z.string().nullable(),
  /** The answer's Run usage; `unknown` when some of it was never reported (never counted as 0). */
  usage: z
    .strictObject({
      modelCalls: z.int().min(0),
      outputTokens: z.int().min(0),
      unknown: z.boolean(),
    })
    .nullable(),
});
export type MeetingAnswerView = z.infer<typeof MeetingAnswerView>;

export const MeetingView = z.strictObject({
  sessionId: Identifier,
  revision: z.int().min(1),
  config: MeetingConfig,
  rounds: z.array(
    MeetingRound.omit({ answers: true }).extend({
      active: z.boolean(),
      answers: z.array(MeetingAnswerView),
    }),
  ),
  queued: QueuedMeetingMessage.nullable(),
  minutes: z.array(MeetingMinutes).optional(),
  decisions: z.array(MeetingDecisionVersion).optional(),
  decisionWithdrawals: z.array(MeetingDecisionWithdrawal).optional(),
  /** What the next rebuttal round would answer, or null when one cannot be opened now. */
  rebuttal: z
    .strictObject({ basedOnRoundId: Identifier, rebuttalNo: z.int().min(1).max(2) })
    .nullable(),
});
export type MeetingView = z.infer<typeof MeetingView>;
