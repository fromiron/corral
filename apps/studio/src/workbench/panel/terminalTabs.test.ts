import { describe, expect, it } from 'vitest';
import { nextSearch, panelAddress, readAddress } from './address.ts';
import { ctx, enter, files, ids, panel, run, shape, way } from './fixtures.ts';
import { parsePanelMemory, rememberedPanel, serializePanelMemory } from './memory.ts';
import { EMPTY_PANEL, reducePanel, toggleAvailable } from './model.ts';
import { type PanelTab, plusItems, targetTab } from './tabs.ts';

// Terminal tabs in the panel (features/session-panel.md 탭, "+" 목록, 터미널 탭, 주소와 기억).
// Which strip a terminal opens in is decided outside this model: the model opens a terminal's
// tab only when told to, and reads an address that names one only when the panel holds its tab.

const terminal = (terminalId: string): PanelTab => ({ kind: 'terminal', terminalId });
const withPaddock = (over: Parameters<typeof ctx>[0] = {}) =>
  ctx({ paddock: true, terminalIds: ['term_1', 'term_2'], ...over });

describe('the "+" list\'s 터미널', () => {
  it('stands second, after 파일, in server mode with a Paddock, and nowhere else', () => {
    expect(plusItems(withPaddock())).toEqual([
      'files',
      'terminal',
      'changes',
      'run-history',
      'artifacts',
    ]);
    expect(plusItems(ctx())).toEqual(['files', 'changes', 'run-history', 'artifacts']);
  });

  it("is not made or removed by a run starting or ending, and neither is the panel's toggle", () => {
    for (const runIds of [[], ['run_1']]) {
      const c = withPaddock({ folder: false, runIds });
      expect(plusItems(c)).toContain('terminal');
      expect(toggleAvailable(EMPTY_PANEL, c)).toBe(true);
    }
  });

  it('keeps the panel open on its list when the last tab closes and only 터미널 can be opened', () => {
    const c = withPaddock({ folder: false, runIds: [] });
    const open = panel({
      tabs: [terminal('term_1')],
      selected: 'terminal:term_1',
      presentation: 'beside',
    });
    const { state } = reducePanel(open, { type: 'close', key: 'terminal:term_1' }, c);
    expect(shape(state)).toEqual({ tabs: [], selected: null, presentation: 'beside' });
  });
});

describe("opening a terminal's tab in the panel", () => {
  it('opens it at the right end, selects it and writes panel=terminal with its ID', () => {
    const start = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const result = reducePanel(
      start,
      way({ panel: 'terminal', terminal: 'term_1' }),
      withPaddock(),
    );
    expect(ids(result.state)).toEqual([files, terminal('term_1')]);
    expect(result.state.selected).toBe('terminal:term_1');
    expect(result.address).toEqual({ panel: 'terminal', terminal: 'term_1' });
    expect(result.history).toBe('push');
  });

  it('opens one tab per terminal and selects an open one where it is', () => {
    let state = panel({
      tabs: [terminal('term_1'), files],
      selected: 'files',
      presentation: 'beside',
    });
    state = reducePanel(state, way({ panel: 'terminal', terminal: 'term_1' }), withPaddock()).state;
    expect(ids(state)).toEqual([terminal('term_1'), files]);
    expect(state.selected).toBe('terminal:term_1');
  });

  it('opens nothing for panel=terminal without an ID, or for panel=debug: both belong elsewhere', () => {
    const start = panel({ tabs: [files], selected: 'files', presentation: 'closed' });
    for (const target of [{ panel: 'terminal' }, { panel: 'debug' }] as const) {
      const result = reducePanel(start, way(target), withPaddock());
      expect(result.state).toBe(start);
      expect(result.history).toBeNull();
    }
    expect(targetTab({ panel: 'debug' }, [])).toBeNull();
    expect(targetTab({ panel: 'terminal' }, [])).toBeNull();
  });
});

describe('an address that names a terminal', () => {
  const memory = {
    tabs: [files, terminal('term_1')],
    selected: 'files' as const,
    open: true,
  };

  it('is read with its terminal ID', () => {
    expect(readAddress({ panel: 'terminal', terminal: 'term_1' })).toEqual({
      kind: 'panel',
      target: { panel: 'terminal', terminal: 'term_1' },
      bringForward: false,
    });
  });

  it('entering with it selects the tab the panel remembers', () => {
    const { state } = reducePanel(
      EMPTY_PANEL,
      enter({ panel: 'terminal', terminal: 'term_1' }, memory, 'address'),
      withPaddock(),
    );
    expect(shape(state)).toEqual({
      tabs: [files, terminal('term_1')],
      selected: 'terminal:term_1',
      presentation: 'beside',
    });
  });

  it.each([
    ['a terminal the panel has no tab for', { panel: 'terminal', terminal: 'term_2' }],
    ['no terminal ID', { panel: 'terminal' }],
    ['the debugger', { panel: 'debug' }],
  ] as const)(
    'entering with %s restores the panel as remembered, as if the address had neither',
    (_case, search) => {
      for (const via of ['link', 'address'] as const) {
        const result = reducePanel(EMPTY_PANEL, enter(search, memory, via), withPaddock());
        expect(shape(result.state)).toEqual({
          tabs: [files, terminal('term_1')],
          selected: 'files',
          presentation: 'beside',
        });
        expect(result.address).toEqual({ panel: 'files' });
        expect(result.history).toBe('replace');
      }
    },
  );

  it('following it in the app selects the panel tab it names, and leaves the panel alone otherwise', () => {
    const start = panel({
      tabs: [files, terminal('term_1')],
      selected: 'files',
      presentation: 'closed',
    });
    const there = reducePanel(
      start,
      { type: 'follow', search: { panel: 'terminal', terminal: 'term_1' }, source: 'in-app' },
      withPaddock(),
    );
    expect(there.state.selected).toBe('terminal:term_1');
    expect(there.state.presentation).toBe('beside');
    const elsewhere = reducePanel(
      start,
      { type: 'follow', search: { panel: 'terminal', terminal: 'term_2' }, source: 'in-app' },
      withPaddock(),
    );
    expect(elsewhere.state).toBe(start);
    // The address goes back to what the panel shows, without an entry of its own.
    expect(elsewhere.address).toEqual({ compose: true });
    expect(elsewhere.history).toBe('replace');
  });

  it('Back or Forward to it changes nothing the panel has no tab for', () => {
    const start = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    for (const search of [{ panel: 'terminal', terminal: 'term_1' }, { panel: 'debug' }] as const) {
      const result = reducePanel(start, { type: 'history', search }, withPaddock());
      expect(result.state).toBe(start);
      expect(result.address).toEqual({ panel: 'files' });
    }
  });

  it("a selected terminal tab writes its own ID and drops another tab's", () => {
    const state = panel({
      tabs: [files, terminal('term_1')],
      selected: 'terminal:term_1',
      presentation: 'beside',
    });
    expect(panelAddress(state)).toEqual({ panel: 'terminal', terminal: 'term_1' });
    const result = reducePanel(state, { type: 'select', key: 'files' }, withPaddock());
    expect(nextSearch({ panel: 'terminal', terminal: 'term_1' }, result)).toEqual({
      panel: 'files',
    });
  });
});

describe("the panel's memory of terminal tabs", () => {
  it('remembers a terminal tab by its terminal ID and reads it back', () => {
    const state = panel({
      tabs: [terminal('term_1'), run('run_1')],
      selected: 'terminal:term_1',
      presentation: 'beside',
    });
    const raw = serializePanelMemory(rememberedPanel(state));
    expect(JSON.parse(raw).tabs).toEqual(['terminal:term_1', 'run:run_1']);
    expect(parsePanelMemory(raw)).toEqual({
      tabs: [terminal('term_1'), run('run_1')],
      selected: 'terminal:term_1',
      open: true,
    });
  });

  it('drops a terminal entry whose ID is not an identifier', () => {
    const raw = JSON.stringify({
      v: 1,
      tabs: ['terminal:', 'terminal:../x', 'files'],
      selected: null,
      open: true,
    });
    expect(parsePanelMemory(raw)?.tabs).toEqual([files]);
  });
});

describe("the terminal list's clean-up after entry", () => {
  const memory = {
    tabs: [terminal('term_1'), terminal('term_9'), files],
    selected: 'terminal:term_9' as const,
    open: true,
  };
  const entered = (terminalIds: readonly string[] | null) =>
    reducePanel(EMPTY_PANEL, enter({}, memory, 'address'), withPaddock({ terminalIds })).state;

  it('keeps restored terminal tabs until the list answers', () => {
    expect(ids(entered(null))).toEqual([terminal('term_1'), terminal('term_9'), files]);
  });

  it('drops the restored ones the list does not hold, selecting the first left', () => {
    const before = entered(null);
    const after = reducePanel(
      before,
      { type: 'context' },
      withPaddock({ terminalIds: ['term_1'] }),
    );
    expect(shape(after.state)).toEqual({
      tabs: [terminal('term_1'), files],
      selected: 'terminal:term_1',
      presentation: 'beside',
    });
    expect(after.history).toBe('replace');
  });

  it('closes the panel when nothing restored is left', () => {
    const only = { tabs: [terminal('term_9')], selected: 'terminal:term_9' as const, open: true };
    const before = reducePanel(
      EMPTY_PANEL,
      enter({}, only, 'address'),
      withPaddock({ terminalIds: null }),
    ).state;
    const after = reducePanel(before, { type: 'context' }, withPaddock({ terminalIds: [] })).state;
    expect(shape(after)).toEqual({ tabs: [], selected: null, presentation: 'closed' });
  });

  it('runs once: a later list without a terminal leaves its tab, and the run list never touches it', () => {
    const settled = reducePanel(
      entered(null),
      { type: 'context' },
      withPaddock({ terminalIds: ['term_1'] }),
    ).state;
    const later = reducePanel(
      settled,
      { type: 'context' },
      withPaddock({ terminalIds: [], runIds: [] }),
    ).state;
    expect(ids(later)).toEqual([terminal('term_1'), files]);
  });

  it('is its own: the run list answering first leaves the terminal tabs for the terminal list', () => {
    const before = reducePanel(
      EMPTY_PANEL,
      enter({}, { ...memory, tabs: [...memory.tabs, run('run_1')] }, 'address'),
      withPaddock({ terminalIds: null, runIds: null }),
    ).state;
    const runsAnswered = reducePanel(
      before,
      { type: 'context' },
      withPaddock({ terminalIds: null }),
    ).state;
    expect(ids(runsAnswered)).toContainEqual(terminal('term_9'));
    const both = reducePanel(
      runsAnswered,
      { type: 'context' },
      withPaddock({ terminalIds: ['term_1'] }),
    ).state;
    expect(ids(both)).toEqual([terminal('term_1'), files, run('run_1')]);
  });
});
