import type {
  CorralDefinition,
  EffectiveHarnessSnapshot,
  ModelProfileSnapshot,
  Receipt,
  RunEvent,
  RunStatus,
} from '@corral/contracts';
import type { RunProjection } from '../projection.ts';

// Where committed run facts live (C-011, ADR-003). One commit = one transaction that writes
// the events, the updated projection (which carries effect intents), the command record and
// artifact bodies together, or nothing at all. Methods are synchronous: better-sqlite3 is, and
// the in-memory store must behave the same way so tests exercise the real commit path.

/** What a run was started with, fixed for its whole life (C-057, CRL-CAN-002). */
export interface RunSnapshot {
  /** The definition as run, with the run input applied. Later edits never reach it. */
  definition: CorralDefinition;
  definitionHash: string;
  /** The saved revision it came from; null for inline definitions (in-process runtime). */
  source: { corralId: string; definitionRevision: number } | null;
  /** Immutable version of the completion criteria the run started with. */
  criteriaVersionId: string;
  mode: 'mock' | 'live';
  /** What each model profile resolved to at start (C-058); the run never re-resolves. */
  models: Record<string, ModelProfileSnapshot>;
  /** Role IDs to pinned harnesses; absent for legacy runs. */
  harnesses?: Record<string, EffectiveHarnessSnapshot>;
  startedAt: string;
}

export interface StoredRun {
  runId: string;
  snapshot: RunSnapshot;
  projection: RunProjection;
  /** The work session the run continues (CR-011); kept beside the snapshot, not in it. */
  sessionId?: string | null;
}

export interface StoredCommand {
  /** runId, or "*" for run-creation commands that have no run yet. */
  scope: string;
  commandId: string;
  payloadHash: string;
  receipt: Receipt;
  runId: string | null;
  directiveId: string | null;
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  corralId: string;
  startedAt: string;
  /**
   * The project the run started in (CR-010), fixed at start. Null where the store does not
   * record it (the in-browser runtime): the Corral's project stands in.
   */
  projectId: string | null;
  /** The work session it belongs to (CR-011), or null. */
  sessionId: string | null;
}

export interface RunStore {
  /** Runs `write` atomically; if it throws, nothing it wrote is kept. */
  transaction<T>(write: () => T): T;
  insertRun(run: StoredRun): void;
  saveProjection(runId: string, projection: RunProjection): void;
  appendEvents(runId: string, events: readonly RunEvent[]): void;
  putCommand(command: StoredCommand): void;
  putArtifactText(runId: string, artifactVersionId: string, text: string): void;

  getRun(runId: string): StoredRun | null;
  /** Newest first. */
  listRuns(): RunSummary[];
  readEvents(runId: string, afterSeq: number, limit?: number): RunEvent[];
  getCommand(scope: string, commandId: string): StoredCommand | null;
  getArtifactText(runId: string, artifactVersionId: string): string | null;
}

/** Store for tests and the in-browser runtime. Rolls back by restoring a copy on failure. */
export class InMemoryRunStore implements RunStore {
  private runs = new Map<string, StoredRun>();
  private events = new Map<string, RunEvent[]>();
  private commands = new Map<string, StoredCommand>();
  private artifacts = new Map<string, string>();
  private depth = 0;

  transaction<T>(write: () => T): T {
    if (this.depth > 0) return write();
    const saved = {
      runs: new Map(this.runs),
      events: new Map([...this.events].map(([k, v]) => [k, [...v]])),
      commands: new Map(this.commands),
      artifacts: new Map(this.artifacts),
    };
    this.depth += 1;
    try {
      return write();
    } catch (error) {
      Object.assign(this, saved);
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  insertRun(run: StoredRun) {
    if (this.runs.has(run.runId)) throw new Error(`run ${run.runId} already exists`);
    this.runs.set(run.runId, run);
    this.events.set(run.runId, []);
  }

  saveProjection(runId: string, projection: RunProjection) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run ${runId} does not exist`);
    this.runs.set(runId, { ...run, projection });
  }

  appendEvents(runId: string, events: readonly RunEvent[]) {
    const log = this.events.get(runId);
    if (!log) throw new Error(`run ${runId} does not exist`);
    for (const event of events) {
      if (event.runSeq !== log.length + 1) throw new Error(`runSeq ${event.runSeq} is not next`);
      log.push(event);
    }
  }

  putCommand(command: StoredCommand) {
    const key = `${command.scope}\u0000${command.commandId}`;
    if (this.commands.has(key)) throw new Error(`command ${command.commandId} is already recorded`);
    this.commands.set(key, command);
  }

  putArtifactText(runId: string, artifactVersionId: string, text: string) {
    const key = `${runId}\u0000${artifactVersionId}`;
    if (this.artifacts.has(key))
      throw new Error(`artifact version ${artifactVersionId} is immutable`);
    this.artifacts.set(key, text);
  }

  getRun(runId: string) {
    return this.runs.get(runId) ?? null;
  }

  /** Newest first. */
  listRuns(): RunSummary[] {
    return [...this.runs.values()].reverse().map((run) => ({
      runId: run.runId,
      status: run.projection.status,
      corralId: run.snapshot.definition.id,
      startedAt: run.snapshot.startedAt,
      projectId: null,
      sessionId: run.sessionId ?? null,
    }));
  }

  readEvents(runId: string, afterSeq: number, limit = Number.POSITIVE_INFINITY) {
    return (this.events.get(runId) ?? []).slice(afterSeq, afterSeq + limit);
  }

  getCommand(scope: string, commandId: string) {
    return this.commands.get(`${scope}\u0000${commandId}`) ?? null;
  }

  getArtifactText(runId: string, artifactVersionId: string) {
    return this.artifacts.get(`${runId}\u0000${artifactVersionId}`) ?? null;
  }
}
