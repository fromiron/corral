import {
  type ReasoningResolution,
  type ReasoningWire,
  type RunEvent,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import { canReadArtifactBody, type RunProjection } from '@corral/core';
import type { StreamText } from './session.ts';

// One execution's conversation, in commit order (roadmap UX-A3). Built only from committed
// events, the projection and streamed text; an instruction appears on the request it actually
// reached, never on an earlier one.

export type TranscriptEntry =
  | { kind: 'started'; seq: number; nodeId: string; attemptNo: number; round: number | null }
  | {
      kind: 'instruction';
      seq: number;
      directiveId: string;
      text: string;
      status: RunProjection['directives'][string]['status'] | 'accepted';
    }
  | {
      kind: 'request';
      reasoning?: ReasoningResolution;
      reasoningWire?: ReasoningWire;
      seq: number;
      modelCallId: string;
      no: number;
      directives: { directiveId: string; text: string }[];
      effort: { provider: string; answer: string | null; status: string }[];
    }
  | {
      kind: 'reply';
      seq: number;
      modelCallId: string;
      /** The request this reply answers, counted per execution like `request.no`. */
      no: number;
      text: string;
      live: boolean;
      broken: boolean;
      /** The recorded response exists, but its body is no longer retained for reading. */
      bodyReleased: boolean;
    }
  | {
      kind: 'tool';
      seq: number;
      toolCallId: string;
      name: string;
      status: 'requested' | 'allowed' | 'blocked' | 'finished' | 'failed';
      detail: string | null;
      resultRef: string | null;
      /** The validated arguments as recorded; large values are already size-and-hash stubs. */
      args: Record<string, unknown>;
      /** Recorded time of `tool.started`, when the call was observed to start. */
      startedAt?: string;
      /** From `tool.started` to `tool.finished`, only when both were recorded. */
      latencyMs?: number;
    }
  | {
      kind: 'question';
      seq: number;
      questionId: string;
      targetNodeId: string;
      body: string;
      status: RunProjection['questions'][string]['status'];
      answer: string | null;
    }
  | { kind: 'version'; seq: number; artifactVersionId: string; name: string; version: number }
  | { kind: 'settled'; seq: number; outcome: string; error: string | null };

export function buildTranscript(
  events: readonly RunEvent[],
  projection: RunProjection | null,
  streams: Record<string, StreamText>,
  executionId: string,
): TranscriptEntry[] {
  if (!projection?.executions[executionId]) return [];
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, Extract<TranscriptEntry, { kind: 'tool' }>>();
  const replies = new Map<string, Extract<TranscriptEntry, { kind: 'reply' }>>();
  let requests = 0;
  for (const event of events) {
    switch (event.type) {
      case 'execution.created':
        if (event.payload.executionId !== executionId) break;
        entries.push({
          kind: 'started',
          seq: event.runSeq,
          nodeId: event.payload.nodeId,
          attemptNo: event.payload.attemptNo,
          round: event.payload.iterationId
            ? (projection.iterations[event.payload.iterationId]?.no ?? null)
            : null,
        });
        break;
      case 'directive.accepted':
        if (event.payload.targetExecutionId !== executionId) break;
        entries.push({
          kind: 'instruction',
          seq: event.runSeq,
          directiveId: event.payload.directiveId,
          text: event.payload.text,
          status: projection.directives[event.payload.directiveId]?.status ?? 'accepted',
        });
        break;
      case 'model.request_prepared': {
        if (event.payload.executionId !== executionId) break;
        const call = event.payload.modelCallId;
        entries.push({
          kind: 'request',
          ...(event.payload.reasoning ? { reasoning: event.payload.reasoning } : {}),
          ...(projection.modelCalls[call]?.reasoningWire
            ? { reasoningWire: projection.modelCalls[call]!.reasoningWire! }
            : {}),
          seq: event.runSeq,
          modelCallId: call,
          no: ++requests,
          directives: event.payload.directiveIds.map((id) => ({
            directiveId: id,
            text: projection.directives[id]?.text ?? '',
          })),
          effort: Object.values(projection.decisions ?? {})
            .filter((d) => d.modelCallId === call)
            .map((d) => ({ provider: d.provider, answer: d.answer, status: d.status })),
        });
        // The reply follows its request, streaming until model.finished brings the final text.
        const stream = streams[call];
        const responseRef = projection.modelCalls[call]?.responseRef;
        const bodyReleased = Boolean(responseRef && !canReadArtifactBody(projection, responseRef));
        const reply = {
          kind: 'reply' as const,
          seq: event.runSeq,
          modelCallId: call,
          no: requests,
          text: bodyReleased ? '' : (stream?.text ?? ''),
          live:
            !projection.modelCalls[call]?.finished && !TERMINAL_RUN_STATUSES.has(projection.status),
          broken: stream?.broken ?? false,
          bodyReleased,
        };
        replies.set(call, reply);
        entries.push(reply);
        break;
      }
      case 'tool.requested': {
        if (event.payload.executionId !== executionId) break;
        const tool = toolEntry(event);
        tools.set(tool.toolCallId, tool);
        entries.push(tool);
        break;
      }
      case 'tool.allowed':
      case 'tool.blocked':
      case 'tool.started':
      case 'tool.finished': {
        const tool = tools.get(event.payload.toolCallId);
        if (tool) updateTool(tool, event);
        break;
      }
      case 'message.question_created': {
        if (event.payload.senderExecutionId !== executionId) break;
        const q = projection.questions[event.payload.questionId];
        entries.push({
          kind: 'question',
          seq: event.runSeq,
          questionId: event.payload.questionId,
          targetNodeId: event.payload.targetNodeId,
          body: event.payload.body,
          status: q?.status ?? 'open',
          answer: q?.answer?.body ?? null,
        });
        break;
      }
      case 'artifact.version_created':
        if (event.payload.authorExecutionId !== executionId) break;
        entries.push({
          kind: 'version',
          seq: event.runSeq,
          artifactVersionId: event.payload.artifactVersionId,
          name: event.payload.name,
          version: event.payload.version,
        });
        break;
      case 'execution.settled':
        if (event.payload.executionId !== executionId) break;
        entries.push({
          kind: 'settled',
          seq: event.runSeq,
          outcome: event.payload.outcome,
          error: event.payload.error ?? null,
        });
        break;
    }
  }
  return entries;
}

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>;
type ToolUpdate = Extract<
  RunEvent,
  { type: 'tool.allowed' | 'tool.blocked' | 'tool.started' | 'tool.finished' }
>;

function toolEntry(event: Extract<RunEvent, { type: 'tool.requested' }>): ToolEntry {
  return {
    kind: 'tool',
    seq: event.runSeq,
    toolCallId: event.payload.toolCallId,
    name: event.payload.name,
    status: 'requested',
    detail: null,
    resultRef: null,
    args: event.payload.validatedArgs,
  };
}

/** One tool lifecycle step, shared by the transcript and the per-execution activity list. */
function updateTool(tool: ToolEntry, event: ToolUpdate): void {
  switch (event.type) {
    case 'tool.allowed':
      tool.status = 'allowed';
      return;
    case 'tool.blocked':
      tool.status = 'blocked';
      tool.detail = event.payload.reason;
      return;
    case 'tool.started':
      tool.startedAt = event.recordedAt;
      return;
    case 'tool.finished':
      tool.status = event.payload.error ? 'failed' : 'finished';
      tool.detail = event.payload.error;
      tool.resultRef = event.payload.resultRef;
      if (tool.startedAt)
        tool.latencyMs = Math.max(0, Date.parse(event.recordedAt) - Date.parse(tool.startedAt));
  }
}

/**
 * Every execution's tool calls in one pass over the record, in request order, with the same
 * lifecycle as the transcript. The activity list reads this instead of a transcript per execution.
 */
export function executionToolEntries(events: readonly RunEvent[]): Map<string, ToolEntry[]> {
  const calls = new Map<string, ToolEntry>();
  const byExecution = new Map<string, ToolEntry[]>();
  for (const event of events) {
    if (event.type === 'tool.requested') {
      const tool = toolEntry(event);
      calls.set(tool.toolCallId, tool);
      const list = byExecution.get(event.payload.executionId) ?? [];
      list.push(tool);
      byExecution.set(event.payload.executionId, list);
    } else if (
      event.type === 'tool.allowed' ||
      event.type === 'tool.blocked' ||
      event.type === 'tool.started' ||
      event.type === 'tool.finished'
    ) {
      const tool = calls.get(event.payload.toolCallId);
      if (tool) updateTool(tool, event);
    }
  }
  return byExecution;
}
