import { describe, expect, it } from 'vitest';
import { files, panel, run } from './fixtures.ts';
import {
  forgetPanelMemory,
  type PanelStorage,
  panelMemoryKey,
  parsePanelMemory,
  readPanelMemory,
  rememberedPanel,
  serializePanelMemory,
  writePanelMemory,
} from './memory.ts';
import type { PanelState } from './model.ts';

const state: PanelState = panel({
  tabs: [files, run('run_1')],
  selected: 'run:run_1',
  presentation: 'maximized',
});

const memoryStorage = (): PanelStorage & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
};
const throwing: PanelStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('what a conversation remembers on this device', () => {
  it('remembers the tab kinds, run ids, order, selection and whether the panel was open', () => {
    expect(rememberedPanel(state)).toEqual({
      tabs: [{ kind: 'files' }, { kind: 'run', runId: 'run_1' }],
      selected: 'run:run_1',
      open: true,
    });
  });

  it('counts 물러남 and 서랍 as open and 닫힘 as not', () => {
    expect(rememberedPanel({ ...state, presentation: 'withdrawn' }).open).toBe(true);
    expect(rememberedPanel({ ...state, presentation: 'drawer' }).open).toBe(true);
    expect(rememberedPanel({ ...state, presentation: 'closed' }).open).toBe(false);
  });

  it('writes only those keys, nothing that is not a kind, a run id or the flags', () => {
    const raw = JSON.parse(serializePanelMemory(rememberedPanel(state)));
    expect(Object.keys(raw).sort()).toEqual(['open', 'selected', 'tabs', 'v']);
    expect(raw).toEqual({ v: 1, tabs: ['files', 'run:run_1'], selected: 'run:run_1', open: true });
  });

  it('keeps no tab instance or seen flag', () => {
    for (const tab of rememberedPanel(state).tabs) {
      expect(Object.keys(tab).sort()).toEqual(tab.kind === 'run' ? ['kind', 'runId'] : ['kind']);
    }
  });

  it('round-trips', () => {
    const memory = rememberedPanel(state);
    expect(parsePanelMemory(serializePanelMemory(memory))).toEqual(memory);
  });

  it('keeps one memory per conversation, under its own key', () => {
    expect(panelMemoryKey('session_a')).toBe('corral:session-panel:v1:session_a');
    expect(panelMemoryKey('session_a')).not.toBe(panelMemoryKey('session_b'));
  });
});

describe('reading memory', () => {
  it.each<[string, string | null | undefined]>([
    ['missing', null],
    ['undefined', undefined],
    ['not JSON', '{tabs'],
    ['not an object', '"files"'],
    ['an array', '[]'],
    ['another version', JSON.stringify({ v: 2, tabs: [], selected: null, open: false })],
    ['tabs not a list', JSON.stringify({ v: 1, tabs: 'files', selected: null, open: true })],
    ['open not a flag', JSON.stringify({ v: 1, tabs: ['files'], selected: 'files', open: 'yes' })],
    ['the old session view', JSON.stringify({ panel: 'run', run: 'run_1' })],
  ])('treats %s memory as no memory (failure)', (_name, raw) => {
    expect(parsePanelMemory(raw)).toBeNull();
  });

  it('drops unknown kinds and malformed run ids, keeping the rest in order', () => {
    expect(
      parsePanelMemory(
        JSON.stringify({
          v: 1,
          tabs: ['terminal', 'files', 'run:', 'run:../x', 7, 'run:run_1', 'browser'],
          selected: 'run:run_1',
          open: true,
        }),
      ),
    ).toEqual({
      tabs: [{ kind: 'files' }, { kind: 'run', runId: 'run_1' }],
      selected: 'run:run_1',
      open: true,
    });
  });

  it('drops repeated tabs, keeping the first (duplicate)', () => {
    expect(
      parsePanelMemory(
        JSON.stringify({
          v: 1,
          tabs: ['run:run_1', 'files', 'run:run_1', 'files'],
          selected: 'files',
          open: true,
        }),
      ),
    ).toEqual({
      tabs: [{ kind: 'run', runId: 'run_1' }, { kind: 'files' }],
      selected: 'files',
      open: true,
    });
  });

  it('selects the first tab when the remembered selection was dropped or is missing', () => {
    expect(
      parsePanelMemory(
        JSON.stringify({ v: 1, tabs: ['changes', 'browser'], selected: 'browser', open: true }),
      )?.selected,
    ).toBe('changes');
    expect(
      parsePanelMemory(JSON.stringify({ v: 1, tabs: ['changes'], selected: null, open: true }))
        ?.selected,
    ).toBe('changes');
  });

  it('has no selection without tabs', () => {
    expect(
      parsePanelMemory(JSON.stringify({ v: 1, tabs: [], selected: 'files', open: true })),
    ).toEqual({
      tabs: [],
      selected: null,
      open: true,
    });
  });

  it('reads nothing when storage throws or is missing (failure)', () => {
    expect(readPanelMemory(throwing, 'session_a')).toBeNull();
    expect(readPanelMemory(null, 'session_a')).toBeNull();
  });

  it('reads what was written for the same conversation only', () => {
    const storage = memoryStorage();
    expect(writePanelMemory(storage, 'session_a', state)).toBe(true);
    expect(readPanelMemory(storage, 'session_a')).toEqual(rememberedPanel(state));
    expect(readPanelMemory(storage, 'session_b')).toBeNull();
  });
});

describe('writing memory', () => {
  it('fails silently when storage throws or is missing (failure)', () => {
    expect(() => writePanelMemory(throwing, 'session_a', state)).not.toThrow();
    expect(writePanelMemory(throwing, 'session_a', state)).toBe(false);
    expect(writePanelMemory(null, 'session_a', state)).toBe(false);
  });

  it('keeps the later write when two windows write the same conversation', () => {
    const storage = memoryStorage();
    writePanelMemory(storage, 'session_a', state);
    writePanelMemory(storage, 'session_a', { ...state, presentation: 'closed' });
    expect(readPanelMemory(storage, 'session_a')?.open).toBe(false);
  });

  it('forgets a deleted conversation’s memory, silently if storage throws', () => {
    const storage = memoryStorage();
    writePanelMemory(storage, 'session_a', state);
    forgetPanelMemory(storage, 'session_a');
    expect(storage.items.size).toBe(0);
    expect(() => forgetPanelMemory(throwing, 'session_a')).not.toThrow();
  });
});
