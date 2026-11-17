// The bottom dock as plain data and one reducer (features/session-panel.md 하단 도크): its tabs
// (terminals and the debugger), the selected tab, whether it is open and its height. No screen
// and no storage: SessionPage dispatches and writes what comes back. What an empty dock shows
// when it opens (a terminal taken in, a new one, its list) is the page's to decide; the model
// only adds the tab it is given.
import { Identifier } from '@corral/contracts';
import type { PanelStorage } from './memory.ts';

export type DockTab =
  | { readonly kind: 'terminal'; readonly terminalId: string }
  | { readonly kind: 'debug' };
export type DockKey = `terminal:${string}` | 'debug';

export const dockKey = (tab: DockTab): DockKey =>
  tab.kind === 'terminal' ? `terminal:${tab.terminalId}` : 'debug';

/** The dock's least shown height and its height with no memory (px). */
export const DOCK_MIN_HEIGHT = 120;
export const DOCK_DEFAULT_HEIGHT = 240;
/** The message area's least height the dock yields to (px). */
export const MESSAGES_MIN_HEIGHT = 160;

export interface DockState {
  readonly tabs: readonly DockTab[];
  /** The selected tab; null exactly when there are no tabs. */
  readonly selected: DockKey | null;
  /** Open as the person left it (a withdrawn dock is open). */
  readonly open: boolean;
  /** The remembered height in px; the shown height may be less. */
  readonly height: number;
  /** Restored terminal tabs wait for the first terminal list after entry to be checked. */
  readonly unchecked: readonly string[];
}

export const EMPTY_DOCK: DockState = {
  tabs: [],
  selected: null,
  open: false,
  height: DOCK_DEFAULT_HEIGHT,
  unchecked: [],
};

export type DockEvent =
  | { readonly type: 'toggle' }
  /**
   * Opens or selects a tab; `keepOpen` leaves the dock open or closed as it is; `index` puts a
   * tab not yet here before the tab at that index (a drag let go there), else at the right end.
   */
  | {
      readonly type: 'open';
      readonly tab: DockTab;
      readonly keepOpen?: boolean;
      readonly index?: number;
    }
  /** A tab dragged or moved by key to `toIndex` in the strip; the selection stays. */
  | { readonly type: 'reorder'; readonly key: DockKey; readonly toIndex: number }
  /** Opens the dock as it is: with no tab, its body's list or line. */
  | { readonly type: 'show' }
  | { readonly type: 'select'; readonly key: DockKey }
  | { readonly type: 'close'; readonly key: DockKey }
  | { readonly type: 'height'; readonly px: number }
  /** The first terminal list after entry: its terminal ids, or null when it could not be read. */
  | { readonly type: 'terminals'; readonly ids: readonly string[] | null };

export function reduceDock(state: DockState, event: DockEvent): DockState {
  switch (event.type) {
    case 'toggle':
      return { ...state, open: !state.open };
    case 'show':
      return state.open ? state : { ...state, open: true };
    case 'open': {
      const key = dockKey(event.tab);
      const index = event.index ?? state.tabs.length;
      const tabs = state.tabs.some((tab) => dockKey(tab) === key)
        ? state.tabs
        : [...state.tabs.slice(0, index), event.tab, ...state.tabs.slice(index)];
      return { ...state, tabs, selected: key, open: event.keepOpen ? state.open : true };
    }
    case 'reorder': {
      const from = state.tabs.findIndex((tab) => dockKey(tab) === event.key);
      const to = Math.max(0, Math.min(event.toIndex, state.tabs.length - 1));
      if (from < 0 || from === to) return state;
      const tabs = state.tabs.filter((_, index) => index !== from);
      tabs.splice(to, 0, state.tabs[from] as DockTab);
      return { ...state, tabs };
    }
    case 'select':
      return state.tabs.some((tab) => dockKey(tab) === event.key)
        ? { ...state, selected: event.key }
        : state;
    case 'close': {
      const keys = state.tabs.map(dockKey);
      const index = keys.indexOf(event.key);
      if (index < 0) return state;
      const tabs = state.tabs.filter((_, at) => at !== index);
      // As the panel's last tab: the dock stays open with its list.
      if (tabs.length === 0) return { ...state, tabs, selected: null };
      const selected =
        state.selected === event.key
          ? (keys[index + 1] ?? keys[index - 1] ?? null)
          : state.selected;
      return { ...state, tabs, selected };
    }
    case 'height':
      return { ...state, height: Math.max(DOCK_MIN_HEIGHT, Math.round(event.px)) };
    case 'terminals': {
      if (state.unchecked.length === 0) return state;
      if (event.ids === null) return { ...state, unchecked: [] };
      const known = new Set(event.ids);
      const tabs = state.tabs.filter(
        (tab) =>
          tab.kind !== 'terminal' ||
          !state.unchecked.includes(tab.terminalId) ||
          known.has(tab.terminalId),
      );
      const first = tabs[0];
      if (!first) return { ...state, tabs, selected: null, open: false, unchecked: [] };
      const selected =
        state.selected && tabs.some((tab) => dockKey(tab) === state.selected)
          ? state.selected
          : dockKey(first);
      return { ...state, tabs, selected, unchecked: [] };
    }
  }
}

export interface DockMemory {
  readonly tabs: readonly DockTab[];
  readonly selected: DockKey | null;
  readonly open: boolean;
  readonly height: number;
}

/** The dock a conversation enters with: its memory, an open dock with no tab restored closed. */
export function restoredDock(memory: DockMemory | null): DockState {
  if (!memory) return EMPTY_DOCK;
  return {
    tabs: memory.tabs,
    selected: memory.selected,
    open: memory.open && memory.tabs.length > 0,
    height: memory.height,
    unchecked: memory.tabs.flatMap((tab) => (tab.kind === 'terminal' ? [tab.terminalId] : [])),
  };
}

export const dockMemoryKey = (sessionId: string) => `corral:session-dock:v1:${sessionId}`;

export function serializeDockMemory(state: DockMemory): string {
  // Built key by key so nothing else can ride along.
  return JSON.stringify({
    v: 1,
    tabs: state.tabs.map(dockKey),
    selected: state.selected,
    open: state.open,
    height: state.height,
  });
}

function parseDockTab(entry: unknown): DockTab | null {
  if (entry === 'debug') return { kind: 'debug' };
  if (typeof entry !== 'string' || !entry.startsWith('terminal:')) return null;
  const terminalId = entry.slice('terminal:'.length);
  return Identifier.safeParse(terminalId).success ? { kind: 'terminal', terminalId } : null;
}

/** Unreadable or malformed memory is no memory; unknown kinds and repeated tabs are dropped. */
export function parseDockMemory(raw: string | null | undefined): DockMemory | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || !Array.isArray(record.tabs) || typeof record.open !== 'boolean')
    return null;
  const tabs: DockTab[] = [];
  const keys = new Set<string>();
  for (const entry of record.tabs) {
    const tab = parseDockTab(entry);
    if (!tab || keys.has(dockKey(tab))) continue;
    keys.add(dockKey(tab));
    tabs.push(tab);
  }
  const first = tabs[0];
  const selected =
    typeof record.selected === 'string' && keys.has(record.selected)
      ? (record.selected as DockKey)
      : first
        ? dockKey(first)
        : null;
  const height =
    typeof record.height === 'number' && Number.isFinite(record.height)
      ? Math.max(DOCK_MIN_HEIGHT, Math.round(record.height))
      : DOCK_DEFAULT_HEIGHT;
  return { tabs, selected, open: record.open, height };
}

export function readDockMemory(storage: PanelStorage | null, sessionId: string): DockMemory | null {
  try {
    return parseDockMemory(storage?.getItem(dockMemoryKey(sessionId)));
  } catch {
    return null;
  }
}

/** Writes the dock's memory; a failure is silent and reported only as false. */
export function writeDockMemory(
  storage: PanelStorage | null,
  sessionId: string,
  state: DockMemory,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(dockMemoryKey(sessionId), serializeDockMemory(state));
    return true;
  } catch {
    return false;
  }
}
