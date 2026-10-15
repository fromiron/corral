import type {
  Receipt,
  RunCommand,
  RunEvent,
  StartRunRequest,
  StreamFrame,
} from '@corral/contracts';
import type { InMemoryCoordinator, StartRunResult } from './coordinator.ts';
import { applyEvent, type RunProjection } from './projection.ts';

// The only way Studio talks to a runtime (ADR-016). HttpSseTransport (C-015) and the
// public demo implement the same contract.

export interface TransportHandlers {
  onEvent(event: RunEvent): void;
  /** The subscription stopped (handler threw, connection lost); re-read a snapshot. */
  onError?(error: unknown): void;
  onFrame?(frame: StreamFrame): void;
}

export interface RuntimeTransport {
  startRun(request: StartRunRequest): Promise<StartRunResult>;
  sendCommand(command: RunCommand): Promise<Receipt>;
  getReceipt(runId: string, commandId: string): Promise<Receipt | null>;
  getSnapshot(runId: string): Promise<{ projection: RunProjection; seq: number }>;
  getArtifactText(runId: string, artifactVersionId: string): Promise<string | null>;
  /** Every committed event after `afterSeq`, once and in order, then live events. */
  subscribe(runId: string, afterSeq: number, handlers: TransportHandlers): () => void;
}

/** Runs the coordinator in the same JS realm (P0 vertical slice, browser demo). */
export class InProcessTransport implements RuntimeTransport {
  private readonly coordinator: InMemoryCoordinator;

  constructor(coordinator: InMemoryCoordinator) {
    this.coordinator = coordinator;
  }

  async startRun(request: StartRunRequest): Promise<StartRunResult> {
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

  subscribe(runId: string, afterSeq: number, handlers: TransportHandlers): () => void {
    return this.coordinator.subscribe(
      runId,
      afterSeq,
      (event) => handlers.onEvent(event),
      (error) => handlers.onError?.(error),
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
    const unsubscribe = transport.subscribe(runId, seq, {
      onEvent(event) {
        if (done) return;
        current = applyEvent(current, event);
        if (predicate(current)) {
          done = true;
          unsubscribe();
          resolve(current);
        }
      },
      onError: reject,
    });
  });
}
