import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { canReadArtifactBody, type RunProjection, type StoredConversationTurn } from '@corral/core';
import { createRunSession, type RunSessionState } from '@corral/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import { readRunView } from './readRunView.ts';
import { forgetOnReset } from './viewMemory.ts';

/** Reading another turn must not replace the active run's command/retry state. */
export function useCorralRun(
  runId: string,
  live: boolean,
  details: boolean,
  metadataVersion?: string,
) {
  const { transport, readHistory, runFor, retainRun } = useServices();
  const revision = useRef(metadataVersion);
  revision.current = metadataVersion;
  const checked = useRef<{
    store: RunSession;
    runId: string;
    revision: string | undefined;
  } | null>(null);
  // The answer the remembered view may show; null when its body is not confirmed for now.
  const recalledTurn = useRef<{ runId: string; turn: StoredConversationTurn | null } | null>(null);
  const own = useMemo(() => {
    const session = createRunSession(transport);
    // A finished row the timeline unmounted off screen comes back with what it last showed
    // while its record is read again. Its bodies count only when they were confirmed for the
    // artifact metadata the session has now (api-contract.md, 산출물 본문 수명).
    const kept = runViews.get(runId);
    if (kept) {
      const confirmed = kept.revision === revision.current;
      session.setState(confirmed ? kept.view : withoutBodies(kept.view));
      checked.current = { store: session, runId, revision: kept.revision };
      recalledTurn.current = { runId, turn: confirmed ? kept.turn : null };
    }
    return session;
  }, [transport, runId]);
  // WorkTab owns the live store and its transport. A card may mount before that owner's
  // open() resolves; starting an independent subscription during that gap duplicates it.
  const store = live ? runFor(runId) : own;
  const readDetails = !live && details;
  const state = useStore(store);
  // Which store's record read has settled (resolved or failed).
  const [readOf, setReadOf] = useState<RunSession | null>(null);

  const last = useRef<{ runId: string; store: typeof store; state: typeof state } | null>(null);
  const [conversation, setConversation] = useState<{
    runId: string;
    turn: StoredConversationTurn | null;
  } | null>(null);
  const conversationTurn = live
    ? null
    : conversation?.runId === runId
      ? conversation.turn
      : recalledTurn.current?.runId === runId
        ? recalledTurn.current.turn
        : null;
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
          setReadOf(own);
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
        if (!current) return;
        setReadOf(own);
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
  // A remembered view waits for its record read, which reads the snapshot itself: one read per
  // mount, as for a row seen for the first time.
  useEffect(() => {
    if (live || metadataVersion === undefined || state.runId !== runId || !state.projection) return;
    if (readOf !== own) return;
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
  }, [own, runId, transport, live, metadataVersion, state.runId, state.projection, readOf]);
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
    // Only a finished run is remembered, and only as far as its bodies are confirmed: a run
    // still working comes back by reading its record.
    if (TERMINAL_RUN_STATUSES.has(current.projection.status) && bodyMetadataCurrent)
      keepRunView(runId, current, conversationTurn, metadataVersion);
  }
  // A view read from the server again, or a live one: nothing remembered is still settling.
  const settled = live || readOf === own;
  const kept = last.current;
  if (!current?.projection && !current?.streamError && kept?.runId === runId)
    return { store: kept.store, state: kept.state, conversationTurn, bodyMetadataCurrent, settled };
  return {
    store,
    state: current ?? { ...state, projection: null, definition: null, streamError: null },
    conversationTurn,
    bodyMetadataCurrent,
    settled,
  };
}

type RunSession = ReturnType<typeof createRunSession>;
type ViewData = Pick<
  RunSessionState,
  'runId' | 'projection' | 'definition' | 'events' | 'streams' | 'artifactTexts'
>;
type KeptView = {
  /** The artifact metadata version its bodies were confirmed for. */
  revision: string | undefined;
  turn: StoredConversationTurn | null;
  view: ViewData;
};

// What recently shown finished runs last showed, newest kept. It outlives the row, not the page.
const RUN_VIEW_LIMIT = 64;
const runViews = new Map<string, KeptView>();

/** The view without anything read from an artifact body: those wait for a fresh check. */
function withoutBodies(view: ViewData): ViewData {
  const projection = view.projection;
  return {
    ...view,
    artifactTexts: {},
    // A response's words are its body once the response is recorded.
    streams: Object.fromEntries(
      Object.entries(view.streams).filter(([id]) => !projection?.modelCalls[id]?.responseRef),
    ),
  };
}

function keepRunView(
  runId: string,
  state: RunSessionState,
  turn: StoredConversationTurn | null,
  revision: string | undefined,
) {
  const { projection, definition, events, streams, artifactTexts } = state;
  const prior = runViews.get(runId);
  if (
    prior &&
    prior.revision === revision &&
    prior.turn === turn &&
    prior.view.projection === projection &&
    prior.view.definition === definition &&
    prior.view.events === events &&
    prior.view.streams === streams &&
    prior.view.artifactTexts === artifactTexts
  )
    return;
  runViews.delete(runId);
  runViews.set(runId, {
    revision,
    turn,
    view: { runId, projection, definition, events, streams, artifactTexts },
  });
  while (runViews.size > RUN_VIEW_LIMIT) {
    const oldest = runViews.keys().next().value;
    if (oldest === undefined) break;
    runViews.delete(oldest);
  }
}

forgetOnReset(() => runViews.clear());

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
