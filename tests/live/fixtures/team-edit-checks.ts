import { isDeepStrictEqual } from 'node:util';
import {
  assistantKindAllowed,
  hasAssistantTarget,
  TeamAssistantReply,
  TeamAssistantRequest,
  TeamAssistantTarget,
  TeamAssistantTeam,
} from '@corral/contracts';
import { readAssistantAnswer } from '@corral/core';
import type { AttemptTime } from './team-assistant-checks.ts';

// The edit cases of the team assistant's measurement (fixtures/team-edit-requests.rules.json):
// reading the file, the edit request each case sends, the model's answer read as the model wrote
// it and as the product's reader reads it, the expectations each one misses, and a record file
// read again by today's reader. Nothing here calls a model.

type Reply = TeamAssistantReply;
type EditKind = Extract<Reply, { kind: 'edits' }>['edits'][number]['kind'];
type QuestionId = Extract<Reply, { kind: 'question' }>['id'];
type Topic = Extract<Reply, { kind: 'describe' }>['topic'];
type EditRequest = Extract<TeamAssistantRequest, { mode: 'edit' }>;

const REPLY_KINDS: readonly Reply['kind'][] = ['question', 'edits', 'describe', 'unsupported'];
const EDIT_KINDS: readonly EditKind[] = ['set_brief', 'add_shared_advice', 'require_review'];
const QUESTION_IDS: readonly QuestionId[] = ['material', 'review_policy', 'review_target'];
const TOPICS: readonly Topic[] = ['submitter', 'members', 'review'];

export interface EditExpect {
  /** The reply kinds that are right. */
  reply: Reply['kind'][];
  /** The question ids that are right when the reply is a question. */
  question?: QuestionId[];
  /** The edit kinds an `edits` reply must hold. */
  has?: EditKind[];
  /** The edit kinds an `edits` reply must not hold. */
  hasNot?: EditKind[];
  /** The result every require_review edit must name; a missing gate is `has`'s miss. */
  gate?: TeamAssistantTarget;
  /** The topic of a describe reply. */
  topic?: Topic;
}

export interface EditCase {
  id: string;
  kind: string;
  lang: 'ko' | 'en';
  /** A team named under the file's `teams`. */
  team: string;
  repeat?: boolean;
  /** User messages, sent in order. */
  messages: string[];
  decisions?: EditRequest['decisions'];
  expect: EditExpect;
  rater?: string;
}

export interface EditFile {
  split: string;
  teams: Record<string, TeamAssistantTeam>;
  edits: EditCase[];
}

function fail(message: string): never {
  throw new Error(message);
}
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isListOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T[] =>
  Array.isArray(value) && value.every((item) => allowed.includes(item));

/** The edit request of one send: the case's team, its user messages in order and its decisions. */
export function editRequest(
  file: Pick<EditFile, 'teams'>,
  entry: Pick<EditCase, 'id' | 'team' | 'messages' | 'decisions'>,
  operationId: string,
): EditRequest {
  const team = file.teams[entry.team] ?? fail(`Edit ${entry.id} names an unknown team.`);
  return {
    mode: 'edit',
    operationId,
    messages: entry.messages.map((content) => ({ role: 'user' as const, content })),
    team,
    ...(entry.decisions ? { decisions: entry.decisions } : {}),
  };
}

/** An edits file, read loudly: a case the harness cannot send stops the run before any request. */
export function editFileOf(value: unknown): EditFile {
  const file = value as Partial<EditFile> | null;
  if (!file || !Array.isArray(file.edits) || file.edits.length === 0)
    fail('The edits file has no edits.');
  const teams: Record<string, TeamAssistantTeam> = {};
  for (const [name, team] of Object.entries(file.teams ?? {})) {
    const parsed = TeamAssistantTeam.safeParse(team);
    if (!parsed.success) fail(`Team ${name} is not a team an edit request can carry.`);
    teams[name] = parsed.data;
  }
  const edits = file.edits as EditCase[];
  const ids = new Set<string>();
  for (const [index, entry] of edits.entries()) {
    if (typeof entry.id !== 'string' || ids.has(entry.id)) fail(`Edit ${index} needs a unique id.`);
    ids.add(entry.id);
    if (typeof entry.kind !== 'string') fail(`Edit ${entry.id} needs a kind.`);
    if (entry.lang !== 'ko' && entry.lang !== 'en') fail(`Edit ${entry.id} needs lang ko or en.`);
    const team = teams[entry.team] ?? fail(`Edit ${entry.id} names an unknown team.`);
    if (!isStrings(entry.messages) || entry.messages.length === 0)
      fail(`Edit ${entry.id} needs at least one user message.`);
    const expect = entry.expect;
    if (!expect || !isListOf(expect.reply, REPLY_KINDS) || expect.reply.length === 0)
      fail(`Edit ${entry.id} needs expect.reply.`);
    if (expect.question !== undefined && !isListOf(expect.question, QUESTION_IDS))
      fail(`Edit ${entry.id} names an unknown question in expect.question.`);
    for (const key of ['has', 'hasNot'] as const)
      if (expect[key] !== undefined && !isListOf(expect[key], EDIT_KINDS))
        fail(`Edit ${entry.id} names an unknown edit kind in expect.${key}.`);
    if (expect.topic !== undefined && !TOPICS.includes(expect.topic))
      fail(`Edit ${entry.id} names an unknown topic.`);
    if (
      expect.gate !== undefined &&
      !(TeamAssistantTarget.safeParse(expect.gate).success && hasAssistantTarget(team, expect.gate))
    )
      fail(`Edit ${entry.id} gates a result its team does not have.`);
    const target = entry.decisions?.reviewTarget;
    if (target && !hasAssistantTarget(team, target))
      fail(`Edit ${entry.id} decides a review target its team does not have.`);
    // What the run sends is a request the endpoint accepts.
    const sent = TeamAssistantRequest.safeParse(editRequest({ teams }, entry, entry.id));
    if (!sent.success)
      fail(
        `Edit ${entry.id} is not a request the endpoint accepts (${sent.error.issues[0]?.path.join('.')}).`,
      );
  }
  return { split: typeof file.split === 'string' ? file.split : '', teams, edits };
}

/** Every first send in the file's order, then the marked repeats. */
export function editSchedule(file: Pick<EditFile, 'edits'>) {
  return [
    ...file.edits.map((entry) => ({ entry, send: 'first' as const })),
    ...file.edits
      .filter((entry) => entry.repeat)
      .map((entry) => ({ entry, send: 'repeat' as const })),
  ];
}

/** One scheduled send of an edit case, as the run writes it. */
export interface EditRecord {
  profileId: string;
  case: string;
  kind: string;
  lang: 'ko' | 'en';
  send: 'first' | 'repeat';
  /** Null for a send that was not made. */
  operationId: string | null;
  /** `answered`: the model's answer came back, usable or not; `error`: no answer did. */
  outcome: 'answered' | 'error' | 'skipped';
  /** The name of the model that answered. */
  model?: string;
  /** The error code of a send with no answer. */
  code?: string;
  ms?: number;
  attempts?: number;
  /** Where each attempt spent its time. */
  timing?: AttemptTime[];
  outputTokens?: number;
  /** The model's answer text, verbatim. */
  text?: string;
  /** How the answer stopped; the reader is told it ended normally on `stop`, as the server does. */
  stopReason?: string;
  /** The answer as the model wrote it, before any reconciliation; null when it is no reply. */
  raw?: Reply | null;
  /** Why `raw` is null. */
  rawReason?: string;
  /** What the product's reader returns for the text and request; null for a refusal. */
  reply?: Reply | null;
  /** The reader's refusal code. */
  replyReason?: string;
  rawMisses?: string[];
  replyMisses?: string[];
  /** Whether the endpoint returned the reader's reading of `text`: the text is the one it read. */
  sameAsServed?: boolean;
}

/**
 * One complete JSON value of an answer, cut out of its envelope the way the product's reader cuts
 * it (from the first bracket to the last): a change counted is then the reader's checking, not
 * the cut.
 */
function jsonValue(text: string): { value: unknown } | undefined {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start < 0 || end <= start) return undefined;
  try {
    return { value: JSON.parse(text.slice(start, end + 1)) };
  } catch {
    return undefined;
  }
}

/**
 * The answer as the model wrote it, before any reconciliation: the reply when the text is one
 * reply by the contract of a kind edit mode takes, else null and why (`not_json`,
 * `shape:<path>:<issue code>`, `kind`), and the expectations it misses.
 */
export function rawAnswer(
  text: string,
  expect: EditExpect,
): Pick<EditRecord, 'raw' | 'rawReason' | 'rawMisses'> {
  const none = (reason: string) => ({ raw: null, rawReason: reason, rawMisses: ['reply'] });
  const json = jsonValue(text);
  if (!json) return none('not_json');
  const parsed = TeamAssistantReply.safeParse(json.value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return none(`shape:${issue?.path.join('.') || '$'}:${issue?.code ?? 'invalid'}`);
  }
  if (!assistantKindAllowed('edit', parsed.data.kind)) return none('kind');
  return { raw: parsed.data, rawMisses: editMisses(parsed.data, expect) };
}

/** What the product's reader returns today for the text and request, and what that misses. */
export function productAnswer(
  text: string,
  stopReason: string,
  request: TeamAssistantRequest,
  expect: EditExpect,
): Pick<EditRecord, 'reply' | 'replyReason' | 'replyMisses'> {
  const read = readAssistantAnswer(text, request, { endedNormally: stopReason === 'stop' });
  if ('reply' in read) return { reply: read.reply, replyMisses: editMisses(read.reply, expect) };
  return { reply: null, replyReason: read.problem, replyMisses: editMisses(null, expect) };
}

/**
 * The expectations a reply misses, by name; an absent expectation is not checked. No reply, or a
 * kind the case does not accept, misses `reply` alone.
 */
export function editMisses(reply: Reply | null, expect: EditExpect): string[] {
  if (!reply || !expect.reply.includes(reply.kind)) return ['reply'];
  const failed: string[] = [];
  const check = (name: string, met: boolean) => {
    if (!met) failed.push(name);
  };
  if (reply.kind === 'question' && expect.question)
    check('question', expect.question.includes(reply.id));
  if (reply.kind === 'edits') {
    const kinds = new Set(reply.edits.map((edit) => edit.kind));
    if (expect.has)
      check(
        'has',
        expect.has.every((kind) => kinds.has(kind)),
      );
    if (expect.hasNot)
      check(
        'hasNot',
        expect.hasNot.every((kind) => !kinds.has(kind)),
      );
    const { gate } = expect;
    if (gate)
      check(
        'gate',
        reply.edits.every(
          (edit) =>
            edit.kind !== 'require_review' ||
            (edit.outputId === gate.outputId && edit.index === gate.index),
        ),
      );
  }
  if (reply.kind === 'describe' && expect.topic) check('topic', reply.topic === expect.topic);
  return failed;
}

/** Whether the reader's reply differs from the raw answer in kind or edits; none is its own kind. */
export function readingChanged(raw: Reply | null, reply: Reply | null): boolean {
  if (raw === null || reply === null) return raw !== reply;
  if (raw.kind !== reply.kind) return true;
  return (
    raw.kind === 'edits' && reply.kind === 'edits' && !isDeepStrictEqual(raw.edits, reply.edits)
  );
}

/**
 * The headline of one model's edit run. A change to right is a raw answer that missed made into a
 * reply that misses nothing; a change to wrong the reverse; a change that keeps the verdict is
 * counted only in `changed`. A repeat is named `<case>#repeat` in the id lists.
 */
export function editSummaryOf(profileId: string, records: readonly EditRecord[]) {
  const answered = records.filter((r) => r.outcome === 'answered');
  const right = (misses: string[] | undefined) => misses?.length === 0;
  const changed = answered.filter((r) => readingChanged(r.raw ?? null, r.reply ?? null));
  const toRight = changed.filter((r) => !right(r.rawMisses) && right(r.replyMisses));
  const toWrong = changed.filter((r) => right(r.rawMisses) && !right(r.replyMisses));
  const idOf = (r: EditRecord) => (r.send === 'repeat' ? `${r.case}#repeat` : r.case);
  return {
    profileId,
    summary: true,
    sends: records.length,
    answered: answered.length,
    noAnswers: records.filter((r) => r.outcome === 'error').length,
    skipped: records.filter((r) => r.outcome === 'skipped').length,
    rawRight: answered.filter((r) => right(r.rawMisses)).length,
    replyRight: answered.filter((r) => right(r.replyMisses)).length,
    changed: changed.length,
    changedToRight: toRight.length,
    changedToRightIds: toRight.map(idOf),
    changedToWrong: toWrong.length,
    changedToWrongIds: toWrong.map(idOf),
    /** Answers whose recorded text does not read as what the endpoint returned. */
    notAsServed: answered.filter((r) => r.sameAsServed === false).length,
  };
}

/**
 * A record file read again by today's reader, sending nothing: each answered record's text is read
 * for the request rebuilt from its case into a new `reply`, `replyReason` and `replyMisses`, every
 * other field is kept, each header names the commit that read it, and each summary is made again
 * from the records since the header before it.
 */
export function replayEditRows(file: EditFile, recorded: unknown, commit: string): unknown[] {
  const rows = (recorded as { results?: unknown } | null)?.results;
  if (!Array.isArray(rows)) fail('The record file has no results.');
  const cases = new Map(file.edits.map((entry) => [entry.id, entry]));
  const out: unknown[] = [];
  let records: EditRecord[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    if (row.header === true) {
      out.push({ ...row, replayCommit: commit });
      records = [];
      continue;
    }
    if (row.summary === true) {
      out.push(editSummaryOf(String(row.profileId), records));
      records = [];
      continue;
    }
    const record = row as unknown as EditRecord;
    const entry =
      cases.get(record.case) ?? fail(`Record ${record.case} names a case the edits file lacks.`);
    let again = record;
    if (record.outcome === 'answered') {
      if (
        typeof record.text !== 'string' ||
        typeof record.stopReason !== 'string' ||
        typeof record.operationId !== 'string'
      )
        fail(`Record ${record.case} holds no answer to read again.`);
      const { replyReason: _before, ...kept } = record;
      const request = editRequest(file, entry, record.operationId);
      again = { ...kept, ...productAnswer(record.text, record.stopReason, request, entry.expect) };
    }
    records.push(again);
    out.push(again);
  }
  return out;
}
