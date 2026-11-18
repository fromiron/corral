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
//   a stack frame chosen in the debugger → `open` `from: 'debugger'`;
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
  type CopyIdentity,
  PANEL_TAB_OF,
  type PanelContext,
  type PanelFronts,
  type PanelTab,
  type PanelTarget,
  plusItems,
  type TabKey,
  type ToolsView,
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
  /** Terminal tabs restored from memory, left for the terminal list's first answer. */
  readonly terminals: readonly string[];
  /** 팀 그래프 tabs restored from memory, left for the project's team list. */
  readonly graphs: readonly string[];
  /** 문서 tabs restored from memory, each left for its file's first read after entry. */
  readonly documents: readonly DocumentAwaited[];
}

/** A restored 문서 tab by its key and the instance it was restored as. */
export interface DocumentAwaited {
  readonly key: TabKey;
  readonly instance: number;
}

/** What the read after entry found for one restored 문서 tab. */
export interface DocumentChecked extends DocumentAwaited {
  /** `drop`: its file is gone, or its copy is not the conversation's Paddock now. */
  readonly outcome: 'keep' | 'drop';
  /** It holds a draft not saved, which the 파일 tab's recovery card keeps. */
  readonly draft: boolean;
}

// What is still waiting: null once nothing is.
function waiting(awaiting: Awaiting): Awaiting | null {
  return awaiting.restored.length > 0 ||
    awaiting.addressRun ||
    awaiting.newest ||
    awaiting.terminals.length > 0 ||
    awaiting.graphs.length > 0 ||
    awaiting.documents.length > 0
    ? awaiting
    : null;
}
const runsAwaited = (awaiting: Awaiting | null): awaiting is Awaiting =>
  Boolean(awaiting && (awaiting.restored.length > 0 || awaiting.addressRun || awaiting.newest));

export interface PanelState {
  readonly tabs: readonly OpenTab[];
  /** The selected tab; null exactly when there are no tabs. */
  readonly selected: TabKey | null;
  readonly presentation: Presentation;
  /**
   * Set on entry until the run list and the terminal list first answer; only these are touched by
   * their clean-ups.
   */
  readonly awaiting: Awaiting | null;
  /** The instance the next opened tab gets. */
  readonly nextInstance: number;
  /** The 문서 tab chosen last, for a wide panel's ways to 파일; never remembered. */
  readonly lastDocument?: TabKey | null;
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
  switch (tab.kind) {
    case 'run':
      return { kind: 'run', runId: tab.runId };
    case 'terminal':
      return { kind: 'terminal', terminalId: tab.terminalId };
    case 'document': {
      const { source, path, copy } = tab;
      return copy
        ? {
            kind: 'document',
            source,
            path,
            copy: { bindingId: copy.bindingId, generation: copy.generation },
          }
        : { kind: 'document', source, path };
    }
    case 'graph':
      return { kind: 'graph', corralId: tab.corralId };
    case 'tools':
      return { kind: 'tools', view: tab.view };
    default:
      return { kind: tab.kind };
  }
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
  | {
      readonly type: 'open';
      readonly target: PanelTarget;
      readonly from: 'way' | 'plus' | 'debugger';
    }
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
  /** A tab dragged or moved by key to `toIndex` in the strip; the selection stays. */
  | { readonly type: 'reorder'; readonly key: TabKey; readonly toIndex: number }
  /** A terminal's tab dragged in from the bottom dock, let go before the tab at `index`. */
  | { readonly type: 'moveIn'; readonly terminalId: string; readonly index: number }
  /** A 문서 tab's file was read: the copy it belongs to, stamped on that very tab. */
  | {
      readonly type: 'documentCopy';
      readonly key: TabKey;
      readonly instance: number;
      readonly copy: CopyIdentity;
    }
  /** The reads after entry of restored 문서 tabs answered (each one once). */
  | { readonly type: 'documentsChecked'; readonly results: readonly DocumentChecked[] }
  /** The tree's Refresh read the source-folder 문서 tabs again and found these files gone. */
  | { readonly type: 'sourceFilesGone'; readonly tabs: readonly DocumentAwaited[] }
  /** The person picked an inner tab inside 작업, or its first read put 미리보기 in front. */
  | { readonly type: 'toolsView'; readonly view: ToolsView }
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

// The debugger opening a document: never a drawer, which would cover the dock it steps in.
function byDebugger(presentation: Presentation, room: boolean): Presentation {
  if (presentation === 'closed') return room ? 'beside' : 'closed';
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

/** What an opening says of a tab already open: 작업's inner tab when it names one; else null. */
function refreshed(open: OpenTab, tab: PanelTab): OpenTab | null {
  if (open.kind === 'tools' && tab.kind === 'tools' && tab.view !== null && tab.view !== open.view)
    return { ...open, view: tab.view };
  return null;
}

/** Opens a tab at the right end with a new instance, or selects it where it is. */
/** A conversation opens at most this many 문서 tabs (workbench.md 파일과 문서 탭). */
export const DOCUMENT_LIMIT = 20;

/** Opening `tab` would be a 문서 tab past the limit: one more file while 20 are open. */
export function documentLimitReached(state: Pick<PanelState, 'tabs'>, tab: PanelTab): boolean {
  if (tab.kind !== 'document') return false;
  const key = tabKey(tab);
  if (state.tabs.some((open) => tabKey(open) === key)) return false;
  return state.tabs.filter((open) => open.kind === 'document').length >= DOCUMENT_LIMIT;
}

function opened(state: PanelState, tab: PanelTab, presentation: Presentation): PanelState {
  // A file past the limit opens no tab; the page says why where the person asked for it.
  if (documentLimitReached(state, tab)) return state;
  const key = tabKey(tab);
  const index = state.tabs.findIndex((open) => tabKey(open) === key);
  if (index >= 0) {
    const open = state.tabs[index] as OpenTab;
    const fresh = refreshed(open, tab);
    if (!fresh && state.selected === key && state.presentation === presentation) return state;
    return {
      ...state,
      tabs: fresh ? state.tabs.map((t, i) => (i === index ? fresh : t)) : state.tabs,
      selected: key,
      presentation,
    };
  }
  return {
    ...state,
    tabs: [...state.tabs, { ...tabOf(tab), instance: state.nextInstance, seen: false }],
    nextInstance: state.nextInstance + 1,
    selected: key,
    presentation,
  };
}

// Something can still be opened: a folder, a terminal, a run, or a run list not answered yet.
const canOpenMore = (ctx: PanelContext) =>
  ctx.folder || Boolean(ctx.paddock) || ctx.runIds === null || ctx.runIds.length > 0;

/**
 * The panel tab an address names. A terminal's tab only when the panel holds it: otherwise the
 * terminal is the bottom dock's to open (as `debug` always is), and the panel stays as it is.
 */
function addressTab(state: PanelState, target: PanelTarget, ctx: PanelContext): PanelTab | null {
  const tab = targetTab(target, ctx.runIds);
  if (tab?.kind === 'terminal' && !hasTab(state, tabKey(tab))) return null;
  return tab;
}
// An address the bottom dock opens: the panel reads it as one with neither `panel` nor `compose`.
const dockBound = (target: PanelTarget) =>
  PANEL_TAB_OF[target.panel] === null || PANEL_TAB_OF[target.panel] === 'terminal';

/** The tree is a column beside the 문서 tabs: 파일 is open in a wide panel with a 문서 tab. */
export function treeColumn(state: Pick<PanelState, 'tabs'>, ctx: PanelContext): boolean {
  return (
    Boolean(ctx.wide) &&
    state.tabs.some((tab) => tab.kind === 'files') &&
    state.tabs.some((tab) => tab.kind === 'document')
  );
}

function closed(state: PanelState, key: TabKey, ctx: PanelContext): PanelState {
  const index = state.tabs.findIndex((tab) => tabKey(tab) === key);
  if (index < 0) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  // A 파일 not drawn in the strip is nobody's neighbour; the last 문서 tab hands back to it.
  const hidden = treeColumn({ tabs }, ctx);
  const drawn = (tab: OpenTab | undefined) => (hidden && tab?.kind === 'files' ? undefined : tab);
  const after = tabs.slice(index).find((tab) => drawn(tab));
  const before = tabs.slice(0, index).findLast((tab) => drawn(tab));
  const lastDocument =
    treeColumn(state, ctx) && !hidden && state.tabs[index]?.kind === 'document'
      ? tabs.find((tab) => tab.kind === 'files')
      : undefined;
  const neighbour = lastDocument ?? after ?? before;
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
  const read = readAddress(event.search);
  const tabNamed = read.kind === 'panel' ? addressTab(base, read.target, ctx) : null;
  // An address the dock opens, entered with: restored as if it had neither.
  const address: typeof read =
    read.kind === 'panel' && !tabNamed && dockBound(read.target)
      ? { kind: 'neither', bringForward: read.bringForward }
      : read;
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
  const terminals = tabs.flatMap((tab) => (tab.kind === 'terminal' ? [tab.terminalId] : []));
  const graphs = tabs.flatMap((tab) => (tab.kind === 'graph' ? [tab.corralId] : []));
  const documents = tabs.flatMap((tab) =>
    tab.kind === 'document' ? [{ key: tabKey(tab), instance: tab.instance }] : [],
  );
  return {
    ...next,
    awaiting: waiting({ restored, addressRun, newest, terminals, graphs, documents }),
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
    const tab = addressTab(state, address.target, ctx);
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
  const tab = addressTab(state, address.target, ctx);
  if (!tab) return state;
  const presentation = state.presentation === 'closed' ? byAddress(ctx.room) : state.presentation;
  return opened(state, tab, presentation);
}

// The run list's clean-ups, once, on its first answer after entry: restored run tabs it does not
// list are dropped; the address's unknown run becomes the newest run's tab while it is still
// selected; a pending request for the newest run opens its tab.
function answered(state: PanelState, runIds: readonly string[], ctx: PanelContext): PanelState {
  const awaiting = state.awaiting;
  if (!runsAwaited(awaiting)) return state;
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
    awaiting: waiting({ ...awaiting, restored: [], addressRun: null, newest: null }),
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

// The terminal list's clean-up, once, on its first answer after entry: restored terminal tabs it
// does not list are dropped; a dropped selection goes to the first tab left, or the panel closes.
function terminalsAnswered(state: PanelState, terminalIds: readonly string[]): PanelState {
  const awaiting = state.awaiting;
  if (!awaiting || awaiting.terminals.length === 0) return state;
  const listed = new Set(terminalIds);
  const gone = new Set(awaiting.terminals.filter((id) => !listed.has(id)));
  const tabs = state.tabs.filter((tab) => !(tab.kind === 'terminal' && gone.has(tab.terminalId)));
  let next: PanelState = {
    ...state,
    tabs: tabs.length === state.tabs.length ? state.tabs : tabs,
    awaiting: waiting({ ...awaiting, terminals: [] }),
  };
  if (state.selected !== null && !hasTab(next, state.selected)) {
    const first = tabs[0];
    next = first
      ? { ...next, selected: tabKey(first) }
      : { ...next, selected: null, presentation: 'closed' };
  }
  return next;
}

// The team list's clean-up, once: restored 팀 그래프 tabs of a team the project no longer has
// are dropped (one the address or a way opened stays, showing why it cannot be read); a dropped
// selection goes to the first tab left, or the panel closes.
function graphsAnswered(state: PanelState, corralIds: readonly string[]): PanelState {
  const awaiting = state.awaiting;
  if (!awaiting || awaiting.graphs.length === 0) return state;
  const listed = new Set(corralIds);
  const gone = new Set(awaiting.graphs.filter((id) => !listed.has(id)));
  const tabs = state.tabs.filter((tab) => !(tab.kind === 'graph' && gone.has(tab.corralId)));
  let next: PanelState = {
    ...state,
    tabs: tabs.length === state.tabs.length ? state.tabs : tabs,
    awaiting: waiting({ ...awaiting, graphs: [] }),
  };
  if (state.selected !== null && !hasTab(next, state.selected)) {
    const first = tabs[0];
    next = first
      ? { ...next, selected: tabKey(first) }
      : { ...next, selected: null, presentation: 'closed' };
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
  'moveIn',
  'toolsView',
]);

function touched(state: PanelState, event: PanelEvent): PanelState {
  const awaiting = state.awaiting;
  if (!awaiting?.newest || !TOUCHES.has(event.type)) return state;
  return { ...state, awaiting: waiting({ ...awaiting, newest: null }) };
}

// What holds after every event: the run list's answer is applied once it is known, the room is
// applied to the presentation, 물러남 never stands without a tab, and the selected tab on screen
// is seen.
function settle(state: PanelState, ctx: PanelContext): PanelState {
  let next = ctx.runIds !== null ? answered(state, ctx.runIds, ctx) : state;
  if (ctx.terminalIds) next = terminalsAnswered(next, ctx.terminalIds);
  if (ctx.corralIds) next = graphsAnswered(next, ctx.corralIds);
  next = presented(next, byRoom(next.presentation, ctx.room));
  if (next.presentation === 'withdrawn' && next.tabs.length === 0) next = presented(next, 'closed');
  next = besideTheTree(next, ctx);
  if (panelOnScreen(next.presentation) && next.selected) {
    const index = next.tabs.findIndex((tab) => tabKey(tab) === next.selected);
    const tab = next.tabs[index];
    if (tab && !tab.seen)
      next = { ...next, tabs: next.tabs.map((t, i) => (i === index ? { ...t, seen: true } : t)) };
  }
  return next;
}

// A wide panel draws 파일 as the tree column, never as the selected tab: its ways and its
// selection go to the 문서 tab chosen last (or the first one); the 문서 tab selected is remembered
// as the one chosen last.
function besideTheTree(state: PanelState, ctx: PanelContext): PanelState {
  let next = state;
  if (next.selected === 'files' && treeColumn(next, ctx)) {
    const documents = next.tabs.filter((tab) => tab.kind === 'document');
    const last = documents.find((tab) => tabKey(tab) === next.lastDocument) ?? documents[0];
    if (last) next = { ...next, selected: tabKey(last) };
  }
  const selected = next.tabs.find((tab) => tabKey(tab) === next.selected);
  if (selected?.kind === 'document' && next.lastDocument !== next.selected)
    next = { ...next, lastDocument: next.selected };
  return next;
}

function step(state: PanelState, event: PanelEvent, ctx: PanelContext): PanelState {
  switch (event.type) {
    case 'enter':
      return entered(event, ctx);
    case 'open': {
      // A terminal's tab opens here only when the page asks for it by its ID.
      const tab = targetTab(event.target, ctx.runIds);
      const presentation =
        event.from === 'debugger'
          ? byDebugger(state.presentation, ctx.room)
          : byOpening(state.presentation, ctx.room);
      return tab ? opened(state, tab, presentation) : state;
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
    case 'reorder':
      return reordered(state, event.key, event.toIndex);
    case 'moveIn': {
      const tab: PanelTab = { kind: 'terminal', terminalId: event.terminalId };
      const at = opened(state, tab, byOpening(state.presentation, ctx.room));
      return reordered(at, tabKey(tab), Math.min(event.index, at.tabs.length - 1));
    }
    case 'toolsView': {
      const index = state.tabs.findIndex((tab) => tab.kind === 'tools');
      const tab = state.tabs[index];
      if (tab?.kind !== 'tools' || tab.view === event.view) return state;
      return {
        ...state,
        tabs: state.tabs.map((t, i) => (i === index ? { ...tab, view: event.view } : t)),
      };
    }
    case 'documentCopy': {
      const index = state.tabs.findIndex(
        (tab) => tabKey(tab) === event.key && tab.instance === event.instance,
      );
      const tab = state.tabs[index];
      if (tab?.kind !== 'document' || tab.source !== 'copy') return state;
      if (
        tab.copy?.bindingId === event.copy.bindingId &&
        tab.copy.generation === event.copy.generation
      )
        return state;
      const copy = { bindingId: event.copy.bindingId, generation: event.copy.generation };
      return { ...state, tabs: state.tabs.map((t, i) => (i === index ? { ...tab, copy } : t)) };
    }
    case 'documentsChecked':
      return documentsChecked(state, event.results);
    case 'sourceFilesGone':
      return sourceFilesGone(state, event.tabs);
    case 'context':
      return state;
  }
}

// The restored 문서 tabs' clean-up: a tab whose file is gone or whose copy is no longer the
// Paddock is dropped, once, and only as it was restored (not one closed and opened again). A
// dropped tab's draft stays in the 파일 tab's recovery card: 파일 opens where the first such tab
// stood when it is not open, selected only when that tab was. A dropped selection otherwise goes
// to the first tab left, or the panel closes.
function documentsChecked(state: PanelState, results: readonly DocumentChecked[]): PanelState {
  const awaiting = state.awaiting;
  if (!awaiting || awaiting.documents.length === 0) return state;
  const same = (a: DocumentAwaited, b: DocumentAwaited) =>
    a.key === b.key && a.instance === b.instance;
  const answered = results.filter((result) => awaiting.documents.some((d) => same(d, result)));
  if (answered.length === 0) return state;
  const dropped = answered.filter((result) => result.outcome === 'drop');
  const gone = (tab: OpenTab) =>
    dropped.some((result) => result.key === tabKey(tab) && result.instance === tab.instance);
  const left = {
    ...awaiting,
    documents: awaiting.documents.filter((d) => !answered.some((r) => same(d, r))),
  };
  if (dropped.length === 0) return { ...state, awaiting: waiting(left) };
  const firstDraft = state.tabs.findIndex(
    (tab) => gone(tab) && dropped.some((r) => r.draft && r.key === tabKey(tab)),
  );
  const selectedDraft = dropped.some((r) => r.draft && r.key === state.selected);
  const hasFiles = state.tabs.some((tab) => tab.kind === 'files');
  const kept: OpenTab[] = [];
  let nextInstance = state.nextInstance;
  state.tabs.forEach((tab, index) => {
    if (index === firstDraft && !hasFiles)
      kept.push({ kind: 'files', instance: nextInstance++, seen: false });
    if (!gone(tab)) kept.push(tab);
  });
  const next: PanelState = { ...state, tabs: kept, nextInstance, awaiting: waiting(left) };
  return reselected(state, next, selectedDraft ? 'files' : undefined);
}

// The tree's Refresh found these source-folder files gone: their 문서 tabs are dropped as a
// restored tab's missing file is, but only the very tab that was read (not one closed and opened
// again since).
function sourceFilesGone(state: PanelState, gone: readonly DocumentAwaited[]): PanelState {
  const tabs = state.tabs.filter(
    (tab) =>
      !(
        tab.kind === 'document' &&
        tab.source === 'original' &&
        gone.some((item) => item.key === tabKey(tab) && item.instance === tab.instance)
      ),
  );
  return tabs.length === state.tabs.length ? state : reselected(state, { ...state, tabs });
}

// A clean-up dropped the selected tab: `instead` when given, else the first tab left; with no tab
// left the panel closes.
function reselected(before: PanelState, next: PanelState, instead?: TabKey): PanelState {
  if (before.selected === null || hasTab(next, before.selected)) return next;
  const first = next.tabs[0];
  const selected = instead ?? (first ? tabKey(first) : null);
  return selected ? { ...next, selected } : { ...next, selected: null, presentation: 'closed' };
}

/** The strip's order with the tab at `toIndex`; the same state when nothing moves. */
function reordered(state: PanelState, key: TabKey, toIndex: number): PanelState {
  const from = state.tabs.findIndex((tab) => tabKey(tab) === key);
  const to = Math.max(0, Math.min(toIndex, state.tabs.length - 1));
  if (from < 0 || from === to) return state;
  const tabs = state.tabs.filter((_, index) => index !== from);
  tabs.splice(to, 0, state.tabs[from] as (typeof state.tabs)[number]);
  return { ...state, tabs };
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
  // selected: the way may point at something inside it. The frame skips an identical write. The
  // debugger's frames only rewrite the address: Back goes past them at once.
  if (event.type === 'open' && event.from === 'way')
    return targetTab(event.target, ctx.runIds) ? 'push' : null;
  // An entry waiting for the newest run writes nothing, so the address keeps `panel=run`.
  if (event.type === 'enter') return next.awaiting?.newest ? null : 'replace';
  // These arrive with an address already in history; the frame rewrites it to what it shows.
  if (event.type === 'follow' || event.type === 'history') return 'replace';
  return next === previous ? null : 'replace';
}
