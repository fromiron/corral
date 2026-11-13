import type { CorralDefinition } from '@corral/contracts';
import type { DirectiveView, RunProjection, SessionEntry } from '@corral/core';
import { awaitsPerson, targetLabel } from '../composerIntent.ts';

// What a sent message's meta line says became of it (features/composer-flow.md "보낸 메시지의
// 메타 줄"). Everything here is read from the run's own record and the session's entries.

/** A run's record as far as a meta line reads it. */
export interface RunRecord {
  projection: RunProjection;
  definition: Pick<CorralDefinition, 'nodes'> | null;
}

/** An instruction's directive with the record it lives in. */
export interface SteerRecord extends RunRecord {
  directive: DirectiveView;
}

export type SteerMeta =
  /** Not read yet: the line holds its place and says nothing. */
  | { kind: 'unread' }
  | { kind: 'waiting' }
  | { kind: 'afterDecision' }
  | { kind: 'delivering' }
  | { kind: 'read'; executionId: string; target: string }
  | { kind: 'interrupted'; executionId: string; target: string }
  | { kind: 'carriedWaiting' }
  | { kind: 'carriedStarted' }
  /** Carried over, and the request it became did not start: that request's refusal is shown. */
  | { kind: 'carriedRefused'; carried: SessionEntry }
  | { kind: 'notDelivered' }
  | { kind: 'unknown' };

/**
 * An interrupt is "interrupted" only when the response just before the request that delivered
 * it, in the same execution, was really cut; with nothing to cut it was simply read.
 */
export function cutBefore(projection: RunProjection, directive: DirectiveView): boolean {
  if (directive.delivery !== 'interrupt' || !directive.modelCallId) return false;
  const calls = Object.values(projection.modelCalls).filter(
    (call) => call.executionId === directive.targetExecutionId,
  );
  const at = calls.findIndex((call) => call.modelCallId === directive.modelCallId);
  return at > 0 && calls[at - 1]?.interrupted === true;
}

/** The meta line of an instruction (a join or an interrupt). */
export function steerMeta(
  record: SteerRecord | null,
  carried: SessionEntry | undefined,
): SteerMeta {
  if (!record) return { kind: 'unread' };
  const { directive, projection, definition } = record;
  const executionId = directive.targetExecutionId;
  switch (directive.status) {
    case 'accepted':
      return { kind: 'waiting' };
    case 'queued': {
      const target = projection.executions[executionId];
      return target && awaitsPerson(target) ? { kind: 'afterDecision' } : { kind: 'waiting' };
    }
    case 'attached_to_request':
      return { kind: 'delivering' };
    case 'delivered': {
      const target = targetLabel(projection, definition, executionId);
      return cutBefore(projection, directive)
        ? { kind: 'interrupted', executionId, target }
        : { kind: 'read', executionId, target };
    }
    case 'delivery_unknown':
      return { kind: 'unknown' };
    case 'expired':
      if (carried && carried.state !== 'dismissed') {
        if (carried.state === 'queued') return { kind: 'carriedWaiting' };
        if (carried.state === 'refused') return { kind: 'carriedRefused', carried };
        return { kind: 'carriedStarted' };
      }
      return { kind: 'notDelivered' };
    default:
      return { kind: 'notDelivered' };
  }
}

/** What kind of message it was, when it was more than a plain request or an instruction. */
export function entryKind(
  entry: Pick<SessionEntry, 'intent' | 'commandId' | 'carriedFrom'>,
): 'scheduled' | 'queue' | 'explain' | null {
  if (entry.commandId?.startsWith('scheduled_')) return 'scheduled';
  // A carried request's line says it was carried; "queue" would only repeat it.
  if (entry.carriedFrom) return null;
  return entry.intent === 'queue' || entry.intent === 'explain' ? entry.intent : null;
}

/** How each entry is drawn in the conversation. */
export interface EntryPlacement {
  /** A carried request whose source instruction is in the conversation: its run row alone. */
  runOnly: Set<string>;
  /** A source instruction's carried request, by the instruction's entry id. */
  carriedOf: Map<string, SessionEntry>;
}

/**
 * A carried request is drawn once (features/composer-flow.md): when the instruction it was
 * carried from is in the conversation, that message stays and the request adds only its run
 * row. `directiveOf` gives an instruction's directive, `undefined` while its record is unread.
 * While any instruction is unread a carried request is taken to have its source here, which is
 * the usual case, so its message does not appear and then go.
 */
export function placeEntries(
  entries: readonly SessionEntry[],
  directiveOf: (entry: SessionEntry) => DirectiveView | null | undefined,
): EntryPlacement {
  const runOnly = new Set<string>();
  const carriedOf = new Map<string, SessionEntry>();
  const shown = entries.filter((entry) => entry.state !== 'dismissed');
  const steers = shown.filter((entry) => entry.intent === 'steer');
  const unread = steers.some((entry) => entry.runId && directiveOf(entry) === undefined);
  for (const entry of entries) {
    if (!entry.carriedFrom || entry.state === 'dismissed') continue;
    const source = steers.find((steer) => directiveOf(steer)?.directiveId === entry.carriedFrom);
    if (source) {
      carriedOf.set(source.entryId, entry);
      runOnly.add(entry.entryId);
    } else if (unread) runOnly.add(entry.entryId);
  }
  return { runOnly, carriedOf };
}
