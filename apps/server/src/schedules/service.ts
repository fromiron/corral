import type { Schedule, ScheduleDraft, ScheduledOccurrence } from '@corral/contracts';
import type { AutoStart, AutoStartResult, CorralRepository } from '@corral/core';
import type { ScheduleStore } from './store.ts';
import { nextScheduleTime } from './time.ts';

export interface ScheduleDependencies {
  now(): string;
  id(): string;
  repository: Pick<CorralRepository, 'getSession' | 'addSessionEntry'>;
  start(
    request: AutoStart & { permissionMode: ScheduleDraft['request']['permissionMode'] },
    signal: AbortSignal,
  ): Promise<AutoStartResult>;
  previous(commandId: string): AutoStartResult | null;
  isRunActive(runId: string): boolean;
}

export class ScheduleError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ScheduleService {
  private pending = new Map<string, AbortController>();
  private ticking: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly store: ScheduleStore;
  private deps: ScheduleDependencies;
  constructor(store: ScheduleStore, deps: ScheduleDependencies) {
    this.store = store;
    this.deps = deps;
  }

  list() {
    return this.store.list().filter((schedule) => !schedule.deletedAt);
  }
  history(id: string) {
    return this.store.occurrences(id).slice(0, 100);
  }

  async validateTarget(draft: ScheduleDraft) {
    const session = await this.deps.repository.getSession(draft.sessionId);
    if (!session || session.archivedAt || session.projectId !== draft.projectId)
      throw new ScheduleError(400, 'Choose an existing, unarchived session in this project.');
    if (session.corralId) throw new ScheduleError(400, 'Choose an Auto session for this schedule.');
  }

  /** Used only by the reviewed vault domain adapter; commits all rows and operation identity together. */
  applyPortable(
    entries: { id: string; draft: ScheduleDraft }[],
    expectedRevision: string,
    operationId: string,
    payloadHash: string,
    revision: () => string,
    restore = false,
  ): { revision: string } {
    let applied = false;
    const result = this.store.atomic(() => {
      const prior = this.store.importOperation(operationId);
      if (prior) {
        if (prior.hash !== payloadHash)
          throw new ScheduleError(409, 'Import operation payload changed.');
        return { revision: prior.revision };
      }
      if (revision() !== expectedRevision)
        throw new ScheduleError(409, 'Schedules changed since the vault preview.');
      const now = this.deps.now();
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
        throw new ScheduleError(400, 'Duplicate schedule IDs.');
      for (const { id, draft } of entries) {
        const old = this.store.get(id);
        const localRevision = (old?.revision ?? 0) + 1;
        const value: Schedule = {
          ...draft,
          id,
          revision: localRevision,
          request: { ...draft.request, configRevision: localRevision },
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
          deletedAt: null,
          nextAt: nextScheduleTime(draft.rule, draft.timezone, now),
        };
        if (old) this.store.replace(value, old.revision);
        else this.store.insert(value);
      }
      if (restore) {
        const ids = new Set(entries.map((entry) => entry.id));
        for (const schedule of this.list())
          if (!ids.has(schedule.id))
            this.store.replace(
              {
                ...schedule,
                revision: schedule.revision + 1,
                deletedAt: now,
                enabled: false,
              },
              schedule.revision,
            );
      }
      const next = revision();
      this.store.saveImportOperation(operationId, payloadHash, next);
      applied = true;
      return { revision: next };
    });
    if (applied) {
      for (const { id } of entries) this.pending.get(id)?.abort();
      if (restore) for (const controller of this.pending.values()) controller.abort();
    }
    return result;
  }

  async create(draft: ScheduleDraft): Promise<Schedule> {
    await this.validateTarget(draft);
    const now = this.deps.now();
    const nextAt = nextScheduleTime(draft.rule, draft.timezone, now);
    if (draft.enabled && !nextAt) throw new ScheduleError(400, 'Choose a future occurrence.');
    const schedule: Schedule = {
      ...draft,
      request: { ...draft.request, configRevision: 1 },
      id: this.deps.id(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      nextAt,
      deletedAt: null,
    };
    this.store.insert(schedule);
    return schedule;
  }

  async update(id: string, draft: ScheduleDraft, expectedRevision: number): Promise<Schedule> {
    const old = this.require(id, expectedRevision);
    await this.validateTarget(draft);
    const now = this.deps.now();
    const nextAt = nextScheduleTime(draft.rule, draft.timezone, now);
    if (draft.enabled && !nextAt) throw new ScheduleError(400, 'Choose a future occurrence.');
    const schedule: Schedule = {
      ...old,
      ...draft,
      request: { ...draft.request, configRevision: old.revision + 1 },
      revision: old.revision + 1,
      updatedAt: now,
      nextAt,
    };
    if (!this.store.replace(schedule, expectedRevision))
      throw new ScheduleError(409, 'Schedule changed. Reload before saving.');
    this.pending.get(id)?.abort();
    return schedule;
  }

  remove(id: string, expectedRevision: number) {
    const schedule = this.require(id, expectedRevision);
    if (
      !this.store.replace(
        {
          ...schedule,
          revision: schedule.revision + 1,
          deletedAt: this.deps.now(),
          enabled: false,
        },
        expectedRevision,
      )
    )
      throw new ScheduleError(409, 'Schedule changed. Reload before deleting.');
    this.pending.get(id)?.abort();
  }

  private require(id: string, revision: number) {
    const schedule = this.store.get(id);
    if (!schedule || schedule.deletedAt) throw new ScheduleError(404, 'Schedule not found.');
    if (schedule.revision !== revision)
      throw new ScheduleError(409, 'Schedule changed. Reload before continuing.');
    return schedule;
  }

  async runNow(id: string, revision: number, commandId: string) {
    const schedule = this.require(id, revision);
    const now = this.deps.now();
    const occurrence = this.store.claim(schedule, now, now, commandId);
    if (occurrence) await this.dispatch(schedule, occurrence);
    // Stable caller command identity: a retry never starts another Run.
    return this.history(id);
  }

  /** Called once when the server starts. Never replays a pending external effect. */
  async recover() {
    for (const occurrence of this.store.occurrences()) {
      if (occurrence.status !== 'dispatching') continue;
      const previous = this.deps.previous(occurrence.commandId);
      const schedule = this.store.snapshot(occurrence.id);
      if (previous) await this.record(schedule, occurrence, previous);
      else
        this.store.save({
          ...occurrence,
          status: 'interrupted',
          detail:
            'Server stopped before a start could be confirmed. Use Run now to retry explicitly.',
        });
    }
    const now = this.deps.now();
    for (const schedule of this.list()) {
      if (schedule.enabled && schedule.nextAt && schedule.nextAt <= now) this.miss(schedule, now);
    }
  }

  private advance(schedule: Schedule, after: string) {
    this.store.replace(
      {
        ...schedule,
        nextAt: nextScheduleTime(schedule.rule, schedule.timezone, after),
      },
      schedule.revision,
    );
  }

  private miss(schedule: Schedule, now: string) {
    if (!schedule.nextAt) return;
    const occurrence = this.store.claim(schedule, schedule.nextAt, now);
    if (occurrence)
      this.store.save({
        ...occurrence,
        status: 'missed',
        detail: `Not run while the server was unavailable. Missed interval ends at ${now}.`,
      });
    this.advance(schedule, now);
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.poll().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async poll() {
    const now = this.deps.now();
    const work: Promise<void>[] = [];
    for (const schedule of this.list()) {
      if (!schedule.enabled || !schedule.nextAt || schedule.nextAt > now) continue;
      if (Date.parse(now) - Date.parse(schedule.nextAt) > 30_000) {
        this.miss(schedule, now);
        continue;
      }
      const occurrence = this.store.claim(schedule, schedule.nextAt, now);
      this.advance(schedule, now);
      if (occurrence) work.push(this.dispatch(schedule, occurrence));
    }
    await Promise.all(work);
  }

  private async dispatch(schedule: Schedule, occurrence: ScheduledOccurrence) {
    const overlapping =
      this.pending.has(schedule.id) ||
      this.store
        .occurrences(schedule.id)
        .some(
          (other) =>
            other.id !== occurrence.id &&
            (other.status === 'dispatching' || (other.runId && this.deps.isRunActive(other.runId))),
        );
    if (overlapping) {
      this.store.save({
        ...occurrence,
        status: 'overlap',
        detail: 'A previous occurrence is still running or waiting for a response.',
      });
      return;
    }
    const controller = new AbortController();
    this.pending.set(schedule.id, controller);
    try {
      await this.validateTarget(schedule);
      const current = this.store.get(schedule.id);
      if (
        controller.signal.aborted ||
        !current ||
        current.deletedAt ||
        current.revision !== schedule.revision ||
        (!occurrence.manual && !current.enabled)
      )
        throw new ScheduleError(409, 'Schedule changed before the Run started.');
      const { configRevision: _configRevision, ...request } = schedule.request;
      const result = await this.deps.start(
        {
          ...request,
          sessionId: schedule.sessionId,
          commandId: occurrence.commandId,
        },
        controller.signal,
      );
      await this.record(schedule, occurrence, result);
    } catch {
      const previous = this.deps.previous(occurrence.commandId);
      if (previous) await this.record(schedule, occurrence, previous);
      else
        this.store.save({
          ...occurrence,
          status: controller.signal.aborted ? 'interrupted' : 'refused',
          detail: controller.signal.aborted
            ? 'Schedule changed or server stopped before the Run started.'
            : 'The request could not start. Check the session and model settings, then run explicitly.',
        });
    } finally {
      if (this.pending.get(schedule.id) === controller) this.pending.delete(schedule.id);
    }
  }

  private async record(
    schedule: Schedule,
    occurrence: ScheduledOccurrence,
    result: AutoStartResult,
  ) {
    const saved = await this.deps.repository.addSessionEntry(schedule.sessionId, {
      intent: 'next',
      state: result.runId ? 'started' : 'refused',
      text: schedule.request.brief,
      runId: result.runId,
      commandId: occurrence.commandId,
      detail: result.receipt.error?.message ?? null,
      ...(result.autoRoute
        ? {
            auto: {
              template: result.autoRoute.template,
              source: result.autoRoute.source,
              reason: result.autoRoute.reason,
              modelProfile: result.autoRoute.modelProfile,
              permissionMode: schedule.request.permissionMode,
              ...(result.autoRoute.fallback ? { fallback: result.autoRoute.fallback } : {}),
              ...(result.autoRoute.reasoning
                ? { requestedReasoning: result.autoRoute.reasoning }
                : {}),
              ...(result.autoRoute.reasoningChoice
                ? {
                    reasoning: result.autoRoute.reasoningChoice.level,
                    reasoningSource: result.autoRoute.reasoningChoice.source,
                  }
                : {}),
            },
          }
        : {}),
    });
    if (!saved.ok)
      throw new ScheduleError(
        503,
        'The Run started but its conversation entry could not be saved.',
      );
    this.store.save({
      ...occurrence,
      status: result.runId ? 'started' : 'refused',
      runId: result.runId,
      detail: result.receipt.error?.message ?? null,
    });
  }

  async start() {
    await this.recover();
    this.resumeAfterIdle();
  }
  resumeAfterIdle() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.pending.values()) controller.abort();
    return this.ticking ?? Promise.resolve();
  }

  /** Update restart must never cancel a dispatch that has already begun. */
  pauseIfIdle(): boolean {
    if (this.pending.size || this.ticking) return false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return true;
  }
}
