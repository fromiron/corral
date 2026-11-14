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
  const own = useMemo(() => {
    const session = createRunSession(transport);
    // A finished row the timeline unmounted off screen comes back with what it last showed
    // while its record is read again. Its bodies count only when they were confirmed for the
    // artifact metadata the session has now (api-contract.md, 산출물 본문 수명). Its conversation
    // turn's answer is kept apart from those bodies and never released, so it always comes back.
    // What is remembered is tied to this session object: StrictMode may build two.
    const kept = runViews.get(runId);
    if (kept) {
      const confirmed = kept.revision === revision.current;
      session.setState(confirmed ? kept.view : withoutBodies(kept.view));
      checkedFor.set(session, { runId, revision: kept.revision });
      recalledFor.set(session, { runId, turn: kept.turn });
    }
    return session;
  }, [transport, runId]);
  // WorkTab owns the live store and its transport. A card may mount before that owner's
  // open() resolves; starting an independent subscription during that gap duplicates it.
  const store = live ? runFor(runId) : own;
  const readDetails = !live && details;
  const state = useStore(store);
  // Which store's record read has settled (resolved or failed), and which one's last failed.
  const [readOf, setReadOf] = useState<RunSession | null>(null);
  const [readFailedOf, setReadFailedOf] = useState<RunSession | null>(null);
  // A metadata read that failed: the bodies it was to confirm stay unconfirmed.
  const [checkFailed, setCheckFailed] = useState<{ store: RunSession; revision: string } | null>(
    null,
  );

  const last = useRef<{ runId: string; store: typeof store; state: typeof state } | null>(null);
  // The session of the row while it is mounted.
  const mounted = useRef<RunSession | null>(null);
  const [conversation, setConversation] = useState<{
    runId: string;
    turn: StoredConversationTurn | null;
  } | null>(null);
  const recalled = recalledFor.get(own);
  const conversationTurn = live
    ? null
    : conversation?.runId === runId
      ? conversation.turn
      : recalled?.runId === runId
        ? recalled.turn
        : null;
  // What a successful record read shows, keeping only still-readable bodies across the
  // live-to-snapshot handoff.
  const applyRead = useRef<(view: RunView, readRevision: string | undefined) => void>(() => {});
  applyRead.current = (view, readRevision) => {
    const { conversationTurn: turn, ...runView } = view;
    const projection = keepKnownReleases(view.projection, own.getState().projection);
    checkedFor.set(own, { runId, revision: readRevision });
    setConversation({ runId, turn });
    setReadOf(own);
    setReadFailedOf(null);
    own.setState({
      ...runView,
      projection,
      artifactTexts: Object.fromEntries(
        Object.entries({
          ...(last.current?.runId === runId ? last.current.state.artifactTexts : {}),
          ...own.getState().artifactTexts,
          ...view.artifactTexts,
        }).filter(([id]) => canReadArtifactBody(projection, id)),
      ),
    });
  };
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
        if (current) applyRead.current(view, readRevision);
      },
      (error: unknown) => {
        if (!current) return;
        setReadOf(own);
        setReadFailedOf(own);
        own.setState({ runId, streamError: errorText(error) });
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
  // mount, as for a row seen for the first time. After a failed record read the metadata read is
  // followed by one more record read; the error stays until a record read succeeds.
  const recordFailed = readFailedOf === own;
  useEffect(() => {
    if (live || metadataVersion === undefined || state.runId !== runId || !state.projection) return;
    if (readOf !== own) return;
    const checked = checkedFor.get(own);
    if (checked?.runId === runId && checked.revision === metadataVersion) return;
    let current = true;
    void transport
      .getSnapshot(runId)
      .then(({ projection: next }) => {
        if (!current) return;
        if (next.runId !== runId) throw new Error('The run metadata does not match this turn.');
        const before = own.getState();
        const projection = keepKnownReleases(next, before.projection);
        checkedFor.set(own, { runId, revision: metadataVersion });
        own.setState({
          projection,
          artifactTexts: Object.fromEntries(
            Object.entries(before.artifactTexts).filter(([id]) =>
              canReadArtifactBody(projection, id),
            ),
          ),
          // A response's words are its body once the response is recorded, and go when it is
          // released. Words never recorded (a response an interrupt cut) are no body: they stay.
          streams: Object.fromEntries(
            Object.entries(before.streams).filter(([id]) => {
              const ref = projection.modelCalls[id]?.responseRef;
              return !ref || canReadArtifactBody(projection, ref);
            }),
          ),
          ...(recordFailed ? {} : { streamError: null }),
        });
        if (!recordFailed) return;
        // The metadata just set re-runs this effect; the read again belongs to the row's session.
        void readRunView(transport, readHistory, runId, readDetails).then(
          (view) => {
            if (mounted.current === own) applyRead.current(view, metadataVersion);
          },
          (error: unknown) => {
            if (mounted.current === own) own.setState({ streamError: errorText(error) });
          },
        );
      })
      .catch((error: unknown) => {
        if (!current) return;
        setCheckFailed({ store: own, revision: metadataVersion });
        own.setState({ streamError: errorText(error) });
      });
    return () => {
      current = false;
    };
  }, [
    own,
    runId,
    transport,
    readHistory,
    readDetails,
    live,
    metadataVersion,
    state.runId,
    state.projection,
    readOf,
    recordFailed,
  ]);
  const checked = checkedFor.get(own);
  const bodyMetadataCurrent =
    live ||
    metadataVersion === undefined ||
    !checked ||
    checked.runId !== runId ||
    checked.revision === metadataVersion;
  // Nothing still being read can confirm the bodies: they stay out, and the error says why.
  const bodyCheckFailed =
    !bodyMetadataCurrent && checkFailed?.store === own && checkFailed.revision === metadataVersion;
  useEffect(() => {
    mounted.current = own;
    return () => {
      mounted.current = null;
      own.getState().dispose();
    };
  }, [own]);
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
    return {
      store: kept.store,
      state: kept.state,
      conversationTurn,
      bodyMetadataCurrent,
      bodyCheckFailed,
      settled,
    };
  return {
    store,
    state: current ?? { ...state, projection: null, definition: null, streamError: null },
    conversationTurn,
    bodyMetadataCurrent,
    bodyCheckFailed,
    settled,
  };
}

type RunSession = ReturnType<typeof createRunSession>;
type RunView = Awaited<ReturnType<typeof readRunView>>;
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
// Per run session: the metadata version its bodies were last confirmed for, and the remembered
// conversation turn it came back with.
const checkedFor = new WeakMap<RunSession, { runId: string; revision: string | undefined }>();
const recalledFor = new WeakMap<
  RunSession,
  { runId: string; turn: StoredConversationTurn | null }
>();

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
