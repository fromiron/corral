import type { RunStatus } from '@corral/contracts';
import { discardCancelConfirmation } from '@corral/react';
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { patchSessionSearch, type SessionSearch, validateSessionSearch } from '../panels/routes.ts';
import { nextSearch, readAddress, TAB_PARAMS, withoutFrameParams } from './address.ts';
import { historyActionOf, travelled } from './historyActions.ts';
import { deviceStorage, readPanelMemory, writePanelMemory } from './memory.ts';
import {
  EMPTY_PANEL,
  type EntryVia,
  type PanelEvent,
  type PanelResult,
  type PanelState,
  reducePanel,
  runTabHeadRun,
} from './model.ts';
import {
  PANEL_TAB_OF,
  type PanelContext,
  type PanelFronts,
  type PanelTarget,
  type TabKey,
  tabKey,
} from './tabs.ts';
import { hasRoom } from './width.ts';

// The session frame's wiring of the panel model (model.ts) to the router, the history and this
// device's memory. One state per conversation: the page stays mounted across conversations, and
// a state held for another conversation is never shown or written for this one.

function tabParams(search: SessionSearch): SessionSearch {
  const out: SessionSearch = {};
  for (const key of TAB_PARAMS)
    if (search[key] !== undefined) Object.assign(out, { [key]: search[key] });
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const frameParams = (search: SessionSearch) => {
  const rest = withoutFrameParams(search as Record<string, unknown>);
  const all = search as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(all)
      .filter((key) => !(key in rest))
      .sort()
      .map((key) => [key, all[key]]),
  );
};

interface LocationState {
  corralPanelWrite?: string;
  corralEntry?: 'outside';
}

export interface PanelFrameInput {
  sessionId: string;
  /** The session route's validated search. */
  search: SessionSearch;
  /** The work area's width in px; null until it has been measured. */
  workArea: number | null;
  folder: boolean;
  /** The conversation's runs, oldest first, once a listing after the entry answered. */
  runIds: readonly string[] | null;
  /** Server mode with a Paddock: the "+" list has 터미널. */
  paddock?: boolean;
  /** The conversation's terminals once the list asked since the entry answered; null until. */
  terminalIds?: readonly string[] | null;
  /**
   * An address the bottom dock opens arrived (entering or followed, never Back or Forward):
   * `panel=debug`, or `panel=terminal` whose terminal has no tab in the panel. `focus`: it was a
   * link the person followed in the app.
   */
  onDockAddress?: (target: PanelTarget, focus: boolean) => void;
  /** The conversation is to come forward: what came with it (an address's `respond`). */
  onBringForward?: (search: SessionSearch) => void;
  /**
   * A link the person followed (in the app, or from another screen into this conversation)
   * opened or selected a tab: what it asked for, and the panel before and after. The frame's own
   * writes, Back and Forward, a restore on entry and a reload are not links.
   */
  onOpenedByLink?: (search: SessionSearch, next: PanelState, before: PanelState) => void;
}

export interface PanelFrame {
  state: PanelState;
  ctx: PanelContext;
  /** The room is known and the conversation has been entered. */
  entered: boolean;
  dispatch(event: PanelEvent, own?: SessionSearch): PanelResult;
  /** A change made inside the selected tab (its view, result, execution …), written whole. */
  writeTab(patch: Partial<SessionSearch>, options?: { replace?: boolean }): void;
  /** The state the tab had in the address when it was last selected. */
  tabSearch(key: TabKey): SessionSearch | undefined;
  /** The window or view in front inside 파일 and 변경, as their address last named it. */
  fronts: PanelFronts;
}

export function usePanelFrame(input: PanelFrameInput): PanelFrame {
  const { sessionId, workArea, folder, runIds, paddock = false, terminalIds = null } = input;
  const router = useRouter();
  // The search of this very entry: the route's own search can lag a render behind the location.
  const arrivedKey = useRouterState({ select: (s) => JSON.stringify(s.location.search) });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const here = pathname === `/sessions/${encodeURIComponent(sessionId)}`;
  const search = useMemo(
    () =>
      here
        ? validateSessionSearch(JSON.parse(arrivedKey) as Record<string, unknown>)
        : input.search,
    [here, arrivedKey, input.search],
  );
  const navigate = useNavigate();
  const room = workArea === null ? null : hasRoom(workArea);
  // The front inside 파일 and 변경: whatever the address last named while that tab was the
  // selected one, kept in one place (here) for this conversation only.
  const fronts = useRef<PanelFronts>({});
  const ctx: PanelContext = {
    room: room ?? false,
    folder,
    runIds,
    paddock,
    terminalIds,
    front: fronts.current,
  };
  const [held, setHeld] = useState<{ sessionId: string; state: PanelState } | null>(null);
  const state = held?.sessionId === sessionId ? held.state : EMPTY_PANEL;
  const entered = held?.sessionId === sessionId;

  // What the handlers read: always the latest render's.
  const latest = useRef({ sessionId, search, ctx, state, input });
  latest.current = { sessionId, search, ctx, state, input };
  const heldRef = useRef(held);
  heldRef.current = held;
  const tabStates = useRef(new Map<string, SessionSearch>());
  // What the address says of the selected tab: its own state, and for 파일 and 변경 the front.
  const note = useCallback((search: SessionSearch, state: PanelState) => {
    const selected = state.selected;
    if (!selected || state.presentation === 'closed' || !search.panel) return;
    const kind = PANEL_TAB_OF[search.panel];
    const named =
      kind === 'run'
        ? search.run
          ? `run:${search.run}`
          : null
        : kind === 'terminal'
          ? search.terminal
            ? `terminal:${search.terminal}`
            : null
          : kind;
    if (named !== selected) return;
    tabStates.current.set(selected, tabParams(search));
    if (kind === 'files' || kind === 'changes')
      fronts.current = { ...fronts.current, [kind]: search.panel };
  }, []);
  // The mark this page puts on each address it writes: this page's own nonce and a count. An
  // entry reached by push or replace that carries this page's nonce is the frame's own write; a
  // mark from an earlier page (before a reload) is not.
  const [nonce] = useState(() => globalThis.crypto.randomUUID());
  const lastToken = useRef(0);
  const lastWritten = useRef<{ written: string; token: string } | null>(null);

  const write = useCallback(
    (next: SessionSearch, mode: 'push' | 'replace') => {
      const written = JSON.stringify(validateSessionSearch({ ...next }));
      // Written already: the router is on its way to it, or it is there. A write refused on the
      // way (a settings dialog with unsaved changes the person stays in) is neither, and is
      // written again (features/session-panel.md 주소와 기억: the frame's address always says
      // what the panel shows).
      const before = lastWritten.current;
      if (before?.written === written && mode === 'replace') {
        const going = router.state.status === 'pending';
        const there =
          (router.history.location.state as LocationState).corralPanelWrite === before.token;
        if (going || there) return;
      }
      lastToken.current += 1;
      const token = `${nonce}:${lastToken.current}`;
      lastWritten.current = { written, token };
      void navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: latest.current.sessionId },
        // What the frame does not read (the settings dialog's `settings`, `settingsProject`)
        // stays as the address has it (features/session-panel.md 주소와 기억).
        search: ((previous: Record<string, unknown> | undefined) => {
          const { tab: _legacy, ...unread } = withoutFrameParams(previous ?? {});
          return { ...unread, ...next };
        }) as never,
        replace: mode === 'replace',
        state: ((previous: Record<string, unknown>) => ({
          ...previous,
          corralEntry: undefined,
          corralPanelWrite: token,
        })) as never,
        resetScroll: false,
      });
    },
    [navigate, nonce, router],
  );

  const dispatch = useCallback(
    (event: PanelEvent, own?: SessionSearch): PanelResult => {
      const now = latest.current;
      const entered = heldRef.current?.sessionId === now.sessionId;
      const before = entered && heldRef.current ? heldRef.current.state : EMPTY_PANEL;
      // Until the conversation is entered, only the entry counts: an earlier event (an advice
      // arrival's bring-forward) would otherwise stand in for the entry and lose the memory.
      if (!entered && event.type !== 'enter') return unchanged(before);
      // Another conversation's tabs leave nothing behind (features/session-panel.md): a
      // conversation entered again starts its tabs as if first opened.
      if (event.type === 'enter') {
        tabStates.current.clear();
        fronts.current = {};
      } else note(now.search, before);
      const result = reducePanel(before, event, { ...now.ctx, front: fronts.current });
      // In this same update, before any holder renders again: a place that lost its controls
      // never lets another place's confirmation show for a moment.
      if (result.dropHeadConfirmation) {
        const run = runTabHeadRun(before);
        if (run) discardCancelConfirmation(run);
      }
      const next = { sessionId: now.sessionId, state: result.state };
      heldRef.current = next;
      setHeld(next);
      if (result.state !== before || event.type === 'enter')
        writePanelMemory(deviceStorage(), now.sessionId, result.state);
      for (const key of [...tabStates.current.keys()])
        if (!result.state.tabs.some((tab) => tabKey(tab) === key)) tabStates.current.delete(key);
      // A closed tab's front goes with its state: opened again, it starts at its own first view.
      for (const kind of ['files', 'changes'] as const)
        if (fronts.current[kind] && !result.state.tabs.some((tab) => tab.kind === kind)) {
          const { [kind]: _gone, ...rest } = fronts.current;
          fronts.current = rest;
        }
      // A toggle or a close selects a tab by itself: that tab comes back with its own state.
      const ownState =
        own ??
        ((event.type === 'toggle' || event.type === 'close') && result.state.selected
          ? tabStates.current.get(result.state.selected)
          : undefined);
      if (result.history) {
        const target = nextSearch(now.search, result, ownState);
        const current = validateSessionSearch({ ...now.search });
        if (!same(validateSessionSearch({ ...target }), current)) write(target, result.history);
      }
      if (result.bringForward)
        now.input.onBringForward?.(event.type === 'bringForward' ? {} : now.search);
      return result;
    },
    [write, note],
  );

  // How the address changed, told apart once per entry it reaches (the six cases).
  const locationKey = useRouterState({
    select: (s) => (s.location.state as { __TSR_key?: string }).__TSR_key ?? s.location.href,
  });
  const ownMark = useRouterState({
    // History state outlives the page and can hold anything: only a string is a mark.
    select: (s) => {
      const mark = (s.location.state as { corralPanelWrite?: unknown }).corralPanelWrite;
      return typeof mark === 'string' ? mark : null;
    },
  });
  const outside = useRouterState({
    select: (s) => (s.location.state as LocationState).corralEntry === 'outside',
  });
  const seen = useRef<{ key: string | null; sessionId: string | null; search: SessionSearch }>({
    key: null,
    sessionId: null,
    search: {},
  });
  // A layout effect: a conversation entered with its panel open is never painted closed first.
  // StrictMode's second run finds the entry already seen and does nothing.
  useLayoutEffect(() => {
    // `enter` waits for a measured room: entering without it would decide 물러남 or 서랍 wrongly.
    if (room === null) return;
    const previous = seen.current;
    // The address has moved on before the page's conversation did: wait for it.
    if (!here) return;
    if (previous.key === locationKey && previous.sessionId === sessionId) return;
    seen.current = { key: locationKey, sessionId, search };
    lastWritten.current = null;
    const action = historyActionOf(router.history, locationKey);
    const back = travelled(action);
    const before = heldRef.current?.sessionId === sessionId ? heldRef.current.state : EMPTY_PANEL;
    // Only a panel address opens a way to a tab: a request to respond, or an address without
    // `panel`, opens none.
    const linked = (state: PanelState) => {
      if (readAddress(search).kind === 'panel')
        latest.current.input.onOpenedByLink?.(search, state, before);
    };
    // What the dock opens: the panel left it alone (model.ts addressTab).
    const docked = (state: PanelState, focus: boolean) => {
      const address = readAddress(search);
      if (address.kind !== 'panel') return;
      const { target } = address;
      const kind = PANEL_TAB_OF[target.panel];
      const inPanel =
        kind === 'terminal' &&
        target.terminal !== undefined &&
        state.tabs.some((tab) => tabKey(tab) === `terminal:${target.terminal}`);
      if (kind === null || (kind === 'terminal' && !inPanel))
        latest.current.input.onDockAddress?.(target, focus);
    };
    if (heldRef.current?.sessionId !== sessionId) {
      const via: EntryVia = !action ? 'address' : back ? 'history' : outside ? 'address' : 'link';
      const result = dispatch({
        type: 'enter',
        search,
        memory: readPanelMemory(deviceStorage(), sessionId),
        via,
      });
      if (via === 'link') linked(result.state);
      if (via !== 'history') docked(result.state, via === 'link');
      return;
    }
    // Back and Forward decide before any tag: a travelled entry may carry an old write's mark.
    if (back) dispatch({ type: 'history', search });
    // An entry from outside is never the frame's own write, whatever mark it carries.
    else if (!outside && ownMark?.startsWith(`${nonce}:`)) return;
    // The address shown already (or a change only to what the frame does not read): no way
    // opened anything, so no focus moves and no opener changes, whoever navigated.
    else if (same(frameParams(previous.search), frameParams(search))) return;
    else {
      const result = dispatch({ type: 'follow', search, source: outside ? 'outside' : 'in-app' });
      if (!outside) linked(result.state);
      docked(result.state, !outside);
    }
  }, [
    locationKey,
    here,
    search,
    ownMark,
    outside,
    sessionId,
    room,
    router.history,
    dispatch,
    nonce,
  ]);

  // The room and the run list reach the model only as context.
  const runKey = runIds === null ? null : runIds.join(',');
  const terminalKey = terminalIds === null ? null : terminalIds.join(',');
  const contextSeen = useRef<string | null>(null);
  useEffect(() => {
    const key = `${sessionId}|${room}|${folder}|${runKey}|${paddock}|${terminalKey}`;
    if (!entered || room === null) {
      contextSeen.current = null;
      return;
    }
    if (contextSeen.current === null) {
      contextSeen.current = key;
      // A listing may have answered before the entry: let its clean-up run.
      if (runKey === null && terminalKey === null) return;
    } else if (contextSeen.current === key) return;
    contextSeen.current = key;
    dispatch({ type: 'context' });
  }, [entered, sessionId, room, folder, runKey, paddock, terminalKey, dispatch]);

  // The selected tab's own state (and front), as the address carries it.
  useEffect(() => {
    if (entered) note(search, state);
  }, [entered, search, state, note]);

  const writeTab = useCallback(
    (patch: Partial<SessionSearch>, options?: { replace?: boolean }) => {
      const current = latest.current.search;
      const next = patchSessionSearch(current, patch);
      if (!same(next, validateSessionSearch({ ...current })))
        write(next, options?.replace ? 'replace' : 'push');
    },
    [write],
  );

  return {
    state,
    ctx,
    entered,
    dispatch,
    writeTab,
    tabSearch: (key) => tabStates.current.get(key),
    fronts: fronts.current,
  };
}

function unchanged(state: PanelState): PanelResult {
  return {
    state,
    address: { compose: true },
    history: null,
    bringForward: false,
    dropHeadConfirmation: false,
  };
}

export function runStatusOf(runs: readonly { runId: string; status: RunStatus }[]) {
  return (runId: string) => runs.find((run) => run.runId === runId)?.status;
}
