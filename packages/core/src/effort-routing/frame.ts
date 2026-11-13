import type {
  CallSnapshotInput,
  DecisionCancellation,
  EffortQuestion,
  InsufficientContextReason,
  ParentQuestionMessage,
  RoutingFrameRecord,
} from '@corral/contracts';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from '../canonical-json.ts';
import { sha256Hex } from './question.ts';

// The decision frame (features/effort-routing.md#frame과-예산): one deterministic packer for both
// engines. Only the unit and the limits differ: d1 tokens counted by the model's tokenizer, or
// UTF-8 bytes for a decision API.

export const SERIALIZER_VERSION = 'effort-frame-v1';
/** Count calls one frame may make before it gives up. */
export const MAX_COUNT_CALLS = 32;

export type FrameKind = 'd1-exact' | 'api-bounded';

export const FRAME_LIMITS: Record<FrameKind, { state: number; input: number }> = {
  'd1-exact': { state: 400, input: 512 },
  'api-bounded': { state: 2048, input: 8192 },
};

/** Share of the state each of the previous plan and the latest observation is promised. */
const RESERVATION = 0.16;

type Group = 'goal' | 'observation' | 'reply';

export interface FrameSource {
  id: string;
  /** The heading the engine reads: role, order, tool call ID and status. */
  label: string;
  text: string;
  required: boolean;
  /** Cut by the worker at the contract limit. */
  cut: boolean;
  group: Group | null;
  /** The previous assistant plan or the latest observation, promised a share of the state. */
  reserved?: 'plan' | 'latest';
}

export interface CallSnapshot {
  sources: FrameSource[];
  /** Sources compared with each other: all of them, or no judgment. */
  relations: { kind: 'compare'; members: string[] }[];
  missingRequest: boolean;
  imageOnly: boolean;
  /** A required source the Coordinator could not read: no judgment without it. */
  missingRequired?: boolean;
}

/** A version a parent question attached; `text` is null when this request may not read it. */
export interface QuestionAttachment {
  questionId: string;
  artifactVersionId: string;
  text: string | null;
}

export interface FrameMeter {
  kind: FrameKind;
  countState(text: string, signal: DecisionCancellation): Promise<number>;
  countInput(
    state: string,
    question: EffortQuestion,
    signal: DecisionCancellation,
  ): Promise<number>;
}

export interface DecisionFrame {
  state: string;
  record: RoutingFrameRecord;
  includedIds: string[];
  omittedIds: string[];
  truncatedIds: string[];
  countCalls: number;
}

export type PackResult =
  | { kind: 'packed'; frame: DecisionFrame }
  | { kind: 'insufficient'; reason: InsufficientContextReason; countCalls: number };

/** Thrown when a count call failed for a reason other than cancellation. */
export class CountError extends Error {}

const bytes = (text: string) => utf8ToBytes(text).length;

/**
 * Builds the routing view of one request from what the worker read and what the Coordinator
 * fixed for it: the current request, the directives, the parent questions, earlier replies, the
 * previous plan, and every tool call of that step with its result.
 */
export function callSnapshot(
  input: CallSnapshotInput | undefined,
  fixed: {
    /** An advice is named as one: it is not the person's instruction. */
    directives: readonly { directiveId: string; text: string; origin?: 'user' | 'advice' }[];
    questions: readonly ParentQuestionMessage[];
    attachments?: readonly QuestionAttachment[];
  },
): CallSnapshot {
  const sources: FrameSource[] = [];
  const add = (source: Omit<FrameSource, 'cut'> & { cut?: boolean }) =>
    sources.push({ cut: false, ...source });
  const request = input?.request?.text.trim() ? input.request : null;
  if (request)
    add({
      id: 'request',
      label: 'request',
      text: request.text,
      cut: request.originalBytes !== undefined,
      required: true,
      group: null,
    });
  for (const directive of fixed.directives)
    add({
      id: `directive:${directive.directiveId}`,
      label: `${directive.origin === 'advice' ? 'advisor advice' : 'instruction'} ${directive.directiveId}`,
      text: directive.text,
      required: true,
      group: null,
    });
  for (const question of fixed.questions)
    add({
      id: `question:${question.questionId}`,
      label: `question ${question.questionId} from ${question.senderExecutionId}`,
      text: question.body,
      required: true,
      group: null,
    });
  // A question's attached versions are required evidence, kept whole (features/effort-routing.md).
  let missingRequired = false;
  for (const attachment of fixed.attachments ?? []) {
    if (attachment.text === null) {
      missingRequired = true;
      continue;
    }
    add({
      id: `attachment:${attachment.questionId}:${attachment.artifactVersionId}`,
      label: `version ${attachment.artifactVersionId} attached to question ${attachment.questionId}`,
      text: attachment.text,
      required: true,
      group: null,
    });
  }
  const replies = input?.earlierReplies ?? [];
  for (const [index, reply] of replies.entries())
    add({
      id: `reply:${replies.length - index}`,
      label: 'earlier reply',
      text: reply.text,
      cut: reply.originalBytes !== undefined,
      required: false,
      group: 'reply',
    });
  const calls = input?.toolCalls ?? [];
  const plan = input?.previousAssistant?.text.trim() ? input.previousAssistant : null;
  const latest = calls.findLast((call) => call.result !== null);
  const both = plan !== null && latest !== undefined;
  if (plan)
    add({
      id: 'assistant',
      label: 'assistant',
      text: plan.text,
      cut: plan.originalBytes !== undefined,
      required: false,
      group: 'reply',
      ...(both ? { reserved: 'plan' as const } : {}),
    });
  for (const call of calls) {
    add({
      id: `tool:${call.toolCallId}`,
      label: `tool call ${call.toolCallId} ${call.name} · ${call.status}`,
      text: call.args.text,
      cut: call.args.originalBytes !== undefined,
      required: false,
      group: 'observation',
    });
    if (call.result)
      add({
        id: `result:${call.toolCallId}`,
        label: `tool result ${call.toolCallId} · ${call.status}`,
        text: call.result.text,
        cut: call.result.originalBytes !== undefined,
        required: false,
        group: 'observation',
        ...(both && call === latest ? { reserved: 'latest' as const } : {}),
      });
  }
  return {
    sources,
    relations: [],
    missingRequest: request === null,
    imageOnly: request === null && (input?.requestImages ?? 0) > 0,
    missingRequired,
  };
}

const heading = (source: FrameSource) => `## ${source.label}\n`;
const marker = (omitted: number) => `\n[… ${omitted} bytes omitted …]\n`;

/** Keeps the first 60% and last 40% of `budget` bytes, cut at line or grapheme boundaries. */
export function excerpt(text: string, budget: number): string | null {
  const total = bytes(text);
  if (total <= budget) return text;
  const room = budget - bytes(marker(total));
  if (room <= 0) return null;
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
  ].map((s) => s.segment);
  const headBudget = Math.floor(room * 0.6);
  const tailBudget = room - headBudget;
  let head = '';
  let used = 0;
  let index = 0;
  for (; index < graphemes.length; index++) {
    const size = bytes(graphemes[index]!);
    if (used + size > headBudget) break;
    head += graphemes[index];
    used += size;
  }
  const headLine = head.lastIndexOf('\n');
  if (headLine >= 0 && headLine + 1 >= head.length / 2) head = head.slice(0, headLine + 1);
  let tail = '';
  used = 0;
  for (let back = graphemes.length - 1; back >= index; back--) {
    const size = bytes(graphemes[back]!);
    if (used + size > tailBudget) break;
    tail = graphemes[back] + tail;
    used += size;
  }
  const tailLine = tail.indexOf('\n');
  if (tailLine >= 0 && tailLine <= tail.length / 2) tail = tail.slice(tailLine + 1);
  if (!head && !tail) return null;
  return head + marker(total - bytes(head) - bytes(tail)) + tail;
}

function render(snapshot: CallSnapshot, texts: ReadonlyMap<string, string>): string {
  return snapshot.sources
    .flatMap((source) => {
      const text = texts.get(source.id);
      return text === undefined ? [] : [`${heading(source)}${text}`];
    })
    .join('\n\n');
}

class Exhausted extends Error {}

/** Packs one frame, or says why the request lacks the context a judgment needs. */
export async function packFrame(
  snapshot: CallSnapshot,
  meter: FrameMeter,
  question: EffortQuestion,
  signal: DecisionCancellation,
): Promise<PackResult> {
  let calls = 0;
  const insufficient = (reason: InsufficientContextReason): PackResult => ({
    kind: 'insufficient',
    reason,
    countCalls: calls,
  });
  if (snapshot.imageOnly) return insufficient('unsupported-modality');
  if (snapshot.missingRequest) return insufficient('missing-request');
  if (snapshot.missingRequired) return insufficient('required-source-missing');
  const byId = new Map(snapshot.sources.map((source) => [source.id, source]));
  const compared = new Set<string>();
  for (const relation of snapshot.relations) {
    if (relation.members.some((id) => !byId.has(id)))
      return insufficient('comparison-operand-missing');
    for (const id of relation.members) compared.add(id);
  }
  const required = snapshot.sources.filter((s) => s.required || compared.has(s.id));
  if (required.some((source) => source.cut)) return insufficient('required-content-over-budget');

  const limits = FRAME_LIMITS[meter.kind];
  const stateMemo = new Map<string, number>();
  const inputMemo = new Map<string, number>();
  const counted = async (
    memo: Map<string, number>,
    key: string,
    run: () => Promise<number>,
  ): Promise<number> => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (calls >= MAX_COUNT_CALLS) throw new Exhausted();
    calls++;
    let value: number;
    try {
      value = await run();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new CountError('count failed');
    }
    if (!Number.isInteger(value) || value < 0) throw new CountError('count failed');
    memo.set(key, value);
    return value;
  };
  const stateUnits = (text: string) =>
    counted(stateMemo, text, () => meter.countState(text, signal));
  const inputUnits = (text: string) =>
    counted(inputMemo, text, () => meter.countInput(text, question, signal));

  try {
    const fixed = new Map(required.map((source) => [source.id, source.text]));
    const requiredState = render(snapshot, fixed);
    const requiredUnits = await stateUnits(requiredState);
    if (requiredUnits > limits.state) return insufficient('required-content-over-budget');
    const requiredInput = await inputUnits(requiredState);
    if (requiredInput > limits.input) return insufficient('required-content-over-budget');
    const optional = snapshot.sources.filter((s) => !fixed.has(s.id));
    if (optional.length === 0)
      return packed(snapshot, meter.kind, fixed, requiredUnits, requiredInput, calls);

    const all = new Map(snapshot.sources.map((source) => [source.id, source.text]));
    const fullState = render(snapshot, all);
    const fullUnits = await stateUnits(fullState);
    if (fullUnits <= limits.state) {
      const fullInput = await inputUnits(fullState);
      if (fullInput <= limits.input)
        return packed(snapshot, meter.kind, all, fullUnits, fullInput, calls);
    }
    // Units per byte of this content, so byte budgets can be planned before counting again.
    const ratio = Math.max(fullUnits / Math.max(1, bytes(fullState)), 1e-6);
    let room = limits.state - requiredUnits;
    for (;;) {
      const texts = allocate(optional, fixed, room, ratio, limits.state);
      const state = render(snapshot, texts);
      const used = await stateUnits(state);
      const total = used <= limits.state ? await inputUnits(state) : Number.POSITIVE_INFINITY;
      if (used <= limits.state && total <= limits.input)
        return packed(snapshot, meter.kind, texts, used, total, calls);
      const over = Math.max(
        used - limits.state,
        Number.isFinite(total) ? total - limits.input : 0,
        1,
      );
      if (room <= 0) return insufficient('required-content-over-budget');
      room = Math.max(0, Math.floor(room - over * 1.1) - 1);
    }
  } catch (error) {
    if (error instanceof Exhausted) return insufficient('packing-budget-exhausted');
    throw error;
  }
}

/**
 * Fills `room` units with optional sources: the plan and the latest observation each get their
 * reservation first, then goals, other observations and earlier replies, most recent first,
 * and what is left grows the two reserved ones.
 */
function allocate(
  optional: readonly FrameSource[],
  fixed: ReadonlyMap<string, string>,
  room: number,
  ratio: number,
  stateLimit: number,
): Map<string, string> {
  const texts = new Map(fixed);
  let left = room;
  const separator = Math.ceil(2 * ratio);
  const place = (source: FrameSource, units: number) => {
    const head = Math.ceil(bytes(heading(source)) * ratio) + separator;
    const current = texts.get(source.id);
    const already = current === undefined ? 0 : Math.ceil(bytes(current) * ratio) + head;
    const allowance = Math.min(left + already, units);
    if (allowance <= head) return;
    const text = excerpt(source.text, Math.floor((allowance - head) / ratio));
    if (text === null) return;
    const cost = Math.ceil(bytes(text) * ratio) + head;
    texts.set(source.id, text);
    left -= cost - already;
  };
  const reserved = optional.filter((s) => s.reserved);
  const share = Math.floor(stateLimit * RESERVATION);
  for (const source of reserved) place(source, share);
  const order: Group[] = ['goal', 'observation', 'reply'];
  for (const group of order) {
    const members = optional.filter((s) => s.group === group && !s.reserved);
    // Tool calls are short and tell what was done; their results follow, newest first.
    const calls = members.filter((s) => s.id.startsWith('tool:'));
    const rest = members.filter((s) => !s.id.startsWith('tool:')).reverse();
    for (const source of [...calls, ...rest]) place(source, Number.POSITIVE_INFINITY);
  }
  for (const source of reserved) place(source, Number.POSITIVE_INFINITY);
  return texts;
}

function packed(
  snapshot: CallSnapshot,
  kind: FrameKind,
  texts: ReadonlyMap<string, string>,
  stateUnits: number,
  inputUnits: number,
  countCalls: number,
): PackResult {
  const state = render(snapshot, texts);
  const includedIds = snapshot.sources.filter((s) => texts.has(s.id)).map((s) => s.id);
  const omittedIds = snapshot.sources.filter((s) => !texts.has(s.id)).map((s) => s.id);
  const truncatedIds = snapshot.sources
    .filter((s) => texts.has(s.id) && (s.cut || texts.get(s.id) !== s.text))
    .map((s) => s.id);
  return {
    kind: 'packed',
    frame: {
      state,
      includedIds,
      omittedIds,
      truncatedIds,
      countCalls,
      record: {
        kind,
        hash: sha256Hex(canonicalJson({ serializer: SERIALIZER_VERSION, kind, state })),
        stateUnits,
        inputUnits,
        included: includedIds.length,
        omitted: omittedIds.length,
        truncated: truncatedIds.length,
      },
    },
  };
}
