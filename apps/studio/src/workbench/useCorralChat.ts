import { canReadArtifactBody, type RunProjection, type StoredConversationTurn } from '@corral/core';
import { createRunSession, type RunSessionState } from '@corral/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import { readRunView } from './readRunView.ts';

/** Reading another turn must not replace the active run's command/retry state. */
export function useCorralRun(
  runId: string,
  live: boolean,
  details: boolean,
  metadataVersion?: string,
) {
  const { transport, readHistory, runFor, retainRun } = useServices();
  const own = useMemo(() => {
    const session = createRunSession(transport);
    // A row the timeline unmounted off screen comes back with what it last showed, at the
    // same height, while its record is read again.
    const kept = runViews.get(runId);
    if (kept) session.setState(kept.view);
    return session;
  }, [transport, runId]);
  // WorkTab owns the live store and its transport. A card may mount before that owner's
  // open() resolves; starting an independent subscription during that gap duplicates it.
  const store = live ? runFor(runId) : own;
  const readDetails = !live && details;
  const state = useStore(store);
  const revision = useRef(metadataVersion);
  revision.current = metadataVersion;
  const checked = useRef<{ store: typeof own; runId: string; revision: string | undefined } | null>(
    null,
  );

  const last = useRef<{ runId: string; store: typeof store; state: typeof state } | null>(null);
  const [conversation, setConversation] = useState<{
    runId: string;
    turn: StoredConversationTurn | null;
  } | null>(() => {
    const kept = runViews.get(runId);
    return kept ? { runId, turn: kept.turn } : null;
  });
  const conversationTurn = !live && conversation?.runId === runId ? conversation.turn : null;
  useEffect(() => {
    if (live) {
      const release = retainRun(runId);
      void store.getState().open(runId);
      return release;
    }
    let current = true;
    const readRevision = revision.current;
    void readRunView(transport, readHistory, runId, readDetails).then(
      (view) => {
        if (current) {
          const { conversationTurn: turn, ...runView } = view;
          const projection = keepKnownReleases(view.projection, own.getState().projection);
          checked.current = { store: own, runId, revision: readRevision };
          setConversation({ runId, turn });
          own.setState({
            ...runView,
            projection,
            // Keep only still-readable bodies across the live-to-snapshot handoff.
            artifactTexts: Object.fromEntries(
              Object.entries({
                ...(last.current?.runId === runId ? last.current.state.artifactTexts : {}),
                ...own.getState().artifactTexts,
                ...view.artifactTexts,
              }).filter(([id]) => canReadArtifactBody(projection, id)),
            ),
          });
        }
      },
      (error: unknown) => {
        if (current)
          own.setState({
            runId,
            streamError: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      current = false;
      own.getState().dispose();
    };
  }, [own, store, runId, transport, readHistory, live, readDetails, retainRun]);
  // A newer successful sibling can retire a completed result while this card stays mounted.
  // The host already observes that success; this reads only current metadata, never its archive/body.
  useEffect(() => {
    if (live || metadataVersion === undefined || state.runId !== runId || !state.projection) return;
    if (
      checked.current?.store === own &&
      checked.current.runId === runId &&
      checked.current.revision === metadataVersion
    )
      return;
    let current = true;
    void transport
      .getSnapshot(runId)
      .then(({ projection: next }) => {
        if (!current) return;
        if (next.runId !== runId) throw new Error('The run metadata does not match this turn.');
        const before = own.getState();
        const projection = keepKnownReleases(next, before.projection);
        checked.current = { store: own, runId, revision: metadataVersion };
        own.setState({
          projection,
          artifactTexts: Object.fromEntries(
            Object.entries(before.artifactTexts).filter(([id]) =>
              canReadArtifactBody(projection, id),
            ),
          ),
          streams: Object.fromEntries(
            Object.entries(before.streams).filter(([id]) => {
              const ref = projection.modelCalls[id]?.responseRef;
              return !!ref && canReadArtifactBody(projection, ref);
            }),
          ),
          streamError: null,
        });
      })
      .catch((error: unknown) => {
        if (current)
          own.setState({ streamError: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      current = false;
    };
  }, [own, runId, transport, live, metadataVersion, state.runId, state.projection]);
  const bodyMetadataCurrent =
    live ||
    metadataVersion === undefined ||
    !checked.current ||
    checked.current.store !== own ||
    checked.current.runId !== runId ||
    checked.current.revision === metadataVersion;
  useEffect(() => () => own.getState().dispose(), [own]);
  const current = state.runId === runId ? state : null;
  // A finishing turn swaps the live store for a finished snapshot that loads asynchronously.
  // Keep the last loaded view of this run meanwhile, so its work log stays mounted.
  if (current?.projection) {
    last.current = { runId, store, state: current };
    keepRunView(runId, current, conversationTurn);
  }
  const kept = last.current;
  if (!current?.projection && !current?.streamError && kept?.runId === runId)
    return { store: kept.store, state: kept.state, conversationTurn, bodyMetadataCurrent };
  return {
    store,
    state: current ?? { ...state, projection: null, definition: null, streamError: null },
    conversationTurn,
    bodyMetadataCurrent,
  };
}

type RunState = RunSessionState;
type KeptView = {
  source: RunState;
  turn: StoredConversationTurn | null;
  view: Pick<
    RunState,
    'runId' | 'projection' | 'definition' | 'events' | 'streams' | 'artifactTexts'
  >;
};

// What recently shown runs last showed, newest kept. It outlives the row, not the page.
const RUN_VIEW_LIMIT = 64;
const runViews = new Map<string, KeptView>();

function keepRunView(runId: string, state: RunState, turn: StoredConversationTurn | null) {
  const prior = runViews.get(runId);
  if (prior?.source === state && prior.turn === turn) return;
  const { projection, definition, events, streams, artifactTexts } = state;
  runViews.delete(runId);
  runViews.set(runId, {
    source: state,
    turn,
    view: { runId, projection, definition, events, streams, artifactTexts },
  });
  while (runViews.size > RUN_VIEW_LIMIT) {
    const oldest = runViews.keys().next().value;
    if (oldest === undefined) break;
    runViews.delete(oldest);
  }
}

/** Forgets the kept run views; tests start from none. */
export function resetRunViews() {
  runViews.clear();
}

/** A late archive read cannot restore a body already confirmed as released for this Run. */
function keepKnownReleases(next: RunProjection, previous: RunProjection | null): RunProjection {
  if (previous?.runId !== next.runId) return next;
  const retired = Object.values(previous.artifacts).filter(
    (artifact) =>
      artifact.bodyAvailable === false &&
      next.artifacts[artifact.artifactVersionId]?.bodyAvailable !== false,
  );
  if (!retired.length) return next;
  const artifacts = { ...next.artifacts };
  for (const artifact of retired) {
    const incoming = artifacts[artifact.artifactVersionId];
    if (incoming) artifacts[artifact.artifactVersionId] = { ...incoming, bodyAvailable: false };
  }
  return { ...next, artifacts };
}
