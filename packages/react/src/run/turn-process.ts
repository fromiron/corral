import { type RunEvent, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { ModelCallView, RunProjection } from '@corral/core';
import type { StreamText } from './session.ts';
import { buildTranscript, type TranscriptEntry } from './transcript.ts';

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>;
export interface ProcessSource {
  id: string;
  label: string;
}
export type ModelProcessPhase =
  | 'preparing'
  | 'generating'
  | 'finished'
  | 'waiting'
  | 'paused'
  | 'pausing'
  | 'failed'
  | 'cancelled'
  | 'cancelling'
  | 'unconfirmed';
interface ProcessState {
  active: boolean;
  sources: ProcessSource[];
}
export type ProcessRow =
  | (ProcessState & {
      kind: 'model';
      id: string;
      no: number;
      model: string | null;
      phase: ModelProcessPhase;
      state: string;
      call: Pick<ModelCallView, 'reasoning' | 'reasoningWire'>;
    })
  | (ProcessState &
      ToolEntry & {
        id: string;
        target: string | null;
        /** The exact version a read names, when the record has it. */
        artifact?: { name: string; version: number };
      })
  | (ProcessState & {
      kind: 'agent';
      id: string;
      label: string;
      status: string;
      tools: ToolEntry[];
    });

export interface TurnProcess {
  rows: ProcessRow[];
  steps: number;
  startedAt: string | null;
  endedAt: string | null;
  /** The run is not terminal; waiting and paused are still open runs. */
  running: boolean;
  /** Observed work eligible for active motion, separate from an open run. */
  active: boolean;
}

const PUBLISHING = new Set(['write_artifact', 'submit_result']);
const TARGETS = ['path', 'command', 'pattern', 'url', 'artifactVersionId', 'targetNodeId'];
function targetOf(args: Record<string, unknown>): string | null {
  for (const key of TARGETS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
function activeExecution(projection: RunProjection, id: string): boolean {
  return projection.status === 'running' && projection.executions[id]?.status === 'active';
}
function modelPhase(
  projection: RunProjection,
  executionId: string,
  modelCallId: string,
  dispatched: ReadonlySet<string>,
): ModelProcessPhase {
  const call = projection.modelCalls[modelCallId];
  const execution = projection.executions[executionId];
  if (call?.finished) return 'finished';
  if (execution?.status === 'cancelled' || projection.status === 'cancelled') return 'cancelled';
  if (execution?.status === 'cancelling' || projection.status === 'cancelling') return 'cancelling';
  if (
    execution?.status === 'failed' ||
    projection.status === 'failed' ||
    projection.status === 'interrupted'
  )
    return 'failed';
  if (execution?.status === 'paused' || projection.status === 'paused') return 'paused';
  if (execution?.status === 'pausing' || projection.status === 'pausing') return 'pausing';
  if (execution?.status === 'succeeded' || projection.status === 'succeeded') return 'unconfirmed';
  if (!activeExecution(projection, executionId)) return 'waiting';
  return dispatched.has(modelCallId) ? 'generating' : 'preparing';
}

/** A post-send process contains observed request/tool facts, never inferred reasoning text. */
export function buildTurnProcess(
  events: readonly RunEvent[],
  projection: RunProjection | null,
  _streams: Record<string, StreamText>,
  label: (nodeId: string) => string,
): TurnProcess {
  const running = !projection || !TERMINAL_RUN_STATUSES.has(projection.status);
  const rows: ProcessRow[] = [];
  const lead = projection?.executionOrder[0];
  if (projection && lead) {
    const requested = new Map<string, RunEvent>();
    const toolOwners = new Map<string, string>();
    const executionEvents = new Map<string, RunEvent[]>();
    // Partition once: a large team should not rescan every other execution's event log.
    for (const event of events) {
      let owner: string | undefined;
      if (event.type === 'model.request_prepared') owner = event.payload.executionId;
      else if (event.type === 'tool.requested') {
        owner = event.payload.executionId;
        toolOwners.set(event.payload.toolCallId, owner);
        requested.set(event.payload.toolCallId, event);
      } else if (
        event.type === 'tool.allowed' ||
        event.type === 'tool.blocked' ||
        event.type === 'tool.started' ||
        event.type === 'tool.finished'
      )
        owner = toolOwners.get(event.payload.toolCallId);
      if (owner) {
        const owned = executionEvents.get(owner) ?? [];
        owned.push(event);
        executionEvents.set(owner, owned);
      }
    }
    const dispatched = new Set(
      Object.values(projection.effects).flatMap((effect) =>
        effect.kind === 'model_request' && effect.dispatched && effect.reservationId
          ? [effect.reservationId]
          : [],
      ),
    );
    const authored = new Map<string, string[]>();
    for (const artifact of Object.values(projection.artifacts)) {
      const ids = authored.get(artifact.authorExecutionId) ?? [];
      ids.push(artifact.artifactVersionId);
      authored.set(artifact.authorExecutionId, ids);
    }
    const visibleTool = (entry: TranscriptEntry): entry is ToolEntry =>
      entry.kind === 'tool' &&
      !PUBLISHING.has(entry.name) &&
      requested.get(entry.toolCallId)?.actor.kind !== 'runtime';
    const sources = (ids: readonly string[]): ProcessSource[] =>
      [...new Set(ids)].flatMap((id) => {
        const artifact = projection.artifacts[id];
        return artifact ? [{ id, label: artifact.name }] : [];
      });
    const entries = buildTranscript(executionEvents.get(lead) ?? [], projection, {}, lead);
    for (const entry of entries) {
      if (entry.kind === 'request') {
        const call = projection.modelCalls[entry.modelCallId];
        const phase = modelPhase(projection, lead, entry.modelCallId, dispatched);
        const profile = call?.profile ?? projection.executions[lead]?.modelProfile;
        rows.push({
          kind: 'model',
          id: entry.modelCallId,
          no: entry.no,
          phase,
          state:
            projection.status === 'running'
              ? (projection.executions[lead]?.status ?? projection.status)
              : projection.status,
          active: phase === 'preparing' || phase === 'generating',
          model: profile ? (projection.modelProfiles[profile]?.modelId ?? profile) : null,
          call: {
            ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
            ...(entry.reasoningWire ? { reasoningWire: entry.reasoningWire } : {}),
          },
          sources: sources(call?.inputArtifactVersionIds ?? []),
        });
      } else if (visibleTool(entry)) {
        const target = targetOf(entry.args);
        const read =
          entry.name === 'read_artifact' && target ? projection.artifacts[target] : undefined;
        const references = sources([
          ...(typeof entry.args.artifactVersionId === 'string'
            ? [entry.args.artifactVersionId]
            : []),
          ...(entry.resultRef ? [entry.resultRef] : []),
        ]);
        rows.push({
          ...entry,
          id: entry.toolCallId,
          target,
          ...(read
            ? { artifact: { name: read.name.split('\n')[0] ?? read.name, version: read.version } }
            : {}),
          active:
            activeExecution(projection, lead) &&
            (entry.status === 'requested' || entry.status === 'allowed'),
          sources: references,
        });
      }
    }
    for (const id of projection.executionOrder.slice(1)) {
      const execution = projection.executions[id];
      if (!execution) continue;
      rows.push({
        kind: 'agent',
        id,
        label: label(execution.nodeId),
        status: execution.status,
        active: activeExecution(projection, id),
        tools: buildTranscript(executionEvents.get(id) ?? [], projection, {}, id).filter(
          visibleTool,
        ),
        sources: sources(authored.get(id) ?? []),
      });
    }
  }
  return {
    rows,
    // Preserve the existing task-step statistic: tools and other executions, not model requests.
    steps: rows.filter((row) => row.kind !== 'model').length,
    startedAt: projection?.startedAt ?? events[0]?.recordedAt ?? null,
    endedAt: running ? null : (projection?.endedAt ?? events.at(-1)?.recordedAt ?? null),
    running,
    active: rows.some((row) => row.active),
  };
}

/** The folded header reads the same tool/agent count from the committed projection. */
export function turnSummary(
  projection: RunProjection,
): Pick<TurnProcess, 'steps' | 'startedAt' | 'endedAt' | 'running' | 'active'> {
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
    active: projection.executionOrder.some((id) => activeExecution(projection, id)),
  };
}
