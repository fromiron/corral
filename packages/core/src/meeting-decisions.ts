import {
  type Clock,
  canonicalJson,
  MeetingAdoptDecisionRequest,
  type MeetingAnswerReference,
  type MeetingDecisionVersion,
  type MeetingDecisionWithdrawal,
  type MeetingMinutes,
  MeetingMinutesDocument,
  type MeetingState,
  MeetingWithdrawDecisionRequest,
  SECRETARY_ID,
} from '@corral/contracts';
import type { CorralRepository, SessionResult } from './repository/index.ts';
import type { RuntimeTransport } from './transport.ts';

type Repository = Pick<CorralRepository, 'getSession' | 'updateSession'>;
type Failure = {
  ok: false;
  error: 'not_found' | 'invalid' | 'conflict' | 'storage_unavailable';
  message: string;
};
export type MeetingDecisionResult<T> = ({ ok: true } & T) | Failure;
export interface MeetingDecisionsServiceDeps {
  repository: Repository;
  clock: Clock;
  newDecisionId(): string;
}

export const SECRETARY_MINUTES_INSTRUCTIONS = `Return only one JSON object (no prose or Markdown fences), with exactly these fields:
{"issues":["issue"],"claims":[{"roundId":"source round ID","participantId":"speaker ID","text":"claim"}],"agreements":[{"text":"agreement","supporters":[{"roundId":"source round ID","participantId":"speaker ID"}]}],"remainingDissent":[{"roundId":"source round ID","participantId":"speaker ID","text":"remaining disagreement"}],"unverifiedFacts":["fact to check"],"candidates":[{"candidateId":"candidate_1","content":{"goal":"goal","scope":["scope"],"excludedScope":["excluded scope"],"acceptanceCriteria":["completion criterion"],"remainingDissent":["remaining disagreement"],"evidence":["selected evidence"],"risks":["risk"],"actions":["proposed action"],"rejectedAlternatives":["rejected background"]}}]}
Use the actual round and participant IDs supplied in the transcript. Claims, agreements and remaining dissent may only cite participants whose answers succeeded in that round; silence or failure is never agreement. Preserve all unresolved disagreements in remainingDissent and relevant decision candidates. Keep uncertain statements in unverifiedFacts. Use empty arrays when nothing is supported. Candidates and actions are proposals, never adopted decisions or instructions to execute. Do not invent sources, evidence or agreements.`;

const failure = (error: Failure['error'], message: string): Failure => ({
  ok: false,
  error,
  message,
});
function saveFailure(saved: Exclude<SessionResult, { ok: true }>): Failure {
  return failure(saved.error === 'revision_conflict' ? 'conflict' : saved.error, saved.message);
}

/** Candidates never qualify: only a human-adopted version still in force can be handed off. */
export function activeMeetingDecision(
  meeting: Pick<MeetingState, 'decisions' | 'decisionWithdrawals'>,
  versionId: string,
): MeetingDecisionVersion | null {
  if (meeting.decisionWithdrawals?.some((item) => item.versionId === versionId)) return null;
  if (meeting.decisions?.some((item) => item.supersedesVersionId === versionId)) return null;
  return meeting.decisions?.find((item) => item.versionId === versionId) ?? null;
}

/** Projects completed secretary output into a saved document. Reading/recovery never calls a model. */
export async function recordMeetingMinutes(
  deps: { repository: Repository; transport: RuntimeTransport; clock: Clock },
  sessionId: string,
  roundId: string,
): Promise<MeetingDecisionResult<{ minutes: MeetingMinutes }>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const session = await deps.repository.getSession(sessionId);
    if (!session?.meeting) return failure('not_found', 'The meeting does not exist.');
    const meeting = session.meeting;
    const existing = meeting.minutes?.find((item) => item.roundId === roundId);
    if (existing) return { ok: true, minutes: existing };
    const index = meeting.rounds.findIndex((item) => item.roundId === roundId);
    const round = meeting.rounds[index];
    const answer = round?.answers.find((item) => item.participantId === SECRETARY_ID);
    if (
      round?.kind !== 'secretary' ||
      round.stoppedAt ||
      answer?.state !== 'started' ||
      !answer.runId
    )
      return failure('invalid', 'Only a completed secretary answer can become meeting minutes.');
    const runId = answer.runId;
    let text: string;
    try {
      const { projection } = await deps.transport.getSnapshot(runId);
      if (projection.status !== 'succeeded')
        return failure('invalid', 'The secretary has not completed its answer.');
      const parts = await Promise.all(
        (projection.output?.artifactVersionIds ?? []).map((id) =>
          deps.transport.getArtifactText(runId, id),
        ),
      );
      text = parts.filter((part): part is string => part !== null).join('\n\n');
    } catch {
      return failure(
        'storage_unavailable',
        'The secretary answer is unavailable. Try again when its record can be read.',
      );
    }
    let document: MeetingMinutesDocument | null = null;
    let error: string | null = null;
    try {
      const parsed = MeetingMinutesDocument.safeParse(
        JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1')),
      );
      if (parsed.success) document = parsed.data;
      else
        error =
          'The secretary did not return valid structured meeting minutes. Ask the secretary to summarise again.';
    } catch {
      error =
        'The secretary did not return valid JSON meeting minutes. Ask the secretary to summarise again.';
    }
    if (document) {
      const references: MeetingAnswerReference[] = [
        ...document.claims,
        ...document.remainingDissent,
        ...document.agreements.flatMap((item) => item.supporters),
      ];
      const checked = new Set<string>();
      for (const reference of references) {
        const key = `${reference.roundId}/${reference.participantId}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const source = meeting.rounds
          .slice(0, index)
          .find((item) => item.roundId === reference.roundId);
        const sourceAnswer = source?.answers.find(
          (item) => item.participantId === reference.participantId,
        );
        let answered = false;
        if (
          reference.participantId !== SECRETARY_ID &&
          sourceAnswer?.state === 'started' &&
          sourceAnswer.runId
        ) {
          try {
            const { projection } = await deps.transport.getSnapshot(sourceAnswer.runId);
            answered = projection.status === 'succeeded';
          } catch {
            return failure(
              'storage_unavailable',
              'A cited answer is unavailable. Try again when its record can be read.',
            );
          }
        }
        if (!answered) {
          document = null;
          error =
            'The secretary attributed a statement to a participant who did not answer successfully in that source round. Ask for corrected minutes.';
          break;
        }
      }
    }
    const minutes: MeetingMinutes = {
      minutesId: roundId,
      roundId,
      createdAt: deps.clock.nowIso(),
      document,
      error,
    };
    const saved = await deps.repository.updateSession(sessionId, {
      expectedRevision: session.revision,
      meeting: { ...meeting, minutes: [...(meeting.minutes ?? []), minutes] },
    });
    if (saved.ok) return { ok: true, minutes };
    if (saved.error !== 'revision_conflict') return saveFailure(saved);
  }
  return failure(
    'conflict',
    'The meeting changed while its minutes were being recorded. Try again.',
  );
}

export class MeetingDecisionsService {
  private readonly deps: MeetingDecisionsServiceDeps;

  constructor(deps: MeetingDecisionsServiceDeps) {
    this.deps = deps;
  }

  async adopt(
    sessionId: string,
    input: MeetingAdoptDecisionRequest,
  ): Promise<MeetingDecisionResult<{ decision: MeetingDecisionVersion }>> {
    const parsed = MeetingAdoptDecisionRequest.safeParse(input);
    if (!parsed.success) return failure('invalid', 'The decision request is not valid.');
    const request = parsed.data;
    for (let attempt = 0; attempt < 5; attempt++) {
      const session = await this.deps.repository.getSession(sessionId);
      if (!session?.meeting) return failure('not_found', 'The meeting does not exist.');
      const meeting = session.meeting;
      const previous = meeting.decisions?.find((item) => item.commandId === request.commandId);
      if (previous) {
        const identity = {
          minutesId: previous.minutesId,
          candidateId: previous.candidateId,
          content: previous.content,
          supersedesVersionId: previous.supersedesVersionId,
        };
        return canonicalJson(identity) ===
          canonicalJson({
            minutesId: request.minutesId,
            candidateId: request.candidateId,
            content: request.content,
            supersedesVersionId: request.supersedesVersionId ?? null,
          })
          ? { ok: true, decision: previous }
          : failure('conflict', 'This command already adopted a different decision.');
      }
      if (meeting.decisionWithdrawals?.some((item) => item.commandId === request.commandId))
        return failure('conflict', 'This command already withdrew a decision.');
      const source = meeting.minutes?.find((item) => item.minutesId === request.minutesId);
      if (!source?.document?.candidates.some((item) => item.candidateId === request.candidateId))
        return failure(
          'invalid',
          'Choose a candidate from valid meeting minutes before adopting it.',
        );
      if (
        request.supersedesVersionId &&
        !activeMeetingDecision(meeting, request.supersedesVersionId)
      )
        return failure('conflict', 'Only a decision still in force can be replaced.');
      const decision: MeetingDecisionVersion = {
        ...request,
        versionId: this.deps.newDecisionId(),
        supersedesVersionId: request.supersedesVersionId ?? null,
        createdAt: this.deps.clock.nowIso(),
      };
      const saved = await this.deps.repository.updateSession(sessionId, {
        expectedRevision: session.revision,
        meeting: { ...meeting, decisions: [...(meeting.decisions ?? []), decision] },
      });
      if (saved.ok) return { ok: true, decision };
      if (saved.error !== 'revision_conflict') return saveFailure(saved);
    }
    return failure(
      'conflict',
      'The meeting changed while the decision was being adopted. Try again.',
    );
  }

  async withdraw(
    sessionId: string,
    input: MeetingWithdrawDecisionRequest,
  ): Promise<MeetingDecisionResult<{ withdrawal: MeetingDecisionWithdrawal }>> {
    const parsed = MeetingWithdrawDecisionRequest.safeParse(input);
    if (!parsed.success) return failure('invalid', 'The withdrawal request is not valid.');
    const request = parsed.data;
    for (let attempt = 0; attempt < 5; attempt++) {
      const session = await this.deps.repository.getSession(sessionId);
      if (!session?.meeting) return failure('not_found', 'The meeting does not exist.');
      const meeting = session.meeting;
      const previous = meeting.decisionWithdrawals?.find(
        (item) => item.commandId === request.commandId,
      );
      if (previous)
        return previous.versionId === request.versionId && previous.reason === request.reason
          ? { ok: true, withdrawal: previous }
          : failure('conflict', 'This command already withdrew a different decision.');
      if (meeting.decisions?.some((item) => item.commandId === request.commandId))
        return failure('conflict', 'This command already adopted a decision.');
      if (!activeMeetingDecision(meeting, request.versionId))
        return failure('conflict', 'Only a decision still in force can be withdrawn.');
      const withdrawal: MeetingDecisionWithdrawal = {
        ...request,
        createdAt: this.deps.clock.nowIso(),
      };
      const saved = await this.deps.repository.updateSession(sessionId, {
        expectedRevision: session.revision,
        meeting: {
          ...meeting,
          decisionWithdrawals: [...(meeting.decisionWithdrawals ?? []), withdrawal],
        },
      });
      if (saved.ok) return { ok: true, withdrawal };
      if (saved.error !== 'revision_conflict') return saveFailure(saved);
    }
    return failure(
      'conflict',
      'The meeting changed while the decision was being withdrawn. Try again.',
    );
  }
}
