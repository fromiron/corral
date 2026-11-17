import { describe, expect, it } from 'vitest';
import {
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  type DockState,
  dockKey,
  dockMemoryKey,
  EMPTY_DOCK,
  parseDockMemory,
  readDockMemory,
  reduceDock,
  restoredDock,
  serializeDockMemory,
} from './dock.ts';
import { forgetPanelMemory, type PanelStorage } from './memory.ts';

const terminal = (terminalId: string) => ({ kind: 'terminal', terminalId }) as const;
const debug = { kind: 'debug' } as const;
const dock = (overrides: Partial<DockState> = {}): DockState => ({ ...EMPTY_DOCK, ...overrides });

const memoryStorage = (): PanelStorage & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
};

describe('the bottom dock as data', () => {
  it('starts closed with no tabs at the default height', () => {
    expect(EMPTY_DOCK).toMatchObject({ tabs: [], selected: null, open: false });
    expect(EMPTY_DOCK.height).toBe(DOCK_DEFAULT_HEIGHT);
    expect(DOCK_DEFAULT_HEIGHT).toBe(240);
    expect(DOCK_MIN_HEIGHT).toBe(120);
  });

  it('toggles open and closed, keeping its tabs and selection', () => {
    const start = dock({ tabs: [debug, terminal('t1')], selected: 'debug', open: false });
    const opened = reduceDock(start, { type: 'toggle' });
    expect(opened).toMatchObject({ open: true, selected: 'debug' });
    expect(opened.tabs).toEqual(start.tabs);
    expect(reduceDock(opened, { type: 'toggle' })).toMatchObject({
      open: false,
      selected: 'debug',
    });
  });

  it('opens a tab at the end and selects it; opening it again only selects it', () => {
    const one = reduceDock(dock({ tabs: [debug], selected: 'debug' }), {
      type: 'open',
      tab: terminal('t1'),
    });
    expect(one.tabs.map(dockKey)).toEqual(['debug', 'terminal:t1']);
    expect(one).toMatchObject({ selected: 'terminal:t1', open: true });
    const again = reduceDock({ ...one, selected: 'debug' }, { type: 'open', tab: terminal('t1') });
    expect(again.tabs.map(dockKey)).toEqual(['debug', 'terminal:t1']);
    expect(again.selected).toBe('terminal:t1');
  });

  it('adds a tab without opening the dock when told to keep it as it is (a late creation)', () => {
    const added = reduceDock(dock({ open: false }), {
      type: 'open',
      tab: terminal('t1'),
      keepOpen: true,
    });
    expect(added).toMatchObject({ open: false, selected: 'terminal:t1' });
    expect(added.tabs.map(dockKey)).toEqual(['terminal:t1']);
  });

  it('closes a tab with the panel’s neighbour rule, and stays open with its last tab closed', () => {
    const three = dock({
      tabs: [debug, terminal('t1'), terminal('t2')],
      selected: 'terminal:t1',
      open: true,
    });
    expect(reduceDock(three, { type: 'close', key: 'terminal:t1' }).selected).toBe('terminal:t2');
    expect(reduceDock(three, { type: 'close', key: 'debug' }).selected).toBe('terminal:t1');
    const last = dock({ tabs: [terminal('t2')], selected: 'terminal:t2', open: true });
    // As the panel's last tab: the dock stays open and its body lists what it can open.
    expect(reduceDock(last, { type: 'close', key: 'terminal:t2' })).toMatchObject({
      tabs: [],
      selected: null,
      open: true,
    });
    const rightmost = dock({ tabs: [debug, terminal('t1')], selected: 'terminal:t1', open: true });
    expect(reduceDock(rightmost, { type: 'close', key: 'terminal:t1' }).selected).toBe('debug');
  });

  it('keeps a height of at least the minimum', () => {
    expect(reduceDock(dock(), { type: 'height', px: 60 }).height).toBe(DOCK_MIN_HEIGHT);
    expect(reduceDock(dock(), { type: 'height', px: 333 }).height).toBe(333);
  });

  it('drops restored terminal tabs the first terminal list does not have, once', () => {
    const restored = restoredDock({
      tabs: [debug, terminal('t3'), terminal('t1')],
      selected: 'terminal:t3',
      open: true,
      height: 300,
    });
    const cleaned = reduceDock(restored, { type: 'terminals', ids: ['t1'] });
    expect(cleaned.tabs.map(dockKey)).toEqual(['debug', 'terminal:t1']);
    // The selected tab was dropped: the first one left is chosen.
    expect(cleaned.selected).toBe('debug');
    expect(cleaned.open).toBe(true);
    // A tab opened after the first answer is never checked again.
    const later = reduceDock(reduceDock(cleaned, { type: 'open', tab: terminal('t9') }), {
      type: 'terminals',
      ids: ['t1'],
    });
    expect(later.tabs.map(dockKey)).toEqual(['debug', 'terminal:t1', 'terminal:t9']);
  });

  it('hides the dock when the clean-up leaves no tab, and keeps the tabs when the list fails', () => {
    const restored = restoredDock({
      tabs: [terminal('t3')],
      selected: 'terminal:t3',
      open: true,
      height: 240,
    });
    expect(reduceDock(restored, { type: 'terminals', ids: [] })).toMatchObject({
      tabs: [],
      selected: null,
      open: false,
    });
    const unread = reduceDock(restored, { type: 'terminals', ids: null });
    expect(unread.tabs.map(dockKey)).toEqual(['terminal:t3']);
    // That answer was the one: a later list does not drop it.
    expect(reduceDock(unread, { type: 'terminals', ids: [] }).tabs.map(dockKey)).toEqual([
      'terminal:t3',
    ]);
  });

  it('restores a dock remembered open with no tabs as closed', () => {
    expect(restoredDock({ tabs: [], selected: null, open: true, height: 300 })).toMatchObject({
      open: false,
      height: 300,
    });
    expect(restoredDock(null)).toEqual(EMPTY_DOCK);
  });
});

describe('what a conversation remembers of its dock', () => {
  const state = dock({
    tabs: [terminal('terminal_1'), debug],
    selected: 'terminal:terminal_1',
    open: true,
    height: 320,
  });

  it('writes the tab kinds, terminal ids, order, selection, openness and height only', () => {
    const raw = JSON.parse(serializeDockMemory(state));
    expect(raw).toEqual({
      v: 1,
      tabs: ['terminal:terminal_1', 'debug'],
      selected: 'terminal:terminal_1',
      open: true,
      height: 320,
    });
  });

  it('reads back what it wrote, and treats malformed memory as none', () => {
    expect(parseDockMemory(serializeDockMemory(state))).toEqual({
      tabs: [terminal('terminal_1'), debug],
      selected: 'terminal:terminal_1',
      open: true,
      height: 320,
    });
    expect(parseDockMemory('{')).toBeNull();
    expect(parseDockMemory(JSON.stringify({ v: 2, tabs: [], open: true, height: 1 }))).toBeNull();
    expect(parseDockMemory(JSON.stringify({ v: 1, tabs: [], open: 'yes', height: 1 }))).toBeNull();
  });

  it('drops unknown kinds, bad terminal ids and repeats; a bad height is the default', () => {
    const parsed = parseDockMemory(
      JSON.stringify({
        v: 1,
        tabs: ['debug', 'files', 'terminal:../x', 'terminal:t1', 'debug', 'terminal:t1'],
        selected: 'files',
        open: false,
        height: 'tall',
      }),
    );
    expect(parsed).toEqual({
      tabs: [debug, terminal('t1')],
      selected: 'debug',
      open: false,
      height: DOCK_DEFAULT_HEIGHT,
    });
  });

  it('is kept per conversation, separately from the panel, and goes when the conversation does', () => {
    const storage = memoryStorage();
    storage.setItem(dockMemoryKey('session_a'), serializeDockMemory(state));
    expect(readDockMemory(storage, 'session_a')?.height).toBe(320);
    expect(readDockMemory(storage, 'session_b')).toBeNull();
    forgetPanelMemory(storage, 'session_a');
    expect(storage.items.has(dockMemoryKey('session_a'))).toBe(false);
  });
});
