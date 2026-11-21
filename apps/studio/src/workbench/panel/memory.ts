// What a conversation remembers of its panel on this device (features/session-panel.md
// "주소와 기억"): tab kinds and order (a run's or a terminal's ID, a document's source and
// relative path with its Paddock's binding and generation, a team's ID, 작업's inner tab), the
// selection and whether the panel was open. Nothing else: no titles, bodies or local paths.
// Storage is passed in; this module never reaches for it.
import { Identifier } from '@corral/contracts';
import { dockMemoryKey } from './dock.ts';
import { type PanelState, tabOf } from './model.ts';
import {
  BROWSER_ID,
  type PanelTab,
  pageOrigin,
  relativePath,
  type TabKey,
  type ToolsView,
  tabKey,
} from './tabs.ts';

export interface PanelMemory {
  readonly tabs: readonly PanelTab[];
  readonly selected: TabKey | null;
  readonly open: boolean;
}

/** The part of Web Storage the panel uses. */
export interface PanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const panelMemoryKey = (sessionId: string) => `corral:session-panel:v1:${sessionId}`;

export function rememberedPanel(state: PanelState): PanelMemory {
  return {
    tabs: state.tabs.map(tabOf),
    selected: state.selected,
    open: state.presentation !== 'closed',
  };
}

export function serializePanelMemory(memory: PanelMemory): string {
  // Built key by key so nothing else can ride along.
  return JSON.stringify({
    v: 1,
    tabs: memory.tabs.map(entryOf),
    selected: memory.selected,
    open: memory.open,
  });
}

/** Unreadable or malformed memory is no memory; unknown kinds and repeated tabs are dropped. */
export function parsePanelMemory(raw: string | null | undefined): PanelMemory | null {
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
  const tabs: PanelTab[] = [];
  const keys = new Set<string>();
  for (const entry of record.tabs) {
    const tab = parseTab(entry);
    if (!tab || keys.has(tabKey(tab))) continue;
    keys.add(tabKey(tab));
    tabs.push(tab);
  }
  const first = tabs[0];
  const selected =
    typeof record.selected === 'string' && keys.has(record.selected)
      ? (record.selected as TabKey)
      : first
        ? tabKey(first)
        : null;
  return { tabs, selected, open: record.open };
}

/**
 * A tab as memory holds it: its key, except 작업 (`tools`, or `tools:` and its inner tab) and a
 * document (an object, so a path is never cut at a separator).
 */
type MemoryEntry =
  | string
  | {
      readonly document: string;
      readonly source: 'original' | 'copy';
      readonly binding?: string;
      readonly generation?: number;
    }
  | {
      readonly browser: string;
      readonly lease?: string;
      readonly origin?: string;
      readonly path?: string;
    };

function entryOf(tab: PanelTab): MemoryEntry {
  if (tab.kind === 'tools') return tab.view ? `tools:${tab.view}` : 'tools';
  // A preview page keeps only its lease; an ordinary page its origin and path (browser-tab.md 계약).
  if (tab.kind === 'browser')
    return tab.lease
      ? { browser: tab.browserId, lease: tab.lease }
      : tab.at
        ? { browser: tab.browserId, origin: tab.at.origin, path: tab.at.path }
        : { browser: tab.browserId };
  if (tab.kind !== 'document') return tabKey(tab);
  return tab.copy
    ? {
        document: tab.path,
        source: tab.source,
        binding: tab.copy.bindingId,
        generation: tab.copy.generation,
      }
    : { document: tab.path, source: tab.source };
}

const TOOLS_VIEWS: readonly ToolsView[] = ['tasks', 'preview'];

function parseDocument(entry: Record<string, unknown>): PanelTab | null {
  const { document: path, source, binding, generation } = entry;
  if (!relativePath(path) || (source !== 'original' && source !== 'copy')) return null;
  if (source === 'original' || (binding === undefined && generation === undefined))
    return { kind: 'document', source, path };
  if (
    !Identifier.safeParse(binding).success ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    return null;
  return { kind: 'document', source, path, copy: { bindingId: binding as string, generation } };
}

function parseBrowser(entry: Record<string, unknown>): PanelTab | null {
  const { browser: browserId, lease, origin, path } = entry;
  if (typeof browserId !== 'string' || !BROWSER_ID.test(browserId)) return null;
  if (lease !== undefined)
    return Identifier.safeParse(lease).success
      ? { kind: 'browser', browserId, lease: lease as string }
      : null;
  if (origin === undefined && path === undefined) return { kind: 'browser', browserId };
  if (
    !pageOrigin(origin) ||
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.length > 4096
  )
    return null;
  return { kind: 'browser', browserId, at: { origin, path } };
}

function parseTab(entry: unknown): PanelTab | null {
  if (entry === 'files' || entry === 'changes' || entry === 'artifacts') return { kind: entry };
  if (entry === 'tools') return { kind: 'tools', view: null };
  if (typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    return 'browser' in entry
      ? parseBrowser(entry as Record<string, unknown>)
      : parseDocument(entry as Record<string, unknown>);
  if (typeof entry !== 'string') return null;
  if (entry.startsWith('tools:')) {
    const view = TOOLS_VIEWS.find((value) => `tools:${value}` === entry);
    return view ? { kind: 'tools', view } : null;
  }
  if (entry.startsWith('graph:')) {
    const corralId = entry.slice('graph:'.length);
    return Identifier.safeParse(corralId).success ? { kind: 'graph', corralId } : null;
  }
  if (entry.startsWith('terminal:')) {
    const terminalId = entry.slice('terminal:'.length);
    return Identifier.safeParse(terminalId).success ? { kind: 'terminal', terminalId } : null;
  }
  if (!entry.startsWith('run:')) return null;
  const runId = entry.slice('run:'.length);
  return Identifier.safeParse(runId).success ? { kind: 'run', runId } : null;
}

export function readPanelMemory(
  storage: PanelStorage | null,
  sessionId: string,
): PanelMemory | null {
  try {
    return parsePanelMemory(storage?.getItem(panelMemoryKey(sessionId)));
  } catch {
    return null;
  }
}

/** Writes the state's memory; a failure is silent and reported only as false. */
export function writePanelMemory(
  storage: PanelStorage | null,
  sessionId: string,
  state: PanelState,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(panelMemoryKey(sessionId), serializePanelMemory(rememberedPanel(state)));
    return true;
  } catch {
    return false;
  }
}

/** Deleting a conversation deletes its memory: the panel's and the bottom dock's. */
export function forgetPanelMemory(storage: PanelStorage | null, sessionId: string): void {
  for (const key of [panelMemoryKey(sessionId), dockMemoryKey(sessionId)])
    try {
      storage?.removeItem(key);
    } catch {
      // Nothing to tell: the memory stays until it is overwritten.
    }
}

/** This device's local storage, or null where it cannot be reached. */
export function deviceStorage(): PanelStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
