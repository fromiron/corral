import type {
  ConversationTurn,
  ModelProfileSnapshot,
  ModelRequestIntent,
  SessionCompactionRecord,
  SessionConversation,
  SessionSummary,
} from '@corral/contracts';
import {
  COMPACTION_SUMMARY_INSTRUCTION,
  COMPACTION_SYSTEM_INSTRUCTION,
  compactionCheckpoint,
  compactionTurnAnswer,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from './canonical-json.ts';

export interface SessionCompactionRequest {
  commandId: string;
  sessionId: string;
  sessionRevision: number;
  model: ModelProfileSnapshot;
  purpose: 'compaction';
  toolChoice: 'none';
  intent: ModelRequestIntent;
  /** Source turns, then the internal instruction, then the summary instruction. */
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
}

export interface SessionCompactionAnswer {
  text: string;
  stopReason: 'stop' | 'aborted' | 'error' | 'toolUse';
}

/** A cancellation flag that does not depend on a DOM AbortController. */
export class CompactionCancellation {
  aborted = false;
  private readonly listeners = new Set<() => void>();

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }

  onCancel(fn: () => void): () => void {
    if (this.aborted) fn();
    else this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** The same density estimate live compaction uses for one text message. */
export function compactionMessageTokens(text: string): number {
  const wide = [...text].reduce(
    (sum, char) =>
      sum +
      (char.charCodeAt(0) > 127 ? Math.max(0, utf8ToBytes(char).length / 2 - char.length / 4) : 0),
    0,
  );
  return Math.ceil(text.length / 4 + wide + 4);
}

export function sessionCompactionHash(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
}

/** Messages the summary model sees. The last two are the compaction instructions. */
export function compactionMessages(
  source: SessionConversation,
): SessionCompactionRequest['messages'] {
  const messages: SessionCompactionRequest['messages'] = [];
  if (source.summary)
    messages.push({ role: 'user', content: compactionCheckpoint(source.summary.text) });
  for (const turn of source.turns) {
    messages.push({ role: 'user', content: turn.request });
    messages.push({ role: 'assistant', content: compactionTurnAnswer(turn) });
  }
  messages.push({ role: 'system', content: COMPACTION_SYSTEM_INSTRUCTION });
  messages.push({ role: 'user', content: COMPACTION_SUMMARY_INSTRUCTION });
  return messages;
}

/** True when the checkpoint is strictly smaller than the attached source. */
export function summaryIsSmaller(source: SessionConversation, summary: string): boolean {
  const original = compactionMessages(source).slice(0, -2);
  const sourceTokens = original.reduce(
    (sum, message) => sum + compactionMessageTokens(message.content),
    0,
  );
  return compactionMessageTokens(compactionCheckpoint(summary)) < sourceTokens;
}

type StoredTurn = ConversationTurn & { artifactVersionId: string | null };

/**
 * The history a follow-up attaches: a kept summary, then turns that ended after it,
 * dropped from the oldest until the artifact cap holds.
 */
export function shapeSessionConversation(
  turns: StoredTurn[],
  applied: SessionCompactionRecord | null,
  cap: number,
): {
  conversation: SessionConversation;
  provenanceTurns: { runId: string; artifactVersionId: string | null }[];
  summary?: {
    commandId: string;
    throughRunId: string;
    sessionRevision: number;
    sourceHash: string;
    summaryHash: string;
  };
} {
  const working = turns.map((turn) => ({ ...turn }));
  let summary: SessionSummary | undefined;
  let uncovered = 0;
  let coveredCount = 0;
  if (applied?.phase === 'completed' && applied.summary && applied.throughRunId) {
    const index = working.findIndex((turn) => turn.runId === applied.throughRunId);
    if (index >= 0) {
      const covered = new Set(applied.coveredRunIds);
      const removed = working.splice(0, index + 1);
      uncovered = removed.filter((turn) => !covered.has(turn.runId)).length;
      coveredCount = removed.length - uncovered;
      summary = {
        commandId: applied.commandId,
        text: applied.summary,
        throughRunId: applied.throughRunId,
        sessionRevision: applied.sessionRevision,
        coveredRunIds: applied.coveredRunIds,
        sourceHash: applied.sourceHash,
      };
    }
  }
  const bytes = (turn: StoredTurn) =>
    utf8ToBytes(turn.request).length + (turn.answer ? utf8ToBytes(turn.answer).length : 0);
  let summaryBytes = summary ? utf8ToBytes(compactionCheckpoint(summary.text)).length : 0;
  let total = summaryBytes + working.reduce((sum, turn) => sum + bytes(turn), 0);
  let summaryKept = summary !== undefined;
  while ((summaryKept || working.length > 0) && total > cap) {
    if (summaryKept && summary) {
      const only = working[0];
      if (
        working.length === 1 &&
        only &&
        only.answer !== null &&
        summaryBytes + utf8ToBytes(only.request).length <= cap
      ) {
        total -= bytes(only);
        only.answer = null;
        only.answerOmitted = true;
        only.artifactVersionId = null;
        total += bytes(only);
        continue;
      }
      total -= summaryBytes;
      summary = undefined;
      summaryBytes = 0;
      summaryKept = false;
      continue;
    }
    const oldest = working[0];
    if (!oldest) break;
    if (
      working.length === 1 &&
      oldest.answer !== null &&
      utf8ToBytes(oldest.request).length <= cap
    ) {
      total -= bytes(oldest);
      oldest.answer = null;
      oldest.answerOmitted = true;
      oldest.artifactVersionId = null;
      total += bytes(oldest);
      continue;
    }
    total -= bytes(oldest);
    working.shift();
    uncovered += 1;
  }
  const omittedTurns = uncovered + (summaryKept ? 0 : coveredCount);
  const conversation: SessionConversation = {
    ...(summary ? { summary } : {}),
    turns: working.map(({ artifactVersionId: _id, ...turn }) => turn),
    omittedTurns,
  };
  return {
    conversation,
    provenanceTurns: working.map(({ runId, artifactVersionId }) => ({ runId, artifactVersionId })),
    ...(summary
      ? {
          summary: {
            commandId: summary.commandId,
            throughRunId: summary.throughRunId,
            sessionRevision: summary.sessionRevision,
            sourceHash: summary.sourceHash,
            summaryHash: sessionCompactionHash(summary.text),
          },
        }
      : {}),
  };
}
