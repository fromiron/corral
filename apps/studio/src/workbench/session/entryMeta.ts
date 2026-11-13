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
  /**
   * What the directive was before this view watched it expire, while the session has not been
   * read since (features/composer-flow.md): the line keeps saying that until it has.
   */
  heldAs?: DirectiveView['status'],
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
      // Whether it was carried is the session's word alone.
      if (carried) {
        if (carried.state === 'queued') return { kind: 'carriedWaiting' };
        if (carried.state === 'refused') return { kind: 'carriedRefused', carried };
        // Taken out of the queue, or back into the box to edit: it went nowhere.
        if (carried.state === 'dismissed') return { kind: 'notDelivered' };
        return { kind: 'carriedStarted' };
      }
      if (heldAs && heldAs !== 'expired')
        return steerMeta({ ...record, directive: { ...directive, status: heldAs } }, undefined);
      return { kind: 'notDelivered' };
    default:
      return { kind: 'notDelivered' };
  }
}

/** What kind of message it was, when it was more than a plain request or an instruction. */
export function entryKind(
  entry: Pick<SessionEntry, 'intent' | 'commandId'>,
): 'scheduled' | 'explain' | null {
  // A next request waiting in the queue is a request like any other, not a kind of message.
  if (entry.commandId?.startsWith('scheduled_')) return 'scheduled';
  return entry.intent === 'explain' ? 'explain' : null;
}

/** Whether an entry is an item of the conversation (the queue and removed ones are not). */
export const inConversation = (entry: Pick<SessionEntry, 'state'>) =>
  entry.state !== 'queued' && entry.state !== 'dismissed';

/** How each entry is drawn in the conversation. */
export interface EntryPlacement {
  /** A carried request right under its source instruction: its run row alone. */
  runOnly: Set<string>;
  /** A source instruction's carried request, by the instruction's entry id, in any state. */
  carriedOf: Map<string, SessionEntry>;
  /** Source instructions whose carried request is right under them: they take its actions. */
  carriesActions: Set<string>;
  /** An item drawn as nothing (a carried request that did not start, under its source). */
  emptyFor: Map<string, string>;
  /** Carried requests whose source message is in the conversation, which says it was carried. */
  sourced: Set<string>;
}

/**
 * A carried request is drawn once (features/composer-flow.md): when the instruction it was
 * carried from is the item right above it, that message stays and the request adds only its
 * run row. With its source elsewhere (another item between, or none in the conversation) it
 * draws its own message. `directiveOf` gives an instruction's directive, `undefined` while its
 * record is unread; a carried request right under an unread instruction is taken to be its,
 * the usual case, so its message does not appear and then go.
 */
export function placeEntries(
  entries: readonly SessionEntry[],
  directiveOf: (entry: SessionEntry) => DirectiveView | null | undefined,
): EntryPlacement {
  const placement: EntryPlacement = {
    runOnly: new Set(),
    carriedOf: new Map(),
    carriesActions: new Set(),
    emptyFor: new Map(),
    sourced: new Set(),
  };
  const steers = entries.filter((entry) => entry.intent === 'steer' && entry.state !== 'dismissed');
  const shown = entries.filter(inConversation);
  for (const entry of entries) {
    if (!entry.carriedFrom) continue;
    const source = steers.find((steer) => directiveOf(steer)?.directiveId === entry.carriedFrom);
    if (source) placement.carriedOf.set(source.entryId, entry);
    const at = shown.indexOf(entry);
    if (at < 0) continue;
    // Its source is here; or, while an instruction before it is unread, taken to be.
    if (
      source
        ? shown.includes(source)
        : shown
            .slice(0, at)
            .some((item) => item.intent === 'steer' && item.runId != null && !directiveOf(item))
    )
      placement.sourced.add(entry.entryId);
    const above = shown[at - 1];
    const under =
      above !== undefined &&
      (source
        ? above === source
        : above.intent === 'steer' && above.runId != null && directiveOf(above) === undefined);
    if (!under) continue;
    placement.runOnly.add(entry.entryId);
    placement.carriesActions.add(above.entryId);
    if (!entry.runId) placement.emptyFor.set(entry.entryId, above.entryId);
  }
  return placement;
}
