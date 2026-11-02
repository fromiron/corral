// Derive the production input view without inference, labels, or final-exposure bookkeeping.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  compactMeetingInput,
  formatDecisionPrompt,
  type MeetingInput,
  renderMeeting,
} from '../../../packages/local-intelligence/src/decision/text.ts';

const HISTORY_LIMIT = 12;

export type RuntimeViewSource =
  | { task: 'effort'; text: string }
  | { task: 'meeting'; input: MeetingInput; text?: string };

export interface RuntimeView {
  prompt: string;
  participantIds: string[];
  modelToOriginalIds: Record<string, string>;
  /** Applies to meeting history; effort rows do not invent a history. */
  historyLimit: 12;
}

export interface RuntimeViewReceipt {
  rowCount: number;
  comparablePromptCount: number;
  exactPromptMatchCount: number;
  modelToOriginalIdsIdentity: boolean;
  sourceSha256: string;
  outputSha256: string;
}

/** Only task/input/text are read. Targets, record IDs, groups, and splits are opaque. */
export function deriveRuntimeView(row: RuntimeViewSource): RuntimeView {
  if (Object.hasOwn(row, 'runtimeView')) throw new Error('runtime view already exists');
  if (row.task === 'effort') {
    if (typeof row.text !== 'string')
      throw new Error('effort runtime view requires existing row.text');
    return {
      prompt: formatDecisionPrompt('effort', row.text),
      participantIds: [],
      modelToOriginalIds: {},
      historyLimit: HISTORY_LIMIT,
    };
  }
  if (row.task !== 'meeting') throw new Error('runtime-view task is invalid');
  const input = row.input;
  if (
    !input ||
    typeof input.message !== 'string' ||
    !Array.isArray(input.participants) ||
    !Array.isArray(input.turns)
  )
    throw new Error('meeting runtime-view input is invalid');
  const compact = compactMeetingInput({
    message: input.message,
    participants: input.participants.map((participant) => ({
      participantId: participant.id,
      name: participant.name,
      prompt: participant.role,
    })),
    history: input.turns.slice(-HISTORY_LIMIT).map((turn) => ({
      id: turn.id,
      participantId: turn.speakerId,
      text: turn.text,
      ...(turn.replyTo ? { replyTo: turn.replyTo } : {}),
    })),
  });
  return {
    prompt: formatDecisionPrompt('meeting', renderMeeting(compact.input)),
    participantIds: [...compact.participantIds.keys()],
    modelToOriginalIds: Object.fromEntries(compact.participantIds),
    historyLimit: HISTORY_LIMIT,
  };
}

/** Reference mapping for consumers; empty NONE remains empty, never a fallback selection. */
export function restoreRuntimeRecipients(
  view: RuntimeView,
  aliases: readonly string[],
): string[] | null {
  if (new Set(aliases).size !== aliases.length) return null;
  const restored: string[] = [];
  for (const alias of aliases) {
    if (!Object.hasOwn(view.modelToOriginalIds, alias)) return null;
    const original = view.modelToOriginalIds[alias];
    if (original === undefined) return null;
    restored.push(original);
  }
  return restored;
}

function outsideRepository(path: string) {
  let at = dirname(path);
  while (!existsSync(at)) at = dirname(at);
  at = realpathSync(at);
  for (;;) {
    if (existsSync(join(at, '.git')))
      throw new Error('runtime-view data must stay outside a repository');
    if (at === dirname(at)) break;
    at = dirname(at);
  }
}

function sourceRow(line: string): RuntimeViewSource {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('runtime-view source row is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('runtime-view source row must be an object');
  return value as RuntimeViewSource;
}

/** Append one field without reserializing any original JSON field, escape, or whitespace. */
export function writeRuntimeViews(sourcePath: string, outputPath: string): RuntimeViewReceipt {
  const source = realpathSync(resolve(sourcePath));
  const output = resolve(outputPath);
  outsideRepository(source);
  outsideRepository(output);
  if (existsSync(output)) throw new Error('runtime-view output must be new');
  const original = readFileSync(source, 'utf8');
  let rowCount = 0;
  let comparablePromptCount = 0;
  let exactPromptMatchCount = 0;
  let modelToOriginalIdsIdentity = true;
  const derived = original
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      const row = sourceRow(line);
      const view = deriveRuntimeView(row);
      rowCount++;
      if (typeof row.text === 'string') {
        comparablePromptCount++;
        if (view.prompt === formatDecisionPrompt(row.task, row.text)) exactPromptMatchCount++;
      }
      modelToOriginalIdsIdentity &&= Object.entries(view.modelToOriginalIds).every(
        ([alias, id]) => alias === id,
      );
      const closingBrace = line.lastIndexOf('}');
      return `${line.slice(0, closingBrace)},"runtimeView":${JSON.stringify(view)}${line.slice(closingBrace)}`;
    })
    .join('\n');
  if (rowCount === 0) throw new Error('runtime-view source contains no rows');
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, derived, { flag: 'wx', mode: 0o600 });
  return {
    rowCount,
    comparablePromptCount,
    exactPromptMatchCount,
    modelToOriginalIdsIdentity,
    sourceSha256: createHash('sha256').update(original).digest('hex'),
    outputSha256: createHash('sha256').update(derived).digest('hex'),
  };
}

if (import.meta.main) {
  const [source, output, ...extra] = process.argv.slice(2);
  if (!source || !output || extra.length) {
    console.error('Usage: runtime-views.ts <private-source.jsonl> <new-private-output.jsonl>');
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(writeRuntimeViews(source, output)));
    } catch {
      // JSON/IO failures can carry source contents or private paths in their messages.
      console.error('runtime-view derivation failed; check the private source and new output');
      process.exitCode = 1;
    }
  }
}
