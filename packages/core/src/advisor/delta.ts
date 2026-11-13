import {
  type RunEvent,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import type { RunProjection } from '../projection.ts';

// The advisor's review input (docs/specs/features/advisor.md, 계약): the answers and tool rows the
// watched execution produced after the advisor's cursor. Pure: everything it reads is passed in,
// and it reads only what the public record shows on screen, never raw arguments or payloads.
// Lengths are UTF-16 code units (`string.length`), the unit of the model-input text limits.

/** Answer text kept per model call. */
export const REVIEW_ANSWER_MAX_LENGTH = 6_000;
/** The whole review input. */
export const REVIEW_INPUT_MAX_LENGTH = 24_000;
/** The task input of the first review, so it never crowds out the calls. */
const TASK_INPUT_MAX_LENGTH = 6_000;
/** A tool row's target and summary are one line each, at most this long. */
const FIELD_MAX_LENGTH = 200;
/** The validated arguments a tool row's target may come from, in the order screens use. */
const TARGET_KEYS = ['path', 'command', 'pattern', 'url', 'artifactVersionId', 'targetNodeId'];
const SETTLED = new Set(['finished', 'failed', 'blocked', 'cancelled', 'unfinished']);

/**
 * What the advisor has read of one execution: the last model call read (its id and its 1-based
 * position among the execution's calls) and the run sequence up to which tool calls were read.
 */
export interface ReviewCursor {
  modelCallId: string;
  no: number;
  seq: number;
}

/** The projection fields the review input reads. */
export type ReviewRun = Pick<
  RunProjection,
  'status' | 'executions' | 'modelCalls' | 'modelProfiles' | 'artifacts' | 'toolCalls' | 'effects'
>;

export interface ReviewInputSource {
  run: ReviewRun;
  /** The Run's committed events in order; tool names, targets and call order come from here. */
  events: readonly RunEvent[];
  executionId: string;
  /** `null` before the first review, otherwise the cursor the previous review returned. */
  cursor: ReviewCursor | null;
  /** The task text the watched execution was given; read only by the first review. */
  taskInput: string | null;
  /** A recorded response body, or null once it was released. */
  readResponse: (ref: string) => string | null;
  /** Streamed text of calls without a confirmed response, by model call id. */
  partialOutputs?: Readonly<Record<string, { text: string }>>;
}

export interface ReviewInput {
  text: string;
  cursor: ReviewCursor | null;
  /** Model calls whose answer is in the text. */
  calls: number;
  /** Tool summaries left out to fit the total. */
  trimmed: number;
}

interface ToolRow {
  line: string;
  summary: string | null;
}

interface Group {
  /** The call's header and answer; null when the answer was read by an earlier review. */
  head: string;
  body: string | null;
  answered: boolean;
  rows: ToolRow[];
}

export function buildReviewInput(source: ReviewInputSource): ReviewInput {
  const { run, executionId, cursor } = source;
  const none: ReviewInput = { text: '', cursor, calls: 0, trimmed: 0 };
  const execution = run.executions[executionId];
  if (!execution) return none;
  const ids = execution.modelCallIds;
  const ended =
    TERMINAL_EXECUTION_STATUSES.has(execution.status) || TERMINAL_RUN_STATUSES.has(run.status);

  // Calls are read in order up to the first one that is still open.
  const start = cursor ? resumeIndex(ids, cursor) : 0;
  let end = start;
  while (end < ids.length && closed(run, ids, end, ended)) end++;
  const lastRead = end - 1;

  // Tool rows after the cursor's sequence, each under the call that asked for it, up to the first
  // one that has not settled (it is read once it settles, so no row is read twice or lost).
  const position = new Map(ids.map((id, index) => [id, index]));
  const after = cursor?.seq ?? 0;
  const rows = new Map<number, ToolRow[]>();
  let current = -1;
  let seq = after;
  let held = false;
  for (const event of source.events) {
    if (event.runSeq > seq && !held) seq = event.runSeq;
    if (event.type === 'model.request_prepared' && event.payload.executionId === executionId) {
      current = position.get(event.payload.modelCallId) ?? current;
      continue;
    }
    if (held || event.type !== 'tool.requested' || event.payload.executionId !== executionId)
      continue;
    if (event.runSeq <= after || event.actor.kind === 'runtime' || current < 0) continue;
    const status = toolStatus(run, event.payload.toolCallId, ended);
    if (current > lastRead || !SETTLED.has(status)) {
      held = true;
      seq = event.runSeq - 1;
      continue;
    }
    const list = rows.get(current) ?? [];
    list.push(toolRow(run, event, status));
    rows.set(current, list);
  }

  if (end === start && rows.size === 0) return none;

  const groups: Group[] = [];
  for (let index = 0; index <= lastRead; index++) {
    const answered = index >= start;
    if (!answered && !rows.has(index)) continue;
    groups.push({ ...answer(source, ids, index, answered), answered, rows: rows.get(index) ?? [] });
  }
  // Rows exist only under calls already read, so a review with no new call has a cursor.
  const last = ids[lastRead];
  if (!last) return none;
  const next: ReviewCursor = { modelCallId: last, no: end, seq };
  const task = cursor === null ? taskBlock(source.taskInput) : null;
  return { ...fit(task, groups), cursor: next };
}

function resumeIndex(ids: readonly string[], cursor: ReviewCursor): number {
  const index = ids.indexOf(cursor.modelCallId);
  return index >= 0 ? index + 1 : Math.min(cursor.no, ids.length);
}

/** A call is done for review once it finished, a later call followed it, or the execution ended. */
function closed(run: ReviewRun, ids: readonly string[], index: number, ended: boolean): boolean {
  const id = ids[index];
  return (!!id && run.modelCalls[id]?.finished === true) || index < ids.length - 1 || ended;
}

function answer(
  source: ReviewInputSource,
  ids: readonly string[],
  index: number,
  answered: boolean,
): { head: string; body: string | null } {
  const id = ids[index] ?? '';
  const call = source.run.modelCalls[id];
  const profile = call?.profile ?? source.run.executions[source.executionId]?.modelProfile ?? '';
  const model = oneLine(source.run.modelProfiles[profile]?.modelId ?? profile);
  const head = `Request ${index + 1} · model ${model}`;
  if (!answered) return { head: `${head} · answer read earlier`, body: null };
  const confirmed = call?.finished === true && !call.interrupted;
  const ref = call?.responseRef ?? null;
  if (confirmed) {
    if (!ref) return { head, body: null };
    const text = source.readResponse(ref);
    return { head, body: text === null ? '(response text no longer available)' : capAnswer(text) };
  }
  // Interrupted or failed: no confirmed response, only what was streamed or recorded as cut.
  if (ref) {
    const text = source.readResponse(ref);
    return {
      head: `${head} · interrupted`,
      body: text === null ? '(response text no longer available)' : capAnswer(text),
    };
  }
  const partial = source.partialOutputs?.[id]?.text;
  return partial
    ? { head: `${head} · interrupted`, body: capAnswer(partial) }
    : { head: `${head} · no confirmed response`, body: null };
}

function toolStatus(run: ReviewRun, toolCallId: string, ended: boolean): string {
  const call = run.toolCalls[toolCallId];
  if (call?.status === 'blocked') return 'blocked';
  const effect = call?.effectId ? run.effects[call.effectId] : undefined;
  if (effect?.outcome === 'cancelled') return 'cancelled';
  if (call?.phase === 'finished' || call?.phase === 'failed') return call.phase;
  if (ended) return 'unfinished';
  return call?.phase ?? 'requested';
}

function toolRow(
  run: ReviewRun,
  event: Extract<RunEvent, { type: 'tool.requested' }>,
  status: string,
): ToolRow {
  const call = run.toolCalls[event.payload.toolCallId];
  const target = targetOf(run, event.payload.validatedArgs, call?.resultRef ?? null);
  const fields = [oneLine(event.payload.name), ...(target ? [target] : []), status];
  const summary = call?.reason ? oneLine(call.reason) : null;
  return { line: `- ${fields.join(' · ')}`, summary: summary || null };
}

/** The target screens show: the first string among the known keys, or the version written. */
function targetOf(
  run: ReviewRun,
  args: Record<string, unknown>,
  resultRef: string | null,
): string | null {
  for (const key of TARGET_KEYS) {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    return run.artifacts[value] ? artifactLabel(run, value) : oneLine(value);
  }
  return resultRef && run.artifacts[resultRef] ? artifactLabel(run, resultRef) : null;
}

function artifactLabel(run: ReviewRun, id: string): string {
  const artifact = run.artifacts[id];
  if (!artifact) return oneLine(id);
  return oneLine(`${artifact.name.split('\n')[0] ?? artifact.name} v${artifact.version}`);
}

function taskBlock(taskInput: string | null): string | null {
  if (!taskInput?.trim()) return null;
  return `Task input:\n${cap(taskInput, TASK_INPUT_MAX_LENGTH)}`;
}

/** Shortens summaries from the oldest call, then drops whole oldest calls, until it fits. */
function fit(task: string | null, groups: readonly Group[]): Omit<ReviewInput, 'cursor'> {
  const summaries = groups.flatMap((group) => group.rows.filter((row) => row.summary !== null));
  const cut = new Set<ToolRow>();
  let dropped = 0;
  const render = () => {
    const notes = [
      ...(cut.size
        ? [`Note: ${cut.size} tool ${cut.size === 1 ? 'summary' : 'summaries'} left out to fit.`]
        : []),
      ...(dropped
        ? [`Note: ${dropped} oldest ${dropped === 1 ? 'request' : 'requests'} left out to fit.`]
        : []),
    ];
    const blocks = groups.slice(dropped).map((group) => {
      const lines = [group.head];
      if (group.body !== null) lines.push(group.body);
      if (group.rows.length) {
        lines.push('Tools:');
        for (const row of group.rows)
          lines.push(row.summary && !cut.has(row) ? `${row.line} · ${row.summary}` : row.line);
      }
      return lines.join('\n');
    });
    return [...(notes.length ? [notes.join('\n')] : []), ...(task ? [task] : []), ...blocks].join(
      '\n\n',
    );
  };
  let text = render();
  while (text.length > REVIEW_INPUT_MAX_LENGTH) {
    const next = summaries[cut.size];
    if (next) cut.add(next);
    else if (dropped < groups.length) dropped++;
    else break;
    text = render();
  }
  const calls = groups.slice(dropped).filter((group) => group.answered).length;
  return { text, calls, trimmed: cut.size };
}

function capAnswer(text: string): string {
  return text ? cap(text, REVIEW_ANSWER_MAX_LENGTH) : '(empty response)';
}

/** Keeps `max` code units and says how many were left out; never splits a surrogate pair. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = cutAt(text, max);
  return `${text.slice(0, end)}\n[... ${text.length - end} more characters left out]`;
}

function oneLine(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length <= FIELD_MAX_LENGTH
    ? line
    : `${line.slice(0, cutAt(line, FIELD_MAX_LENGTH - 1))}…`;
}

function cutAt(text: string, max: number): number {
  return /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
}
