// The session panel as plain data and one reducer (features/session-panel.md). No screen, no
// router, no storage: the frame dispatches the events below and writes what they return.
//
// For the wiring step, which event each real action dispatches:
// - entering a conversation (sidebar, session menu, project list, palette, session search, an
//   in-app notification item, a link on another screen: `via: 'link'`; reload, opening the app,
//   an OS notification, an outside address: `via: 'address'`; Back/Forward from another screen:
//   `via: 'history'`) → `enter`, with the address and the conversation's memory;
// - an opening way ("여는 길", the run picker, "현재 실행 보기", a result chosen in 결과, a link
//   inside one tab to another) → `open` with `from: 'way'`; the "+" list → `open` `from: 'plus'`;
// - a tab chosen or closed in the strip (close, middle button, Delete) → `select` / `close`;
// - the toggle button, its palette item and shortcut → `toggle`; the maximize button →
//   `maximize`; Escape or the dimmed conversation under a drawer → `closeDrawer`;
// - selection attach, file reference, Respond, reading advice, the stop command routed to the
//   composer → `bringForward`;
// - an address followed while in the conversation → `follow` (`in-app` for a link in the app,
//   `outside` for an OS notification or an outside address); Back/Forward within it → `history`;
// - the measured room or the run list changing → `context` (the reducer reads both from `ctx`).
//
// Three traps:
// 1. The frame's own address write must never come back as `follow` or `history`: an open panel
//    with no tabs writes `compose`, and reading that echo would close the panel.
// 2. Opening ways dispatch `open` on click. A link to the address already current produces no
//    navigation, so waiting for the router to report it would lose the click.
// 3. `enter` waits until the room has been measured, and is dispatched again whenever the
//    conversation changes: SessionPage stays mounted across conversations.
import type { SessionPanel } from '../panels/registry.ts';
import type { SessionSearch } from '../panels/routes.ts';
import { type PanelAddress, panelAddress, readAddress } from './address.ts';
import type { PanelMemory } from './memory.ts';
import {
  PANEL_TAB_OF,
  type PanelContext,
  type PanelFronts,
  type PanelTab,
  type PanelTarget,
  plusItems,
  type TabKey,
  tabKey,
  targetTab,
} from './tabs.ts';

/** 닫힘, 옆, 넓힘, 서랍, 물러남 ("화면 틀"). 물러남 always has a selected tab. */
export type Presentation = 'closed' | 'beside' | 'maximized' | 'drawer' | 'withdrawn';

/**
 * An open tab. `instance` changes when the tab is closed and opened again, so the frame keys the
 * tab's screen by it and a reopened tab starts fresh. `seen`: the tab has been selected while the
 * panel was on screen; until then a restored tab is not rendered, and once seen it stays mounted
 * until it is closed.
 */
export type OpenTab = PanelTab & { readonly instance: number; readonly seen: boolean };

/** What the entry left for the run list's first answer after it. */
export interface Awaiting {
  /** Run tabs restored from memory. */
  readonly restored: readonly string[];
  /** The run the entry address named. */
  readonly addressRun: string | null;
  /**
   * The entry asked for the newest run (`panel=run` without `run`) before the list was known:
   * the column its tab opens with (`opening` for an in-app link, `address` otherwise). Dropped
   * as soon as the user touches the panel.
   */
  readonly newest: 'opening' | 'address' | null;
}

export interface PanelState {
  readonly tabs: readonly OpenTab[];
  /** The selected tab; null exactly when there are no tabs. */
  readonly selected: TabKey | null;
  readonly presentation: Presentation;
  /** Set on entry until the run list first answers; only these are touched by its clean-up. */
  readonly awaiting: Awaiting | null;
  /** The instance the next opened tab gets. */
  readonly nextInstance: number;
}

export const EMPTY_PANEL: PanelState = {
  tabs: [],
  selected: null,
  presentation: 'closed',
  awaiting: null,
  nextInstance: 1,
};

/** A tab's identity without its instance and seen flag. */
export function tabOf(tab: PanelTab): PanelTab {
  return tab.kind === 'run' ? { kind: 'run', runId: tab.runId } : { kind: tab.kind };
}

/**
 * How the conversation was entered. `link`: an in-app link. `address`: reload, opening the app,
 * an OS notification, an outside address. `history`: Back or Forward from another screen.
 */
export type EntryVia = 'link' | 'address' | 'history';

/**
 * A user's step, the address, or the context changing. There is deliberately no event for a
 * run event, a run record response or a command receipt: none of them can change tabs,
 * selection or presentation. The run list reaches the model only through `ctx.runIds`.
 */
export type PanelEvent =
  | {
      readonly type: 'enter';
      readonly search: SessionSearch;
      readonly memory: PanelMemory | null;
      readonly via: EntryVia;
    }
  | { readonly type: 'open'; readonly target: PanelTarget; readonly from: 'way' | 'plus' }
  | { readonly type: 'select'; readonly key: TabKey }
  | { readonly type: 'close'; readonly key: TabKey }
  | { readonly type: 'toggle' }
  | { readonly type: 'maximize' }
  | { readonly type: 'closeDrawer' }
  | { readonly type: 'bringForward' }
  | {
      readonly type: 'follow';
      readonly search: SessionSearch;
      readonly source: 'in-app' | 'outside';
    }
  | { readonly type: 'history'; readonly search: SessionSearch }
  /** The room or the run list in `ctx` changed. */
  | { readonly type: 'context' };

/**
 * A reduced event. `history` says how the frame writes the address: `push` adds an entry,
 * `replace` rewrites the current one, null writes nothing; `nextSearch` builds the search to
 * write. `bringForward`: the conversation is to come forward (reveal the needed-now tray, the
 * advice row or the message). `dropHeadConfirmation`: a whole-run cancel confirmation the run
 * tab head asked is dropped, sending nothing.
 */
export interface PanelResult {
  readonly state: PanelState;
  readonly address: PanelAddress;
  readonly history: 'push' | 'replace' | null;
  readonly bringForward: boolean;
  readonly dropHeadConfirmation: boolean;
}

export function reducePanel(state: PanelState, event: PanelEvent, ctx: PanelContext): PanelResult {
  const next = settle(touched(step(state, event, ctx), event), ctx);
  return {
    state: next,
    address: panelAddress(next, fronts(ctx.front, event)),
    history: historyOf(state, next, event, ctx),
    bringForward: asksForward(event),
    dropHeadConfirmation:
      runTabHeadRun(state) !== null &&
      (event.type === 'enter' || runTabHeadRun(next) !== runTabHeadRun(state)),
  };
}

/** The panel is on screen (옆, 넓힘, 서랍): the toggle shows as pressed. */
export function panelOnScreen(presentation: Presentation): boolean {
  return presentation === 'beside' || presentation === 'maximized' || presentation === 'drawer';
}

/** The conversation can be operated (닫힘, 옆, 물러남). */
export function conversationOperable(presentation: Presentation): boolean {
  return presentation === 'closed' || presentation === 'beside' || presentation === 'withdrawn';
}

/**
 * The toggle and its palette item exist: a tab is open or something can be opened now. Runs not
 * listed yet do not count until the list answers.
 */
export function toggleAvailable(state: PanelState, ctx: PanelContext): boolean {
  return state.tabs.length > 0 || plusItems(ctx).length > 0;
}

/** The maximize button exists: the panel has tabs and is 옆 or 넓힘 (never in a drawer). */
export function maximizeAvailable(state: PanelState): boolean {
  return (
    state.tabs.length > 0 && (state.presentation === 'beside' || state.presentation === 'maximized')
  );
}

/**
 * The run whose tab head would carry the controls: the selected run tab while the panel is
 * 넓힘 or 서랍. Null otherwise.
 */
export function runTabHeadRun(state: PanelState): string | null {
  if (conversationOperable(state.presentation)) return null;
  return state.selected?.startsWith('run:') ? state.selected.slice('run:'.length) : null;
}

// "주소대로": an address with `panel` stands beside with room and withdraws without.
const byAddress = (room: boolean): Presentation => (room ? 'beside' : 'withdrawn');

// An opening action on this screen, or an in-app link carrying `panel`.
function byOpening(presentation: Presentation, room: boolean): Presentation {
  if (presentation === 'closed') return room ? 'beside' : 'drawer';
  if (presentation === 'withdrawn') return 'drawer';
  return presentation;
}

function byRoom(presentation: Presentation, room: boolean): Presentation {
  if (!room) return presentation === 'beside' ? 'withdrawn' : presentation;
  return presentation === 'drawer' || presentation === 'withdrawn' ? 'beside' : presentation;
}

// "대화를 앞으로 가져오기": 넓힘 is released, 서랍 closes, the rest stays.
function byBringingForward(presentation: Presentation, room: boolean): Presentation {
  if (presentation === 'maximized') return byAddress(room);
  if (presentation === 'drawer') return 'closed';
  return presentation;
}

function presented(state: PanelState, presentation: Presentation): PanelState {
  return presentation === state.presentation ? state : { ...state, presentation };
}

const hasTab = (state: PanelState, key: TabKey) => state.tabs.some((tab) => tabKey(tab) === key);

/** Opens a tab at the right end with a new instance, or selects it where it is. */
function opened(state: PanelState, tab: PanelTab, presentation: Presentation): PanelState {
  const key = tabKey(tab);
  if (hasTab(state, key)) {
    if (state.selected === key && state.presentation === presentation) return state;
    return { ...state, selected: key, presentation };
  }
  return {
    ...state,
    tabs: [...state.tabs, { ...tabOf(tab), instance: state.nextInstance, seen: false }],
    nextInstance: state.nextInstance + 1,
    selected: key,
    presentation,
  };
}

// Something can still be opened: a folder, a run, or a run list not answered yet.
const canOpenMore = (ctx: PanelContext) =>
  ctx.folder || ctx.runIds === null || ctx.runIds.length > 0;

function closed(state: PanelState, key: TabKey, ctx: PanelContext): PanelState {
  const index = state.tabs.findIndex((tab) => tabKey(tab) === key);
  if (index < 0) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  const neighbour = tabs[index] ?? tabs[index - 1];
  const selected = state.selected === key ? (neighbour ? tabKey(neighbour) : null) : state.selected;
  if (tabs.length > 0) return { ...state, tabs, selected };
  // The last tab: the panel stays open on its list (넓힘 released), unless nothing can be opened.
  const presentation = !canOpenMore(ctx)
    ? 'closed'
    : state.presentation === 'maximized'
      ? byAddress(ctx.room)
      : state.presentation;
  return { ...state, tabs, selected: null, presentation };
}

function toggled(state: PanelState, ctx: PanelContext): PanelState {
  switch (state.presentation) {
    case 'closed':
      if (!toggleAvailable(state, ctx)) return state;
      return presented(state, ctx.room ? 'beside' : 'drawer');
    case 'withdrawn':
      return presented(state, 'drawer');
    default:
      return presented(state, 'closed');
  }
}

function maximized(state: PanelState, ctx: PanelContext): PanelState {
  if (state.tabs.length === 0) return state;
  if (state.presentation === 'beside') return presented(state, 'maximized');
  if (state.presentation === 'maximized') return presented(state, byAddress(ctx.room));
  return state;
}

function entered(event: PanelEvent & { type: 'enter' }, ctx: PanelContext): PanelState {
  const memory = event.memory;
  const tabs: OpenTab[] = (memory?.tabs ?? []).map((tab, i) => ({
    ...tabOf(tab),
    instance: i + 1,
    seen: false,
  }));
  const first = tabs[0];
  const selected =
    memory?.selected && tabs.some((tab) => tabKey(tab) === memory.selected)
      ? memory.selected
      : first
        ? tabKey(first)
        : null;
  const base: PanelState = {
    tabs,
    selected,
    presentation: 'closed',
    awaiting: null,
    nextInstance: tabs.length + 1,
  };
  const address = readAddress(event.search);
  let next = base;
  let addressRun: string | null = null;
  let newest: Awaiting['newest'] = null;
  if (address.kind === 'neither') {
    // Restore on entry; Back or Forward into the conversation does not restore.
    const open = event.via !== 'history' && memory?.open === true && tabs.length > 0;
    next = presented(base, open ? byAddress(ctx.room) : 'closed');
  } else if (address.kind === 'panel') {
    const tab = targetTab(address.target, ctx.runIds);
    const column = event.via === 'link' ? 'opening' : 'address';
    if (tab) {
      next = opened(
        base,
        tab,
        column === 'opening' ? byOpening('closed', ctx.room) : byAddress(ctx.room),
      );
      if (tab.kind === 'run' && address.target.run) addressRun = tab.runId;
    } else if (address.target.panel === 'run' && ctx.runIds === null) {
      // The newest run is not known yet: stay closed and open it when the list answers.
      newest = column;
    }
  }
  if (address.bringForward) next = presented(next, byBringingForward(next.presentation, ctx.room));
  const restored = tabs.flatMap((tab) => (tab.kind === 'run' ? [tab.runId] : []));
  return {
    ...next,
    awaiting: restored.length > 0 || addressRun || newest ? { restored, addressRun, newest } : null,
  };
}

function followed(
  state: PanelState,
  event: PanelEvent & { type: 'follow' },
  ctx: PanelContext,
): PanelState {
  const address = readAddress(event.search);
  let next = state;
  if (address.kind === 'compose') next = presented(state, 'closed');
  else if (address.kind === 'panel') {
    const tab = targetTab(address.target, ctx.runIds);
    const presentation =
      event.source === 'in-app' ? byOpening(state.presentation, ctx.room) : byAddress(ctx.room);
    // A run tab that cannot be named (no run, or the list not known) leaves the panel as it is.
    if (tab) next = opened(state, tab, presentation);
  }
  return address.bringForward
    ? presented(next, byBringingForward(next.presentation, ctx.room))
    : next;
}

// Back and Forward keep the panel's own state while the address has `panel`.
function travelled(state: PanelState, search: SessionSearch, ctx: PanelContext): PanelState {
  const address = readAddress(search);
  if (address.kind === 'compose') return presented(state, 'closed');
  if (address.kind === 'neither') return state;
  const tab = targetTab(address.target, ctx.runIds);
  if (!tab) return state;
  const presentation = state.presentation === 'closed' ? byAddress(ctx.room) : state.presentation;
  return opened(state, tab, presentation);
}

// The run list's clean-ups, once, on its first answer after entry: restored run tabs it does not
// list are dropped; the address's unknown run becomes the newest run's tab while it is still
// selected; a pending request for the newest run opens its tab.
function answered(state: PanelState, runIds: readonly string[], ctx: PanelContext): PanelState {
  const awaiting = state.awaiting;
  if (!awaiting) return state;
  const listed = new Set(runIds);
  const newestRun = runIds.at(-1);
  const gone = new Set(
    [...awaiting.restored, ...(awaiting.addressRun ? [awaiting.addressRun] : [])].filter(
      (runId) => !listed.has(runId),
    ),
  );
  const tabs = state.tabs.filter((tab) => !(tab.kind === 'run' && gone.has(tab.runId)));
  let next: PanelState = {
    ...state,
    tabs: tabs.length === state.tabs.length ? state.tabs : tabs,
    awaiting: null,
  };
  if (state.selected !== null && !hasTab(next, state.selected)) {
    const addressSelected =
      awaiting.addressRun !== null && state.selected === `run:${awaiting.addressRun}`;
    const first = tabs[0];
    if (addressSelected && newestRun)
      next = opened(next, { kind: 'run', runId: newestRun }, state.presentation);
    else
      next = {
        ...next,
        selected: first ? tabKey(first) : null,
        presentation: first && !addressSelected ? state.presentation : 'closed',
      };
  }
  if (awaiting.newest && newestRun) {
    const presentation =
      awaiting.newest === 'opening'
        ? byOpening(next.presentation, ctx.room)
        : next.presentation === 'closed'
          ? byAddress(ctx.room)
          : next.presentation;
    next = opened(next, { kind: 'run', runId: newestRun }, presentation);
  }
  return next;
}

// Any of these is the user touching the panel: a pending request for the newest run is dropped.
const TOUCHES: ReadonlySet<PanelEvent['type']> = new Set([
  'open',
  'select',
  'close',
  'toggle',
  'maximize',
  'closeDrawer',
  'follow',
  'history',
]);

function touched(state: PanelState, event: PanelEvent): PanelState {
  const awaiting = state.awaiting;
  if (!awaiting?.newest || !TOUCHES.has(event.type)) return state;
  const rest = { ...awaiting, newest: null };
  return {
    ...state,
    awaiting: rest.restored.length > 0 || rest.addressRun ? rest : null,
  };
}

// What holds after every event: the run list's answer is applied once it is known, the room is
// applied to the presentation, 물러남 never stands without a tab, and the selected tab on screen
// is seen.
function settle(state: PanelState, ctx: PanelContext): PanelState {
  let next = ctx.runIds !== null ? answered(state, ctx.runIds, ctx) : state;
  next = presented(next, byRoom(next.presentation, ctx.room));
  if (next.presentation === 'withdrawn' && next.tabs.length === 0) next = presented(next, 'closed');
  if (panelOnScreen(next.presentation) && next.selected) {
    const index = next.tabs.findIndex((tab) => tabKey(tab) === next.selected);
    const tab = next.tabs[index];
    if (tab && !tab.seen)
      next = { ...next, tabs: next.tabs.map((t, i) => (i === index ? { ...t, seen: true } : t)) };
  }
  return next;
}

function step(state: PanelState, event: PanelEvent, ctx: PanelContext): PanelState {
  switch (event.type) {
    case 'enter':
      return entered(event, ctx);
    case 'open': {
      const tab = targetTab(event.target, ctx.runIds);
      return tab ? opened(state, tab, byOpening(state.presentation, ctx.room)) : state;
    }
    case 'select':
      return hasTab(state, event.key) && state.selected !== event.key
        ? { ...state, selected: event.key }
        : state;
    case 'close':
      return closed(state, event.key, ctx);
    case 'toggle':
      return toggled(state, ctx);
    case 'maximize':
      return maximized(state, ctx);
    case 'closeDrawer':
      return state.presentation === 'drawer' ? presented(state, 'closed') : state;
    case 'bringForward':
      return presented(state, byBringingForward(state.presentation, ctx.room));
    case 'follow':
      return followed(state, event, ctx);
    case 'history':
      return travelled(state, event.search, ctx);
    case 'context':
      return state;
  }
}

// The windows in front of 파일 and 변경: the caller's, with the one an event names on top.
function fronts(current: PanelFronts | undefined, event: PanelEvent): PanelFronts | undefined {
  let named: SessionPanel | undefined;
  if (event.type === 'open') named = event.target.panel;
  else if (event.type === 'enter' || event.type === 'follow' || event.type === 'history') {
    const address = readAddress(event.search);
    if (address.kind === 'panel') named = address.target.panel;
  }
  const kind = named ? PANEL_TAB_OF[named] : undefined;
  return kind === 'files' || kind === 'changes' ? { ...current, [kind]: named } : current;
}

function asksForward(event: PanelEvent): boolean {
  if (event.type === 'bringForward') return true;
  if (event.type === 'enter' || event.type === 'follow')
    return readAddress(event.search).bringForward;
  return false;
}

function historyOf(
  previous: PanelState,
  next: PanelState,
  event: PanelEvent,
  ctx: PanelContext,
): PanelResult['history'] {
  // Opening or selecting from outside the tab strip adds an entry, even for the tab already
  // selected: the way may point at something inside it. The frame skips an identical write.
  if (event.type === 'open' && event.from === 'way')
    return targetTab(event.target, ctx.runIds) ? 'push' : null;
  // An entry waiting for the newest run writes nothing, so the address keeps `panel=run`.
  if (event.type === 'enter') return next.awaiting?.newest ? null : 'replace';
  // These arrive with an address already in history; the frame rewrites it to what it shows.
  if (event.type === 'follow' || event.type === 'history') return 'replace';
  return next === previous ? null : 'replace';
}
