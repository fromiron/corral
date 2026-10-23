import { createHash } from 'node:crypto';
import {
  type AutoRoute,
  type Clock,
  type CorralDefinition,
  canonicalJson,
  Identifier,
  type MeetingDecisionContent,
  type MeetingHandoffReceipt,
  MeetingHandoffRequest,
  MeetingHandoffStartRequest,
  type MeetingRoundRequest,
  type Receipt,
  type RunStatus,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import {
  activeMeetingDecision,
  type MeetingResult,
  planSessionCreate,
  planSessionEntry,
  planSessionEntryUpdate,
  type SessionResult,
} from '@corral/core';
import type { Db, SqliteCorralRepository } from '@corral/storage-sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

export interface MeetingHandoffStart {
  commandId: string;
  sessionId: string;
  brief: string;
  criteria: string[];
  mode: 'mock' | 'live';
  execution: MeetingHandoffRequest['execution'];
  definition?: CorralDefinition;
  definitionRevision: number | null;
}
type StartResult = { runId: string | null; receipt: Receipt; autoRoute?: AutoRoute | null };
export interface MeetingHandoffDeps {
  clock: Clock;
  start(input: MeetingHandoffStart): Promise<StartResult>;
  previous(commandId: string): StartResult | null;
  activeRun(sessionId: string): boolean;
  cancelStart(commandId: string, sessionId: string): Promise<void>;
  runResult(
    runId: string,
  ): { status: RunStatus; artifactVersionId: string | null; text: string | null } | null;
  discuss(sessionId: string, request: MeetingRoundRequest): Promise<MeetingResult>;
}
type Stored = {
  receipt: MeetingHandoffReceipt;
  start: MeetingHandoffStart;
  hash: string;
  launch?: MeetingHandoffStartRequest;
  cancelRequested?: boolean;
};

export class MeetingHandoffError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function sessionOrThrow(result: SessionResult) {
  if (!result.ok)
    throw new MeetingHandoffError(result.message, result.error === 'not_found' ? 404 : 409);
  return result.session;
}

/** The adopted scope is the entire handoff; prior chat is intentionally not input to the worker. */
function decisionBrief(content: MeetingDecisionContent): string {
  const sections: [string, string[]][] = [
    ['Scope', content.scope],
    ['Excluded scope', content.excludedScope],
    ['Acceptance criteria', content.acceptanceCriteria],
    ['Remaining dissent', content.remainingDissent],
    ['Risks', content.risks],
    ['Selected evidence', content.evidence],
    ['Next actions', content.actions],
    ['Rejected background (not instructions)', content.rejectedAlternatives],
  ];
  return [
    `Goal\n${content.goal}`,
    ...sections.map(
      ([title, items]) =>
        `${title}\n${items.map((item) => `- ${item}`).join('\n') || '(none recorded)'}`,
    ),
  ].join('\n\n');
}

export class MeetingHandoffService {
  private readonly pending = new Map<string, Promise<MeetingHandoffReceipt>>();
  private readonly db: Db;
  private readonly repository: SqliteCorralRepository;
  private readonly deps: MeetingHandoffDeps;
  constructor(db: Db, repository: SqliteCorralRepository, deps: MeetingHandoffDeps) {
    this.db = db;
    this.repository = repository;
    this.deps = deps;
  }

  send(sourceSessionId: string, input: MeetingHandoffRequest): Promise<MeetingHandoffReceipt> {
    const parsed = MeetingHandoffRequest.safeParse(input);
    if (!parsed.success) return Promise.reject(new MeetingHandoffError('Invalid handoff fields.'));
    const request = parsed.data;
    if (
      request.execution.kind === 'auto' &&
      request.execution.ultra &&
      request.execution.qualityPreset !== 'ultra'
    )
      return Promise.reject(new MeetingHandoffError('Ultra selection requires the Ultra preset.'));
    const key = `${sourceSessionId}:${request.commandId}`;
    const hash = createHash('sha256')
      .update(canonicalJson({ sourceSessionId, request }))
      .digest('hex');
    const ongoing = this.pending.get(key);
    if (ongoing)
      return ongoing.then((receipt) => {
        if (this.stored(sourceSessionId, request.commandId)?.hash !== hash)
          throw new MeetingHandoffError('This handoff command already has different content.', 409);
        return receipt;
      });
    const work = this.sendOnce(sourceSessionId, request, hash);
    this.pending.set(key, work);
    const clear = () => {
      if (this.pending.get(key) === work) this.pending.delete(key);
    };
    void work.then(clear, clear);
    return work;
  }

  private async sendOnce(sourceSessionId: string, request: MeetingHandoffRequest, hash: string) {
    let stored = this.stored(sourceSessionId, request.commandId);
    if (stored && stored.hash !== hash)
      throw new MeetingHandoffError('This handoff command already has different content.', 409);
    if (!stored) stored = await this.prepare(sourceSessionId, request, hash);
    stored = this.reconcile(stored);
    if (stored.cancelRequested && stored.receipt.state !== 'cancelled')
      return this.cancel(sourceSessionId, request.commandId);
    if (!['starting', 'uncertain'].includes(stored.receipt.state)) return this.view(stored);
    return this.dispatch(stored);
  }

  startDraft(
    sourceSessionId: string,
    commandId: string,
    input: MeetingHandoffStartRequest,
  ): Promise<MeetingHandoffReceipt> {
    const parsed = MeetingHandoffStartRequest.safeParse(input);
    if (!parsed.success)
      return Promise.reject(new MeetingHandoffError('Invalid draft start request.'));
    const key = `${sourceSessionId}:${commandId}`;
    const ongoing = this.pending.get(key);
    if (ongoing)
      return ongoing.then(() => this.startDraft(sourceSessionId, commandId, parsed.data));
    let stored = this.stored(sourceSessionId, commandId);
    if (!stored) return Promise.reject(new MeetingHandoffError('The handoff does not exist.', 404));
    stored = this.reconcile(stored);
    if (stored.cancelRequested && stored.receipt.state !== 'cancelled')
      return this.cancel(sourceSessionId, commandId);
    if (
      stored.launch &&
      stored.launch.commandId === parsed.data.commandId &&
      stored.launch.targetHasDraft !== parsed.data.targetHasDraft
    )
      return Promise.reject(
        new MeetingHandoffError('This draft start command has different content.', 409),
      );
    if (!['drafted', 'starting', 'uncertain'].includes(stored.receipt.state))
      return Promise.resolve(this.view(stored));
    if (parsed.data.targetHasDraft) return Promise.resolve(this.view(stored));
    const source = this.repository.session(sourceSessionId);
    if (
      !source?.meeting ||
      !activeMeetingDecision(source.meeting, stored.receipt.decisionVersionId)
    )
      return Promise.reject(
        new MeetingHandoffError('Only a current, adopted decision version can be started.'),
      );
    stored.launch = parsed.data;
    stored.receipt.state = 'starting';
    stored.receipt.detail = null;
    this.save(stored);
    const work = this.dispatch(stored);
    this.pending.set(key, work);
    const clear = () => {
      if (this.pending.get(key) === work) this.pending.delete(key);
    };
    void work.then(clear, clear);
    return work;
  }

  private async dispatch(stored: Stored): Promise<MeetingHandoffReceipt> {
    const { sourceSessionId, commandId, entryId } = stored.receipt;
    const source = this.repository.session(sourceSessionId);
    if (
      !source?.meeting ||
      !activeMeetingDecision(source.meeting, stored.receipt.decisionVersionId)
    )
      throw new MeetingHandoffError('Only a current, adopted decision version can be started.');
    // Recheck after recovery or asynchronous configuration lookup; never enter an active target.
    const target = this.repository.session(stored.receipt.targetSessionId);
    if (
      !target ||
      target.archivedAt ||
      target.meeting ||
      !this.db
        .prepare('SELECT 1 FROM projects WHERE id=? AND archived_at IS NULL')
        .get(target.projectId) ||
      this.deps.activeRun(target.sessionId) ||
      target.entries.some(
        (entry) => entry.entryId !== entryId && ['queued', 'undelivered'].includes(entry.state),
      )
    ) {
      stored.receipt.state = 'drafted';
      stored.receipt.detail =
        'The target is unavailable or has other pending work; saved as a draft.';
      this.save(stored);
      return this.view(stored);
    }
    let result: StartResult | null;
    try {
      result = this.deps.previous(stored.start.commandId) ?? (await this.deps.start(stored.start));
    } catch {
      result = this.deps.previous(stored.start.commandId);
    }
    stored = this.stored(sourceSessionId, commandId) ?? stored;
    if (result) this.settle(stored, result);
    else if (!stored.cancelRequested) {
      stored.receipt.state = 'uncertain';
      stored.receipt.detail =
        'The start response is unknown. Check this receipt before retrying the same command.';
      this.save(stored);
    }
    if (stored.cancelRequested) {
      try {
        return await this.cancel(sourceSessionId, commandId);
      } catch {
        return this.view(this.stored(sourceSessionId, commandId) ?? stored);
      }
    }
    return this.view(stored);
  }

  private async prepare(
    sourceSessionId: string,
    request: MeetingHandoffRequest,
    hash: string,
  ): Promise<Stored> {
    const corral =
      request.execution.kind === 'corral'
        ? await this.repository.get(request.execution.corralId)
        : null;
    return this.db
      .transaction(() => {
        const existing = this.stored(sourceSessionId, request.commandId);
        if (existing) {
          if (existing.hash !== hash)
            throw new MeetingHandoffError(
              'This handoff command already has different content.',
              409,
            );
          return existing;
        }
        const source = this.repository.session(sourceSessionId);
        const decision =
          source?.meeting && activeMeetingDecision(source.meeting, request.decisionVersionId);
        if (!source?.meeting)
          throw new MeetingHandoffError('The source meeting does not exist.', 404);
        if (!decision)
          throw new MeetingHandoffError(
            'Only a current, adopted decision version can be handed off.',
          );
        if (
          !this.db
            .prepare('SELECT 1 FROM projects WHERE id=? AND archived_at IS NULL')
            .get(source.projectId)
        )
          throw new MeetingHandoffError('The project is archived.', 409);
        if (
          request.execution.kind === 'corral' &&
          (!corral || corral.projectId !== source.projectId)
        )
          throw new MeetingHandoffError('Choose a Corral from this project.');
        const definition = corral
          ? this.repository.getDefinition(corral.corralId, corral.definitionRevision)
          : null;
        if (corral && !definition)
          throw new MeetingHandoffError('The selected Corral is not runnable.');
        const now = this.deps.clock.nowIso();
        const key = createHash('sha256')
          .update(`${sourceSessionId}:${request.commandId}`)
          .digest('hex')
          .slice(0, 32);
        const target =
          request.target.kind === 'existing'
            ? this.repository.session(request.target.sessionId)
            : sessionOrThrow(
                planSessionCreate(
                  { projectId: source.projectId, title: request.target.title },
                  { now, sessionId: `session_handoff_${key}` },
                ),
              );
        if (!target || target.meeting || target.archivedAt || target.projectId !== source.projectId)
          throw new MeetingHandoffError(
            'The target must be an unarchived work session in this project.',
          );
        const brief = decisionBrief(decision.content);
        if (brief.length > 20_000)
          throw new MeetingHandoffError('The adopted decision is too long for a work request.');
        const active = this.deps.activeRun(target.sessionId);
        const pending = target.entries.some((entry) =>
          ['queued', 'undelivered'].includes(entry.state),
        );
        const draft = request.action === 'draft' || request.targetHasDraft || active || pending;
        const startCommandId = `meeting_start_${key}`;
        const entryId = `entry_handoff_${key}`;
        const saved = planSessionEntry(
          target,
          target.sessionId,
          {
            intent: 'next',
            text: brief,
            state: 'undelivered',
            commandId: startCommandId,
            meetingHandoff: {
              sourceSessionId,
              commandId: request.commandId,
              decisionVersionId: request.decisionVersionId,
            },
            ...(request.execution.kind === 'auto'
              ? {
                  ...(request.execution.qualityPreset
                    ? { qualityPreset: request.execution.qualityPreset }
                    : {}),
                  ...(request.execution.ultra ? { ultra: request.execution.ultra } : {}),
                }
              : {}),
          },
          { now, entryId },
        );
        sessionOrThrow(this.repository.saveSession(saved));
        const receipt: MeetingHandoffReceipt = {
          commandId: request.commandId,
          startCommandId,
          sourceSessionId,
          decisionVersionId: request.decisionVersionId,
          targetSessionId: target.sessionId,
          entryId,
          action: request.action,
          execution: request.execution,
          definitionRevision: corral?.definitionRevision ?? null,
          mode: request.mode,
          brief,
          state: draft ? 'drafted' : 'starting',
          runId: null,
          createdAt: now,
          result: null,
          detail: request.targetHasDraft
            ? 'The target has an unsent draft.'
            : active
              ? 'The target has an active run.'
              : pending
                ? 'The target has pending requests.'
                : null,
        };
        const stored: Stored = {
          receipt,
          hash,
          start: {
            commandId: startCommandId,
            sessionId: target.sessionId,
            brief,
            criteria: decision.content.acceptanceCriteria,
            mode: request.mode,
            execution: request.execution,
            definitionRevision: receipt.definitionRevision,
            ...(definition ? { definition } : {}),
          },
        };
        this.db
          .prepare('INSERT INTO meeting_handoffs VALUES (?,?,?,?,?)')
          .run(sourceSessionId, request.commandId, target.sessionId, hash, JSON.stringify(stored));
        return stored;
      })
      .immediate();
  }

  receipt(sourceSessionId: string, commandId: string): MeetingHandoffReceipt | null {
    const stored = this.stored(sourceSessionId, commandId);
    return stored ? this.view(this.reconcile(stored)) : null;
  }

  list(sessionId: string): MeetingHandoffReceipt[] {
    const rows = this.db
      .prepare(
        'SELECT payload_json FROM meeting_handoffs WHERE source_session_id=? OR target_session_id=? ORDER BY rowid DESC',
      )
      .all(sessionId, sessionId) as { payload_json: string }[];
    return rows.map((row) => this.view(this.reconcile(JSON.parse(row.payload_json) as Stored)));
  }

  async cancel(sourceSessionId: string, commandId: string) {
    let stored = this.stored(sourceSessionId, commandId);
    if (!stored) throw new MeetingHandoffError('The handoff does not exist.', 404);
    stored = this.reconcile(stored);
    const state = stored.receipt.state;
    stored.cancelRequested = true;
    stored.receipt.state = 'uncertain';
    stored.receipt.detail = 'Cancellation was requested; the runtime has not confirmed it yet.';
    this.save(stored);
    try {
      if (state !== 'drafted')
        await this.deps.cancelStart(stored.start.commandId, stored.start.sessionId);
    } catch {
      throw new MeetingHandoffError(
        'Cancellation could not be confirmed. Retry cancellation using this handoff receipt.',
        503,
      );
    }
    stored = this.stored(sourceSessionId, commandId) ?? stored;
    stored.receipt.state = 'cancelled';
    stored.receipt.detail = 'The person cancelled this handoff.';
    this.save(stored);
    this.updateEntry(stored);
    return this.view(stored);
  }

  async rediscuss(
    sourceSessionId: string,
    commandId: string,
    request: { commandId: string; mode: 'mock' | 'live' },
  ): Promise<MeetingResult> {
    const receipt = this.receipt(sourceSessionId, commandId);
    const result = receipt?.runId ? this.deps.runResult(receipt.runId) : null;
    if (!receipt?.runId || !result || !TERMINAL_RUN_STATUSES.has(result.status))
      throw new MeetingHandoffError('Wait for a terminal work result before discussing it.', 409);
    const text = `Discuss this work result.\nDecision: ${receipt.decisionVersionId}\nSession: ${receipt.targetSessionId}\nRun: ${receipt.runId}\nStatus: ${result.status}\nArtifact: ${result.artifactVersionId ?? '(none)'}\n\n${result.text ?? '(No final artifact was produced.)'}`;
    if (text.length > 20_000)
      throw new MeetingHandoffError('This result is too long for a meeting message.');
    return this.deps.discuss(sourceSessionId, { kind: 'message', ...request, text });
  }

  private stored(sourceSessionId: string, commandId: string): Stored | null {
    const row = this.db
      .prepare(
        'SELECT payload_json FROM meeting_handoffs WHERE source_session_id=? AND command_id=?',
      )
      .get(sourceSessionId, commandId) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as Stored) : null;
  }

  private save(stored: Stored) {
    this.db
      .prepare(
        'UPDATE meeting_handoffs SET payload_json=? WHERE source_session_id=? AND command_id=?',
      )
      .run(JSON.stringify(stored), stored.receipt.sourceSessionId, stored.receipt.commandId);
  }

  private reconcile(stored: Stored): Stored {
    if (['starting', 'uncertain', 'cancelled'].includes(stored.receipt.state)) {
      const known = this.deps.previous(stored.start.commandId);
      if (known) this.settle(stored, known);
    }
    return stored;
  }

  private settle(stored: Stored, result: StartResult) {
    this.db
      .transaction(() => {
        stored.receipt.runId = result.runId;
        if (result.autoRoute) stored.receipt.autoRoute = result.autoRoute;
        if (!stored.cancelRequested && stored.receipt.state !== 'cancelled') {
          stored.receipt.state =
            result.receipt.status === 'cancelled'
              ? 'cancelled'
              : result.runId
                ? 'started'
                : result.receipt.error?.code === 'RUN_ALREADY_ACTIVE'
                  ? 'drafted'
                  : 'refused';
          stored.receipt.detail = result.receipt.error?.message ?? null;
        }
        this.save(stored);
        this.updateEntry(stored);
      })
      .immediate();
  }

  private updateEntry(stored: Stored) {
    const receipt = stored.receipt;
    const session = this.repository.session(receipt.targetSessionId);
    sessionOrThrow(
      this.repository.saveSession(
        planSessionEntryUpdate(
          session,
          receipt.targetSessionId,
          receipt.entryId,
          {
            state:
              receipt.state === 'cancelled'
                ? 'dismissed'
                : receipt.state === 'started'
                  ? 'started'
                  : receipt.state === 'refused'
                    ? 'refused'
                    : 'undelivered',
            runId: receipt.runId,
            detail: receipt.detail,
          },
          this.deps.clock.nowIso(),
        ),
      ),
    );
  }

  private view(stored: Stored): MeetingHandoffReceipt {
    const result = stored.receipt.runId ? this.deps.runResult(stored.receipt.runId) : null;
    return {
      ...stored.receipt,
      result: result
        ? { status: result.status, artifactVersionId: result.artifactVersionId }
        : null,
    };
  }
}

export function registerMeetingHandoffRoutes(app: FastifyInstance, service: MeetingHandoffService) {
  const fail = (error: unknown, reply: FastifyReply) => {
    if (error instanceof MeetingHandoffError)
      return reply.code(error.status).send({ error: { message: error.message } });
    throw error;
  };
  app.post<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId/meeting/handoffs',
    async (request, reply) => {
      try {
        return {
          handoff: await service.send(
            request.params.sessionId,
            request.body as MeetingHandoffRequest,
          ),
        };
      } catch (error) {
        return fail(error, reply);
      }
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId/meeting-handoffs',
    async (request) => ({ handoffs: service.list(request.params.sessionId) }),
  );
  app.get<{ Params: { sessionId: string; commandId: string } }>(
    '/api/v1/sessions/:sessionId/meeting/handoffs/:commandId',
    async (request, reply) => {
      const handoff = service.receipt(request.params.sessionId, request.params.commandId);
      return handoff
        ? { handoff }
        : reply.code(404).send({ error: { message: 'The handoff does not exist.' } });
    },
  );
  app.post<{ Params: { sessionId: string; commandId: string } }>(
    '/api/v1/sessions/:sessionId/meeting/handoffs/:commandId/cancel',
    async (request, reply) => {
      try {
        return {
          handoff: await service.cancel(request.params.sessionId, request.params.commandId),
        };
      } catch (error) {
        return fail(error, reply);
      }
    },
  );
  app.post<{ Params: { sessionId: string; commandId: string } }>(
    '/api/v1/sessions/:sessionId/meeting/handoffs/:commandId/start',
    async (request, reply) => {
      try {
        return {
          handoff: await service.startDraft(
            request.params.sessionId,
            request.params.commandId,
            request.body as MeetingHandoffStartRequest,
          ),
        };
      } catch (error) {
        return fail(error, reply);
      }
    },
  );
  app.post<{ Params: { sessionId: string; commandId: string } }>(
    '/api/v1/sessions/:sessionId/meeting/handoffs/:commandId/rediscuss',
    async (request, reply) => {
      const body = z
        .strictObject({ commandId: Identifier, mode: z.enum(['mock', 'live']) })
        .safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: { message: 'Invalid discussion request.' } });
      try {
        return await service.rediscuss(
          request.params.sessionId,
          request.params.commandId,
          body.data,
        );
      } catch (error) {
        return fail(error, reply);
      }
    },
  );
}
