import type { CompactSessionCommand, Receipt } from '@corral/contracts';
import { useCallback, useSyncExternalStore } from 'react';
import { type StudioServices, useServices } from '../services.tsx';
import { newCommandId } from '../sessionActions.ts';
import type { SessionSummaryState } from './sessionSummaryStore.ts';

type Requester = Pick<StudioServices, 'repository' | 'compactSession' | 'sessionSummaries'>;

/** The refusal or lost-request message, or null when accepted; and the command id that was sent. */
export interface SessionCompactionSent {
  failure: string | null;
  commandId: string | null;
}

type Slot = {
  commandId: string;
  pending: Promise<string | null> | null;
  done: boolean;
};

const inflight = new Map<string, Slot>();

/**
 * Sends session compaction. A lost response is asked again with the same command id.
 * A new click after a stored receipt uses a new id. An accepted command is then followed in
 * the shared session summary until it settles.
 */
export async function requestSessionCompaction(
  services: Requester,
  sessionId: string,
): Promise<SessionCompactionSent> {
  if (!services.compactSession) return { failure: null, commandId: null };
  let slot = inflight.get(sessionId);
  if (!slot || slot.done) {
    slot = { commandId: newCommandId(), pending: null, done: false };
    inflight.set(sessionId, slot);
  }
  let pending = slot.pending;
  if (!pending) {
    const current = slot;
    pending = send(services, sessionId, current.commandId).then(
      (message) => {
        current.done = true;
        return message;
      },
      (error: unknown) => {
        current.pending = null;
        throw error;
      },
    );
    current.pending = pending;
  }
  const commandId = slot.commandId;
  const failure = await pending.catch((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  );
  return { failure, commandId };
}

async function send(
  services: Requester,
  sessionId: string,
  commandId: string,
): Promise<string | null> {
  const compact = services.compactSession;
  if (!compact) return null;
  const session = await services.repository.getSession(sessionId);
  if (!session) return 'This session no longer exists.';
  const command: CompactSessionCommand = {
    schemaVersion: '0.1',
    type: 'compact_session',
    commandId,
    sessionId,
    expectedSessionRevision: session.revision,
  };
  const once = () => compact(command);
  let receipt: Receipt;
  try {
    receipt = await once();
  } catch {
    receipt = await once();
  }
  if (receipt.status === 'accepted') services.sessionSummaries?.accepted(sessionId, commandId);
  return receipt.error?.message ?? null;
}

/** Where the summary divider sits: after the last covered row, or at the top when none is visible. */
export function summaryCut(runIds: readonly (string | null)[], covered: readonly string[]): number {
  const ids = new Set(covered);
  let index = -1;
  for (let cursor = 0; cursor < runIds.length; cursor += 1) {
    const runId = runIds[cursor];
    if (runId && ids.has(runId)) index = cursor;
  }
  return index;
}

const NONE: SessionSummaryState = { view: null, outcome: null };

/** The session's kept summary and the outcome of the compaction it is waiting on. */
export function useSessionSummaryState(sessionId: string): SessionSummaryState {
  const { sessionSummaries } = useServices();
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionSummaries ? sessionSummaries.subscribe(sessionId, listener) : () => {},
    [sessionSummaries, sessionId],
  );
  return useSyncExternalStore(subscribe, () => sessionSummaries?.get(sessionId) ?? NONE);
}

export function useSessionSummary(sessionId: string) {
  return useSessionSummaryState(sessionId).view;
}
