import { type RunEvent, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import type { StreamText } from './session.ts';

// a chat turn's process as one flat list of one-line rows (DSH-style), built from
// committed events, the projection and streamed text. The answer is never a row: it is the
// reply that ended the turn, shown below the process.

export type ProcessRow =
  | { kind: 'think'; id: string; text: string; live: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      target: string | null;
      status: 'requested' | 'allowed' | 'blocked' | 'finished' | 'failed';
    }
  | { kind: 'agent'; id: string; label: string; status: string };

export interface TurnProcess {
  rows: ProcessRow[];
  steps: number;
  startedAt: string | null;
  endedAt: string | null;
  running: boolean;
}

/** Tools that only publish a result; the answer below the process already shows it. */
const PUBLISHING = new Set(['write_artifact', 'submit_result']);
/** Argument keys that name what a tool worked on, in the order they are preferred. */
const TARGETS = ['path', 'command', 'pattern', 'url', 'artifactVersionId', 'targetNodeId'];
const MAX_TEXT = 120;

function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line;
}

function targetOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of TARGETS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return firstLine(value);
  }
  if (Array.isArray(record.tasks)) return String(record.tasks.length);
  return null;
}

export function buildTurnProcess(
  events: readonly RunEvent[],
  projection: RunProjection | null,
  streams: Record<string, StreamText>,
  label: (nodeId: string) => string,
): TurnProcess {
  const running = !projection || !TERMINAL_RUN_STATUSES.has(projection.status);
  const lead = projection?.executionOrder[0];
  const rows: ProcessRow[] = [];
  const tools = new Map<string, Extract<ProcessRow, { kind: 'tool' }>>();
  // The latest request of the lead whose reply has not yet been followed by a tool.
  let pendingReply: string | null = null;
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (payload.executionId !== lead) continue;
    switch (event.type) {
      case 'model.request_prepared':
        pendingReply = payload.modelCallId as string;
        break;
      case 'tool.requested': {
        const name = payload.name as string;
        if (event.actor.kind === 'runtime' || PUBLISHING.has(name)) break;
        // A reply that led to a tool call is thinking out loud, not the answer.
        const text = pendingReply ? firstLine(streams[pendingReply]?.text ?? '') : '';
        if (pendingReply && text)
          rows.push({
            kind: 'think',
            id: pendingReply,
            text,
            live: !projection?.modelCalls[pendingReply]?.finished && running,
          });
        pendingReply = null;
        const tool: Extract<ProcessRow, { kind: 'tool' }> = {
          kind: 'tool',
          id: payload.toolCallId as string,
          name,
          target: targetOf(payload.validatedArgs),
          status: 'requested',
        };
        tools.set(tool.id, tool);
        rows.push(tool);
        break;
      }
      case 'tool.allowed': {
        const tool = tools.get(payload.toolCallId as string);
        if (tool) tool.status = 'allowed';
        break;
      }
      case 'tool.blocked': {
        const tool = tools.get(payload.toolCallId as string);
        if (tool) tool.status = 'blocked';
        break;
      }
      case 'tool.finished': {
        const tool = tools.get(payload.toolCallId as string);
        if (tool) tool.status = payload.error ? 'failed' : 'finished';
        break;
      }
    }
  }
  // Every other execution (a delegate or a team role) is one row; its own work opens beside.
  for (const id of projection?.executionOrder.slice(1) ?? []) {
    const execution = projection?.executions[id];
    if (execution)
      rows.push({ kind: 'agent', id, label: label(execution.nodeId), status: execution.status });
  }
  return {
    rows,
    // Steps are the tools and agents a turn used; thinking rows accompany them.
    steps: rows.filter((row) => row.kind !== 'think').length,
    startedAt: projection?.startedAt ?? events[0]?.recordedAt ?? null,
    endedAt: running ? null : (projection?.endedAt ?? events.at(-1)?.recordedAt ?? null),
    running,
  };
}

/** The folded header of a turn whose events are not loaded: the same step count and times. */
export function turnSummary(
  projection: RunProjection,
): Pick<TurnProcess, 'steps' | 'startedAt' | 'endedAt' | 'running'> {
  const lead = projection.executionOrder[0];
  const tools = Object.values(projection.toolCalls).filter(
    (call) => call.executionId === lead && !PUBLISHING.has(call.name),
  ).length;
  const running = !TERMINAL_RUN_STATUSES.has(projection.status);
  return {
    steps: tools + Math.max(0, projection.executionOrder.length - 1),
    startedAt: projection.startedAt,
    endedAt: running ? null : projection.endedAt,
    running,
  };
}
