import type { CompactSessionCommand, Receipt } from '@corral/contracts';
import { useEffect, useState } from 'react';
import { type StudioServices, useServices } from '../services.tsx';
import { newCommandId } from '../sessionActions.ts';

type Slot = {
  commandId: string;
  pending: Promise<string | null> | null;
  done: boolean;
};

const inflight = new Map<string, Slot>();

/**
 * Sends session compaction. A lost response is asked again with the same command id.
 * A new click after a stored receipt uses a new id.
 */
export async function requestSessionCompaction(
  services: Pick<StudioServices, 'repository' | 'compactSession'>,
  sessionId: string,
): Promise<string | null> {
  if (!services.compactSession) return null;
  let slot = inflight.get(sessionId);
  if (!slot || slot.done) {
    slot = { commandId: newCommandId(), pending: null, done: false };
    inflight.set(sessionId, slot);
  }
  if (!slot.pending) {
    const current = slot;
    current.pending = send(services, sessionId, current.commandId).then(
      (message) => {
        current.done = true;
        return message;
      },
      (error: unknown) => {
        current.pending = null;
        throw error;
      },
    );
  }
  return slot.pending;
}

async function send(
  services: Pick<StudioServices, 'repository' | 'compactSession'>,
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

export function useSessionSummary(sessionId: string) {
  const { readSessionCompaction } = useServices();
  const [view, setView] = useState<Awaited<
    ReturnType<NonNullable<StudioServices['readSessionCompaction']>>
  > | null>(null);
  useEffect(() => {
    if (!readSessionCompaction) {
      setView(null);
      return;
    }
    let current = true;
    void readSessionCompaction(sessionId).then((next) => {
      if (current) setView(next);
    });
    return () => {
      current = false;
    };
  }, [readSessionCompaction, sessionId]);
  return view;
}
