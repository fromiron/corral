import type { ExecutionActivity, ExecutionStatus, RunEvent } from '@corral/contracts';
import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import { applyEvent, emptyProjection, ProjectionGapError, type RunProjection } from '@corral/core';
import type { StreamText } from './session.ts';

export interface RunHistory {
  projection: RunProjection;
  events: RunEvent[];
  status: 'ready' | 'loading' | 'gap';
  gap: { expectedSeq: number; receivedSeq: number } | null;
}

/** Rebuild only the contiguous prefix; the live store and its records remain untouched. */
export function reconstructRunHistory(
  runId: string,
  events: readonly RunEvent[],
  atSeq: number,
): RunHistory {
  if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new RangeError('invalid history cursor');
  let projection = emptyProjection(runId);
  const prefix: RunEvent[] = [];
  for (const event of events) {
    if (projection.lastSeq === atSeq) break;
    if (event.runId !== runId) throw new Error('history event belongs to another run');
    try {
      const next = applyEvent(projection, event);
      if (next === projection) continue;
      projection = next;
      prefix.push(event);
    } catch (error) {
      if (!(error instanceof ProjectionGapError)) throw error;
      return {
        projection,
        events: prefix,
        status: 'gap',
        gap: { expectedSeq: error.expectedSeq, receivedSeq: error.receivedSeq },
      };
    }
  }
  return {
    projection,
    events: prefix,
    status: projection.lastSeq === atSeq ? 'ready' : 'loading',
    gap: null,
  };
}

export interface ExecutionSegment {
  status: ExecutionStatus;
  activity: ExecutionActivity | null;
  startSeq: number;
  endSeq: number;
  startedAt: string;
  endedAt: string;
}

export interface ObservedCallDuration {
  kind: 'model' | 'tool';
  callId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface ExecutionInterval {
  executionId: string;
  nodeId: string;
  taskId: string;
  attemptNo: number;
  iterationId: string | null;
  status: ExecutionStatus;
  activity: ExecutionActivity | null;
  startSeq: number;
  endSeq: number;
  startedAt: string;
  endedAt: string;
  finished: boolean;
  segments: ExecutionSegment[];
  calls: ObservedCallDuration[];
}

type CallStart = { executionId: string; startedAt: string };

/** Time spans from a contiguous event prefix, never wall time or predicted completion. */
export function executionIntervals(events: readonly RunEvent[]): ExecutionInterval[] {
  const rows = new Map<string, ExecutionInterval>();
  const reservedModels = new Map<string, string>();
  const modelEffects = new Map<string, { callId: string; executionId: string }>();
  const modelStarts = new Map<string, CallStart>();
  const toolStarts = new Map<string, CallStart>();
  const close = (row: ExecutionInterval, event: RunEvent) => {
    row.endedAt = event.recordedAt;
    row.endSeq = event.runSeq;
    const segment = row.segments.at(-1);
    if (segment) {
      segment.endedAt = event.recordedAt;
      segment.endSeq = event.runSeq;
    }
  };
  const finishCall = (
    kind: 'model' | 'tool',
    callId: string,
    executionId: string,
    start: CallStart | undefined,
    endedAt: string,
  ) => {
    if (!start || start.executionId !== executionId) return;
    const durationMs = Date.parse(endedAt) - Date.parse(start.startedAt);
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    rows
      .get(executionId)
      ?.calls.push({ kind, callId, startedAt: start.startedAt, endedAt, durationMs });
  };
  for (const event of events) {
    switch (event.type) {
      case 'execution.created': {
        const p = event.payload;
        const segment: ExecutionSegment = {
          status: 'queued',
          activity: null,
          startSeq: event.runSeq,
          endSeq: event.runSeq,
          startedAt: event.recordedAt,
          endedAt: event.recordedAt,
        };
        rows.set(p.executionId, {
          executionId: p.executionId,
          nodeId: p.nodeId,
          taskId: p.taskId,
          attemptNo: p.attemptNo,
          iterationId: p.iterationId,
          ...segment,
          finished: false,
          segments: [segment],
          calls: [],
        });
        break;
      }
      case 'execution.state_changed': {
        const row = rows.get(event.payload.executionId);
        if (!row || row.finished) break;
        close(row, event);
        row.status = event.payload.to;
        row.activity = event.payload.activity;
        row.finished = TERMINAL_EXECUTION_STATUSES.has(row.status);
        if (!row.finished)
          row.segments.push({
            status: row.status,
            activity: row.activity,
            startSeq: event.runSeq,
            endSeq: event.runSeq,
            startedAt: event.recordedAt,
            endedAt: event.recordedAt,
          });
        break;
      }
      case 'execution.settled': {
        const row = rows.get(event.payload.executionId);
        if (!row || row.finished) break;
        close(row, event);
        row.status = event.payload.outcome;
        row.activity = null;
        row.finished = true;
        break;
      }
      case 'budget.reserved':
        if (event.payload.modelCallId)
          reservedModels.set(event.payload.reservationId, event.payload.modelCallId);
        break;
      case 'effect.admitted': {
        const p = event.payload;
        const callId = p.reservationId ? reservedModels.get(p.reservationId) : undefined;
        if (p.kind === 'model_request' && callId)
          modelEffects.set(p.effectId, { callId, executionId: p.scope });
        break;
      }
      case 'effect.dispatch_observed': {
        const model = modelEffects.get(event.payload.effectId);
        if (model)
          modelStarts.set(model.callId, {
            executionId: model.executionId,
            startedAt: event.recordedAt,
          });
        break;
      }
      case 'model.finished': {
        const { modelCallId, executionId } = event.payload;
        finishCall(
          'model',
          modelCallId,
          executionId,
          modelStarts.get(modelCallId),
          event.recordedAt,
        );
        modelStarts.delete(modelCallId);
        break;
      }
      case 'tool.started':
        toolStarts.set(event.payload.toolCallId, {
          executionId: event.payload.executionId,
          startedAt: event.recordedAt,
        });
        break;
      case 'tool.finished': {
        const { toolCallId, executionId } = event.payload;
        finishCall('tool', toolCallId, executionId, toolStarts.get(toolCallId), event.recordedAt);
        toolStarts.delete(toolCallId);
        break;
      }
    }
  }
  const horizon = events.at(-1);
  if (horizon) for (const row of rows.values()) if (!row.finished) close(row, horizon);
  return [...rows.values()];
}

/** A cached answer is visible only after this prefix commits its immutable response. */
export function historicalStreams(
  projection: RunProjection,
  streams: Readonly<Record<string, StreamText>>,
): Record<string, StreamText> {
  return Object.fromEntries(
    Object.values(projection.modelCalls).flatMap((call) => {
      const stream = streams[call.modelCallId];
      return call.finished && call.responseRef && stream?.completed
        ? [[call.modelCallId, stream]]
        : [];
    }),
  );
}
