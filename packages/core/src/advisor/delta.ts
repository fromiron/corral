import {
  type RunEvent,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import type { RunProjection } from '../projection.ts';
import { redactCredentialsAndPaths } from '../redact.ts';

// The advisor's review input (docs/specs/features/advisor.md, 계약): the answers and tool rows the
// watched execution produced after the advisor's cursor. Pure: everything it reads is passed in,
// and it reads only what the public record shows on screen, never raw arguments or payloads.
// Lengths are UTF-16 code units (`string.length`), the unit of the model-input text limits.

/** Answer text kept per model call. */
export const REVIEW_ANSWER_MAX_LENGTH = 6_000;
/** The whole review input. */
export const REVIEW_INPUT_MAX_LENGTH = 24_000;
/** The task input of the first review. */
export const REVIEW_TASK_MAX_LENGTH = 6_000;
/** What an answer is shortened to when the whole input does not fit. */
export const REVIEW_SHORT_ANSWER_LENGTH = 500;
/** A tool row's target and summary are one line each, at most this long. */
const FIELD_MAX_LENGTH = 200;
/** The validated arguments a tool row's target may come from, in the order screens use. */
const TARGET_KEYS = ['path', 'command', 'pattern', 'url', 'artifactVersionId', 'targetNodeId'];
const SETTLED = new Set(['finished', 'failed', 'blocked', 'cancelled', 'unfinished']);
/** Request purposes that are not answers: they are neither read nor counted toward a review. */
const NOT_ANSWERS = new Set(['compaction', 'extension']);
const SEPARATOR = '\n\n'.length;

/**
 * What the advisor has read of one execution: the last model call passed and the run sequence up
 * to which tool calls were read. A cursor of another execution reads as no cursor.
 */
export interface ReviewCursor {
  modelCallId: string;
  seq: number;
}

/** The projection fields the review input reads. */
export type ReviewRun = Pick<
  RunProjection,
  'status' | 'executions' | 'modelCalls' | 'modelProfiles' | 'artifacts' | 'toolCalls' | 'effects'
>;

export interface ReviewInputSource {
  run: ReviewRun;
  /** The whole Run's committed events in order; tool names, targets and call order come from here. */
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
  /** The Run's workspace folders; tool targets and summaries show them as `[workspace]`. */
  workspaceRoots?: readonly string[];
}

export interface ReviewInput {
  text: string;
  cursor: ReviewCursor | null;
  /** Model calls whose answer is in the text. */
  calls: number;
  /** Tool summaries left out to fit the total. */
  trimmed: number;
  /** Oldest calls left out to fit the total; the cursor still passes them. */
  dropped: number;
}

/**
 * Whether a model call is an answer the advisor reads and counts toward its review interval:
 * compaction summaries and extension requests are not; turns, retries and unrecorded calls are.
 */
export function countsForReview(events: readonly RunEvent[], modelCallId: string): boolean {
  for (const event of events)
    if (
      event.type === 'model.request_recorded' &&
      event.payload.modelCallId === modelCallId &&
      NOT_ANSWERS.has(event.payload.purpose)
    )
      return false;
  return true;
}

interface ToolRow {
  line: string;
  summary: string | null;
}

interface Group {
  head: string;
  /** Answer text to cut, or a fixed body (a placeholder), or neither. */
  answer: string | null;
  fixed: string | null;
  answered: boolean;
  rows: ToolRow[];
}

export function buildReviewInput(source: ReviewInputSource): ReviewInput {
  const { run, executionId } = source;
  const none: ReviewInput = { text: '', cursor: source.cursor, calls: 0, trimmed: 0, dropped: 0 };
  const execution = run.executions[executionId];
  if (!execution) return none;
  const ids = execution.modelCallIds;
  const known = source.cursor ? ids.indexOf(source.cursor.modelCallId) : -1;
  // A cursor that names no call of this execution is not this execution's: read from the start.
  const cursor = known >= 0 ? source.cursor : null;
  const ended =
    TERMINAL_EXECUTION_STATUSES.has(execution.status) || TERMINAL_RUN_STATUSES.has(run.status);
  const roots = source.workspaceRoots ?? [];

  const skipped = new Set<string>();
  for (const event of source.events)
    if (event.type === 'model.request_recorded' && NOT_ANSWERS.has(event.payload.purpose))
      skipped.add(event.payload.modelCallId);

  // Calls are read in order up to the first one that is still open.
  const start = known + 1;
  let end = start;
  while (end < ids.length && closed(run, ids, end, ended)) end++;
  const lastRead = end - 1;

  // Tool rows after the cursor's sequence, each under the answer call before it, up to the first
  // one that has not settled (it is read once it settles, so no row is read twice or lost).
  const position = new Map(ids.map((id, index) => [id, index]));
  const after = cursor?.seq ?? 0;
  const rows = new Map<number, ToolRow[]>();
  let current = -1;
  let seq = after;
  let held = false;
  for (const event of source.events) {
    if (held) break;
    if (event.runSeq > seq) seq = event.runSeq;
    if (event.type === 'model.request_prepared') {
      if (event.payload.executionId === executionId && !skipped.has(event.payload.modelCallId))
        current = position.get(event.payload.modelCallId) ?? current;
      continue;
    }
    if (event.type !== 'tool.requested' || event.payload.executionId !== executionId) continue;
    if (event.runSeq <= after || event.actor.kind === 'runtime' || current < 0) continue;
    const status = toolStatus(run, event.payload.toolCallId, ended);
    if (current > lastRead || !SETTLED.has(status)) {
      held = true;
      seq = event.runSeq - 1;
      continue;
    }
    const list = rows.get(current) ?? [];
    list.push(toolRow(run, event, status, roots));
    rows.set(current, list);
  }

  if (end === start && rows.size === 0) return none;
  const last = ids[lastRead];
  if (!last) return none;
  const next: ReviewCursor = { modelCallId: last, seq };

  const groups: Group[] = [];
  for (let index = 0; index <= lastRead; index++) {
    const id = ids[index] ?? '';
    const answered = index >= start && !skipped.has(id);
    if (!answered && !rows.has(index)) continue;
    groups.push({ ...answer(source, id, index, answered), answered, rows: rows.get(index) ?? [] });
  }
  if (!groups.length) return { ...none, cursor: next };
  const task = cursor === null ? taskBlock(source.taskInput) : null;
  return { ...fit(task, groups), cursor: next };
}

/** A call is done for review once it finished, a later call followed it, or the execution ended. */
function closed(run: ReviewRun, ids: readonly string[], index: number, ended: boolean): boolean {
  const id = ids[index];
  return (!!id && run.modelCalls[id]?.finished === true) || index < ids.length - 1 || ended;
}

function answer(
  source: ReviewInputSource,
  id: string,
  index: number,
  answered: boolean,
): Pick<Group, 'head' | 'answer' | 'fixed'> {
  const call = source.run.modelCalls[id];
  const profile = call?.profile ?? source.run.executions[source.executionId]?.modelProfile ?? '';
  const model = oneLine(source.run.modelProfiles[profile]?.modelId ?? profile);
  const head = `Request ${index + 1} · model ${model}`;
  if (!answered) return { head: `${head} · answer read earlier`, answer: null, fixed: null };
  const ref = call?.responseRef ?? null;
  if (ref) {
    const text = source.readResponse(ref);
    if (text === null) return { head, answer: null, fixed: '(response text no longer available)' };
    return text
      ? { head, answer: text, fixed: null }
      : { head, answer: null, fixed: '(empty response)' };
  }
  // Cut or failed: no confirmed response, only the text received before it ended.
  const mark = `${head}${call?.interrupted ? ' · interrupted' : ''} · no confirmed response`;
  const partial = source.partialOutputs?.[id]?.text;
  return { head: mark, answer: partial || null, fixed: null };
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
  roots: readonly string[],
): ToolRow {
  const call = run.toolCalls[event.payload.toolCallId];
  const raw = targetOf(run, event.payload.validatedArgs, call?.resultRef ?? null);
  const target = raw ? oneLine(redactCredentialsAndPaths(raw, roots)) : '';
  const fields = [oneLine(event.payload.name), ...(target ? [target] : []), status];
  const summary = call?.reason ? oneLine(redactCredentialsAndPaths(call.reason, roots)) : '';
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
    return run.artifacts[value] ? artifactLabel(run, value) : value;
  }
  return resultRef && run.artifacts[resultRef] ? artifactLabel(run, resultRef) : null;
}

function artifactLabel(run: ReviewRun, id: string): string {
  const artifact = run.artifacts[id];
  if (!artifact) return id;
  return `${artifact.name.split('\n')[0] ?? artifact.name} v${artifact.version}`;
}

function taskBlock(taskInput: string | null): string | null {
  if (!taskInput?.trim()) return null;
  return `Task input:\n${cap(taskInput, REVIEW_TASK_MAX_LENGTH)}`;
}

interface Shape {
  /** Which rows keep their summary. */
  summaries: boolean[];
  short: boolean;
  counted: boolean;
}

interface Sizes {
  head: number;
  /** Body length at the full and the short cap; -1 when the call shows no body. */
  body: number;
  short: number;
  rows: number[];
  /** Summary length per row; -1 when the row has none. */
  summaries: number[];
  counted: number;
}

type Counts = { trimmed: number; shortened: number; counted: number; dropped: number };

/**
 * Fits the total by reducing oldest first, one stage after another, each stopping as soon as the
 * text fits: tool summaries left out, answers shortened, tool rows replaced by their count. Whole
 * oldest calls are left out only when the rest cannot fit even fully reduced. Lengths are summed,
 * never re-rendered per step.
 */
function fit(task: string | null, groups: readonly Group[]): Omit<ReviewInput, 'cursor'> {
  const sizes: Sizes[] = groups.map((group) => ({
    head: group.head.length,
    body: bodyOf(group, REVIEW_ANSWER_MAX_LENGTH)?.length ?? -1,
    short: bodyOf(group, REVIEW_SHORT_ANSWER_LENGTH)?.length ?? -1,
    rows: group.rows.map((row) => row.line.length),
    summaries: group.rows.map((row) => row.summary?.length ?? -1),
    counted: countLine(group.rows.length).length,
  }));
  const shortens = (s: Sizes) => s.short >= 0 && s.short < s.body;
  const rowsLength = (s: Sizes, shape: Shape) => {
    if (!s.rows.length) return 0;
    if (shape.counted) return 1 + s.counted;
    let length = 1 + 'Tools:'.length;
    s.rows.forEach((row, r) => {
      length += 1 + row;
      if (shape.summaries[r]) length += 3 + (s.summaries[r] ?? 0);
    });
    return length;
  };
  const lengthOf = (s: Sizes, shape: Shape) => {
    const body = shape.short ? s.short : s.body;
    return s.head + (body >= 0 ? 1 + body : 0) + rowsLength(s, shape);
  };
  const fullShape = (s: Sizes): Shape => ({
    summaries: s.summaries.map((length) => length >= 0),
    short: false,
    counted: false,
  });
  const leanShape = (s: Sizes): Shape => ({
    summaries: s.summaries.map(() => false),
    short: shortens(s),
    counted: s.rows.length > 0,
  });
  const counts: Counts = { trimmed: 0, shortened: 0, counted: 0, dropped: 0 };
  const taskLength = task?.length ?? 0;
  const fits = (sum: number, kept: number) => {
    const blocks = (task ? 1 : 0) + kept;
    const notes = notesOf(counts).length;
    const body = taskLength + sum + SEPARATOR * Math.max(0, blocks - 1);
    return body + (notes ? notes + (blocks ? SEPARATOR : 0) : 0) <= REVIEW_INPUT_MAX_LENGTH;
  };

  // The fewest oldest calls to leave out so that the rest fits when reduced as far as it goes.
  const lean = sizes.map((s) => lengthOf(s, leanShape(s)));
  const leanAfter = new Array<number>(sizes.length + 1).fill(0);
  const reducible = new Array<Counts>(sizes.length + 1);
  reducible[sizes.length] = { trimmed: 0, shortened: 0, counted: 0, dropped: 0 };
  for (let i = sizes.length - 1; i >= 0; i--) {
    const s = sizes[i] as Sizes;
    const later = reducible[i + 1] as Counts;
    leanAfter[i] = (leanAfter[i + 1] ?? 0) + (lean[i] ?? 0);
    reducible[i] = {
      trimmed: later.trimmed + s.summaries.filter((length) => length >= 0).length,
      shortened: later.shortened + (shortens(s) ? 1 : 0),
      counted: later.counted + (s.rows.length ? 1 : 0),
      dropped: 0,
    };
  }
  let dropped = 0;
  for (; dropped < sizes.length; dropped++) {
    Object.assign(counts, reducible[dropped], { dropped });
    if (fits(leanAfter[dropped] ?? 0, sizes.length - dropped)) break;
  }
  Object.assign(counts, { trimmed: 0, shortened: 0, counted: 0, dropped });

  // Then reduce the kept calls only as far as needed, stage by stage, oldest first.
  const kept = sizes.length - dropped;
  const shapes = sizes.map(fullShape);
  let sum = 0;
  for (let i = dropped; i < sizes.length; i++)
    sum += lengthOf(sizes[i] as Sizes, shapes[i] as Shape);
  const reduce = () => {
    if (fits(sum, kept)) return;
    for (let i = dropped; i < sizes.length; i++) {
      const s = sizes[i] as Sizes;
      const shape = shapes[i] as Shape;
      for (let r = 0; r < s.summaries.length; r++) {
        if (!shape.summaries[r]) continue;
        shape.summaries[r] = false;
        sum -= 3 + (s.summaries[r] ?? 0);
        counts.trimmed++;
        if (fits(sum, kept)) return;
      }
    }
    for (let i = dropped; i < sizes.length; i++) {
      const s = sizes[i] as Sizes;
      if (!shortens(s)) continue;
      (shapes[i] as Shape).short = true;
      sum += s.short - s.body;
      counts.shortened++;
      if (fits(sum, kept)) return;
    }
    for (let i = dropped; i < sizes.length; i++) {
      const s = sizes[i] as Sizes;
      const shape = shapes[i] as Shape;
      if (!s.rows.length) continue;
      const before = rowsLength(s, shape);
      shape.counted = true;
      sum += rowsLength(s, shape) - before;
      counts.counted++;
      if (fits(sum, kept)) return;
    }
  };
  reduce();

  const blocks: string[] = [];
  const notes = notesOf(counts);
  if (notes) blocks.push(notes);
  if (task) blocks.push(task);
  for (let i = dropped; i < groups.length; i++)
    blocks.push(render(groups[i] as Group, shapes[i] as Shape));
  const calls = groups.slice(dropped).filter((group) => group.answered).length;
  return { text: blocks.join('\n\n'), calls, trimmed: counts.trimmed, dropped };
}

function render(group: Group, shape: Shape): string {
  const lines = [group.head];
  const body = bodyOf(group, shape.short ? REVIEW_SHORT_ANSWER_LENGTH : REVIEW_ANSWER_MAX_LENGTH);
  if (body !== null) lines.push(body);
  if (group.rows.length) {
    if (shape.counted) lines.push(countLine(group.rows.length));
    else {
      lines.push('Tools:');
      group.rows.forEach((row, r) => {
        lines.push(row.summary && shape.summaries[r] ? `${row.line} · ${row.summary}` : row.line);
      });
    }
  }
  return lines.join('\n');
}

function bodyOf(group: Group, max: number): string | null {
  return group.answer ? cap(group.answer, max) : group.fixed;
}

function countLine(count: number): string {
  return `Tools: ${count} ${count === 1 ? 'call' : 'calls'}`;
}

function notesOf(counts: Counts): string {
  const lines: string[] = [];
  const note = (count: number, one: string, many: string, rest: string) => {
    if (count) lines.push(`Note: ${count} ${count === 1 ? one : many} ${rest}`);
  };
  note(counts.trimmed, 'tool summary', 'tool summaries', 'left out to fit.');
  note(
    counts.shortened,
    'answer',
    'answers',
    `shortened to ${REVIEW_SHORT_ANSWER_LENGTH} characters to fit.`,
  );
  note(counts.counted, 'tool list', 'tool lists', 'reduced to a count to fit.');
  note(counts.dropped, 'oldest request', 'oldest requests', 'left out to fit.');
  return lines.join('\n');
}

/** Keeps `max` code units and says how many were left out; never splits a surrogate pair. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = cutAt(text, max);
  const left = text.length - end;
  return `${text.slice(0, end)}\n[... ${left} more ${left === 1 ? 'character' : 'characters'} left out]`;
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
