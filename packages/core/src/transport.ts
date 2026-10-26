import type {
  CorralDefinition,
  CreateRunRequest,
  Receipt,
  RunCommand,
  RunEvent,
  StartRunRequest,
  StreamFrame,
} from '@corral/contracts';
import type { Coordinator, StartRunResult } from './coordinator.ts';
import { applyEvent, type RunProjection } from './projection.ts';
import type { RunSummary } from './store/run-store.ts';

// The only way Studio talks to a runtime. HttpSseTransport and the
// public demo implement the same contract.

export interface TransportHandlers {
  onEvent(event: RunEvent): void;
  /** The subscription stopped (handler threw, connection lost); re-read a snapshot. */
  onError?(error: unknown): void;
  onFrame?(frame: StreamFrame): void;
}

export interface RuntimeTransport {
  startRun(request: StartRunRequest | CreateRunRequest): Promise<StartRunResult>;
  sendCommand(command: RunCommand): Promise<Receipt>;
  getReceipt(runId: string, commandId: string): Promise<Receipt | null>;
  getSnapshot(runId: string): Promise<{ projection: RunProjection; seq: number }>;
  getArtifactText(runId: string, artifactVersionId: string): Promise<string | null>;
  /** Newest first (run history). */
  listRuns(): Promise<RunSummary[]>;
  /** The definition a run was started with (its snapshot), or null for an unknown run. */
  getRunDefinition(runId: string): Promise<CorralDefinition | null>;
  /** Every committed event after `afterSeq`, once and in order, then live events. */
  subscribe(runId: string, afterSeq: number, handlers: TransportHandlers): () => void;
}

/** Runs the coordinator in the same JS realm (P0 vertical slice, browser demo). */
export class InProcessTransport implements RuntimeTransport {
  private readonly coordinator: Coordinator;

  constructor(coordinator: Coordinator) {
    this.coordinator = coordinator;
  }

  async startRun(request: StartRunRequest | CreateRunRequest): Promise<StartRunResult> {
    return this.coordinator.startRun(request);
  }

  async sendCommand(command: RunCommand): Promise<Receipt> {
    return this.coordinator.submit(command);
  }

  async getReceipt(runId: string, commandId: string): Promise<Receipt | null> {
    return this.coordinator.getReceipt(runId, commandId);
  }

  async getSnapshot(runId: string): Promise<{ projection: RunProjection; seq: number }> {
    return this.coordinator.getSnapshot(runId);
  }

  async getArtifactText(runId: string, artifactVersionId: string): Promise<string | null> {
    return this.coordinator.getArtifactText(runId, artifactVersionId);
  }

  async listRuns(): Promise<RunSummary[]> {
    return this.coordinator.listRuns();
  }

  async getRunDefinition(runId: string): Promise<CorralDefinition | null> {
    return this.coordinator.getRunSnapshot(runId)?.definition ?? null;
  }

  subscribe(runId: string, afterSeq: number, handlers: TransportHandlers): () => void {
    return this.coordinator.subscribe(
      runId,
      afterSeq,
      (event) => handlers.onEvent(event),
      (error) => handlers.onError?.(error),
      handlers.onFrame ? (frame) => handlers.onFrame?.(frame) : undefined,
    );
  }
}

/** Resolves with the first projection (snapshot, then live) that satisfies `predicate`. */
export async function waitForProjection(
  transport: RuntimeTransport,
  runId: string,
  predicate: (projection: RunProjection) => boolean,
): Promise<RunProjection> {
  const { projection, seq } = await transport.getSnapshot(runId);
  if (predicate(projection)) return projection;
  return new Promise((resolve, reject) => {
    let current = projection;
    let done = false;
    let unsubscribe: (() => void) | undefined;
    unsubscribe = transport.subscribe(runId, seq, {
      onEvent(event) {
        if (done) return;
        current = applyEvent(current, event);
        if (predicate(current)) {
          done = true;
          unsubscribe?.();
          resolve(current);
        }
      },
      onError(error) {
        if (done) return;
        done = true;
        unsubscribe?.();
        reject(error);
      },
    });
    if (done) unsubscribe();
  });
}
