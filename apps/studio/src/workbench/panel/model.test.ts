import { describe, expect, it } from 'vitest';
import type { SessionSearch } from '../panels/routes.ts';
import { panelAddress } from './address.ts';
import {
  changes,
  context,
  ctx,
  enter,
  files,
  ids,
  narrow,
  panel,
  run,
  runLink,
  shape,
  steps,
  unlisted,
  way,
} from './fixtures.ts';
import { rememberedPanel } from './memory.ts';
import {
  conversationOperable,
  EMPTY_PANEL,
  maximizeAvailable,
  type PanelEvent,
  type PanelState,
  type Presentation,
  panelOnScreen,
  reducePanel,
  toggleAvailable,
} from './model.ts';
import type { PanelContext, PanelTab } from './tabs.ts';

/** 파일 · 실행 #1, 실행 #1 selected. */
const withTabs = (presentation: Presentation, over: Parameters<typeof panel>[0] = {}) =>
  panel({ tabs: [files, run('run_1')], selected: 'run:run_1', presentation, ...over });
const EMPTY = shape(EMPTY_PANEL);
const memoryOf = { tabs: [files, run('run_1')], selected: 'run:run_1' as const, open: true };

describe('opening tabs (여는 길)', () => {
  it('opens a closed tab at the right end and selects it', () => {
    const { state } = reducePanel(withTabs('beside'), way({ panel: 'changes' }), ctx());
    expect(ids(state)).toEqual([files, run('run_1'), changes]);
    expect(state.selected).toBe('changes');
  });

  it('selects an open tab without moving it', () => {
    const { state } = reducePanel(withTabs('beside'), way({ panel: 'terminal' }), ctx());
    expect(ids(state)).toEqual([files, run('run_1')]);
    expect(state.selected).toBe('files');
  });

  it('is idempotent: the same open twice leaves one tab and the same order (duplicate)', () => {
    const once = reducePanel(withTabs('beside'), runLink('run_2'), ctx()).state;
    const twice = reducePanel(once, runLink('run_2'), ctx()).state;
    expect(ids(twice)).toEqual([files, run('run_1'), run('run_2')]);
    expect(twice).toBe(once);
  });

  it('opens a run tab per run', () => {
    const { state } = steps(EMPTY_PANEL, [runLink('run_1'), runLink('run_2')]);
    expect(ids(state)).toEqual([run('run_1'), run('run_2')]);
  });

  it('opens 파일 and 변경 by an opening way even without a folder', () => {
    const { state } = reducePanel(
      EMPTY_PANEL,
      way({ panel: 'debug' }),
      ctx({ folder: false, runIds: [] }),
    );
    expect(ids(state)).toEqual([files]);
    expect(state.presentation).toBe('beside');
  });

  it('leaves the panel exactly as it is for panel=run in a conversation without runs', () => {
    const before = withTabs('beside');
    const result = reducePanel(before, way({ panel: 'run' }), ctx({ runIds: [] }));
    expect(result.state).toBe(before);
    expect(result.history).toBeNull();
  });

  it('opens nothing for a bare panel=run while the run list is not known', () => {
    const before = withTabs('closed');
    const result = reducePanel(before, way({ panel: 'run' }), unlisted());
    expect(result.state).toBe(before);
    expect(result.history).toBeNull();
  });

  it('opens a named run’s tab while the run list is not known', () => {
    const { state } = reducePanel(EMPTY_PANEL, runLink('run_3'), unlisted());
    expect(ids(state)).toEqual([run('run_3')]);
  });
});

describe('tab identity', () => {
  it('gives a reopened tab a new instance, so it starts fresh', () => {
    const first = reducePanel(EMPTY_PANEL, way({ panel: 'files' }), ctx()).state;
    const closed = reducePanel(first, { type: 'close', key: 'files' }, ctx()).state;
    const again = reducePanel(closed, way({ panel: 'files' }), ctx()).state;
    expect(again.tabs[0]?.instance).not.toBe(first.tabs[0]?.instance);
  });

  it('keeps the instance while the tab stays open: selected again, panel closed and reopened', () => {
    const before = withTabs('beside');
    const instances = before.tabs.map((tab) => tab.instance);
    const { state } = steps(before, [
      { type: 'select', key: 'files' },
      { type: 'toggle' },
      { type: 'toggle' },
      runLink('run_1'),
    ]);
    expect(state.tabs.map((tab) => tab.instance)).toEqual(instances);
  });

  it('gives every open tab its own instance', () => {
    const { state } = steps(EMPTY_PANEL, [
      way({ panel: 'files' }),
      runLink('run_1'),
      way({ panel: 'changes' }),
    ]);
    expect(new Set(state.tabs.map((tab) => tab.instance)).size).toBe(3);
  });

  it('marks a restored tab seen only once it is selected while the panel is on screen', () => {
    const restored = reducePanel(EMPTY_PANEL, enter({}, memoryOf), narrow()).state;
    expect(restored.presentation).toBe('withdrawn');
    expect(restored.tabs.map((tab) => tab.seen)).toEqual([false, false]);
    const wider = reducePanel(restored, context, ctx()).state;
    expect(wider.tabs.map((tab) => tab.seen)).toEqual([false, true]);
    const chosen = reducePanel(wider, { type: 'select', key: 'files' }, ctx()).state;
    expect(chosen.tabs.map((tab) => tab.seen)).toEqual([true, true]);
    const closedPanel = reducePanel(chosen, { type: 'toggle' }, ctx()).state;
    expect(closedPanel.tabs.map((tab) => tab.seen)).toEqual([true, true]);
  });

  it('marks a tab opened on screen as seen and one opened withdrawn as not', () => {
    expect(reducePanel(EMPTY_PANEL, runLink('run_1'), ctx()).state.tabs[0]?.seen).toBe(true);
    const outside = reducePanel(
      EMPTY_PANEL,
      { type: 'follow', search: { panel: 'run', run: 'run_1' }, source: 'outside' },
      narrow(),
    ).state;
    expect(outside.presentation).toBe('withdrawn');
    expect(outside.tabs[0]?.seen).toBe(false);
  });
});

describe('the tab strip', () => {
  it('selects a tab', () => {
    const { state, history } = reducePanel(
      withTabs('beside'),
      { type: 'select', key: 'files' },
      ctx(),
    );
    expect(state.selected).toBe('files');
    expect(history).toBe('replace');
  });

  it('ignores selecting a tab that is not open', () => {
    const before = withTabs('beside');
    expect(reducePanel(before, { type: 'select', key: 'changes' }, ctx()).state).toBe(before);
  });

  it('selects the right neighbour when the selected tab closes', () => {
    const before = panel({
      tabs: [files, run('run_1'), run('run_2')],
      selected: 'run:run_1',
      presentation: 'beside',
    });
    expect(reducePanel(before, { type: 'close', key: 'run:run_1' }, ctx()).state.selected).toBe(
      'run:run_2',
    );
  });

  it('selects the left neighbour when the selected tab has none on its right', () => {
    const before = panel({
      tabs: [files, run('run_1'), run('run_2')],
      selected: 'run:run_2',
      presentation: 'beside',
    });
    expect(reducePanel(before, { type: 'close', key: 'run:run_2' }, ctx()).state.selected).toBe(
      'run:run_1',
    );
  });

  it('keeps the selection when an unselected tab closes', () => {
    const { state } = reducePanel(
      withTabs('beside', { selected: 'files' }),
      { type: 'close', key: 'run:run_1' },
      ctx(),
    );
    expect(ids(state)).toEqual([files]);
    expect(state.selected).toBe('files');
  });

  it('keeps the panel open on its list when the last tab closes', () => {
    const { state } = reducePanel(
      panel({ tabs: [files], selected: 'files', presentation: 'drawer' }),
      { type: 'close', key: 'files' },
      narrow(),
    );
    expect(shape(state)).toEqual({ ...EMPTY, presentation: 'drawer' });
  });

  it('releases maximize when the last tab closes: 옆 with room, 닫힘 without (물러남 needs a tab)', () => {
    const only = panel({ tabs: [run('run_1')], selected: 'run:run_1', presentation: 'maximized' });
    const close: PanelEvent = { type: 'close', key: 'run:run_1' };
    expect(reducePanel(only, close, ctx()).state.presentation).toBe('beside');
    expect(reducePanel(only, close, narrow()).state.presentation).toBe('closed');
  });

  it('closes the panel when the last tab closes and nothing can be opened', () => {
    const { state } = reducePanel(
      panel({ tabs: [files], selected: 'files', presentation: 'beside' }),
      { type: 'close', key: 'files' },
      ctx({ folder: false, runIds: [] }),
    );
    expect(shape(state)).toEqual(EMPTY);
  });

  it('keeps the panel open on its list after the last tab while the run list is not known', () => {
    const { state } = reducePanel(
      panel({ tabs: [files], selected: 'files', presentation: 'beside' }),
      { type: 'close', key: 'files' },
      unlisted({ folder: false }),
    );
    expect(shape(state)).toEqual({ ...EMPTY, presentation: 'beside' });
  });

  it('closing a tab twice changes nothing the second time (duplicate)', () => {
    const once = reducePanel(withTabs('beside'), { type: 'close', key: 'files' }, ctx());
    const twice = reducePanel(once.state, { type: 'close', key: 'files' }, ctx());
    expect(twice.state).toBe(once.state);
    expect(twice.history).toBeNull();
  });
});

describe('the panel toggle', () => {
  it.each<[Presentation, boolean, Presentation]>([
    ['closed', true, 'beside'],
    ['closed', false, 'drawer'],
    ['withdrawn', false, 'drawer'],
    ['beside', true, 'closed'],
    ['maximized', true, 'closed'],
    ['maximized', false, 'closed'],
    ['drawer', false, 'closed'],
  ])('turns %s (room %s) into %s and keeps the tabs and selection', (from, room, to) => {
    const { state } = reducePanel(withTabs(from), { type: 'toggle' }, ctx({ room }));
    expect(state.presentation).toBe(to);
    expect(ids(state)).toEqual([files, run('run_1')]);
    expect(state.selected).toBe('run:run_1');
  });

  it('reopens with the same selection', () => {
    const before = withTabs('beside', { selected: 'files' });
    const { state } = steps(before, [{ type: 'toggle' }, { type: 'toggle' }]);
    expect(shape(state)).toEqual(shape(before));
  });

  it('opens an empty panel on its list when something can be opened', () => {
    expect(shape(reducePanel(EMPTY_PANEL, { type: 'toggle' }, ctx()).state)).toEqual({
      ...EMPTY,
      presentation: 'beside',
    });
  });

  it('does nothing in a conversation with no tab and nothing to open', () => {
    const none = ctx({ folder: false, runIds: [] });
    expect(reducePanel(EMPTY_PANEL, { type: 'toggle' }, none).state).toBe(EMPTY_PANEL);
    expect(toggleAvailable(EMPTY_PANEL, none)).toBe(false);
    expect(toggleAvailable(EMPTY_PANEL, ctx({ folder: false }))).toBe(true);
    expect(toggleAvailable(panel({ tabs: [files], selected: 'files' }), none)).toBe(true);
  });

  it('shows no toggle for runs that are not listed yet, and shows it once they are', () => {
    expect(toggleAvailable(EMPTY_PANEL, unlisted({ folder: false }))).toBe(false);
    expect(toggleAvailable(EMPTY_PANEL, ctx({ folder: false }))).toBe(true);
  });

  it.each<[Presentation, boolean]>([
    ['closed', false],
    ['beside', true],
    ['maximized', true],
    ['drawer', true],
    ['withdrawn', false],
  ])('shows %s as pressed: %s', (presentation, pressed) => {
    expect(panelOnScreen(presentation)).toBe(pressed);
  });
});

describe('maximize', () => {
  it('maximizes from 옆 when there are tabs and releases with the same button', () => {
    const max = reducePanel(withTabs('beside'), { type: 'maximize' }, ctx()).state;
    expect(max.presentation).toBe('maximized');
    expect(reducePanel(max, { type: 'maximize' }, ctx()).state.presentation).toBe('beside');
  });

  it('releases to 물러남 when there is no room', () => {
    expect(
      reducePanel(withTabs('maximized'), { type: 'maximize' }, narrow()).state.presentation,
    ).toBe('withdrawn');
  });

  it.each<[Presentation, boolean]>([
    ['closed', true],
    ['drawer', false],
    ['withdrawn', false],
  ])('does nothing from %s', (from, room) => {
    const before = withTabs(from);
    expect(reducePanel(before, { type: 'maximize' }, ctx({ room })).state).toBe(before);
  });

  it('has no button on a panel without tabs, nor in a drawer', () => {
    const empty = panel({ presentation: 'beside' });
    expect(maximizeAvailable(empty)).toBe(false);
    expect(reducePanel(empty, { type: 'maximize' }, ctx()).state).toBe(empty);
    expect(maximizeAvailable(withTabs('beside'))).toBe(true);
    expect(maximizeAvailable(withTabs('maximized'))).toBe(true);
    expect(maximizeAvailable(withTabs('drawer'))).toBe(false);
  });

  it('is released by closing the panel, and not remembered when it reopens', () => {
    const { state } = steps(withTabs('maximized'), [{ type: 'toggle' }, { type: 'toggle' }]);
    expect(state.presentation).toBe('beside');
  });
});

describe('the drawer', () => {
  it('closes on Escape or the dimmed conversation, keeping the tabs', () => {
    const { state, history } = reducePanel(withTabs('drawer'), { type: 'closeDrawer' }, narrow());
    expect(shape(state)).toEqual(shape(withTabs('closed')));
    expect(history).toBe('replace');
  });

  it.each<[Presentation, boolean]>([
    ['closed', true],
    ['beside', true],
    ['maximized', true],
    ['withdrawn', false],
  ])('is not there to close from %s', (from, room) => {
    const before = withTabs(from);
    expect(reducePanel(before, { type: 'closeDrawer' }, ctx({ room })).state).toBe(before);
  });
});

describe('bringing the conversation forward', () => {
  it.each<[Presentation, boolean, Presentation]>([
    ['closed', true, 'closed'],
    ['beside', true, 'beside'],
    ['withdrawn', false, 'withdrawn'],
    ['maximized', true, 'beside'],
    ['maximized', false, 'withdrawn'],
    ['drawer', false, 'closed'],
  ])('turns %s (room %s) into %s, tabs and selection unchanged', (from, room, to) => {
    const { state, bringForward } = reducePanel(
      withTabs(from),
      { type: 'bringForward' },
      ctx({ room }),
    );
    expect(state.presentation).toBe(to);
    expect(ids(state)).toEqual([files, run('run_1')]);
    expect(state.selected).toBe('run:run_1');
    expect(bringForward).toBe(true);
  });

  it('changes nothing in the states that keep the conversation operable', () => {
    for (const [from, room] of [
      ['closed', true],
      ['beside', true],
      ['withdrawn', false],
    ] as const) {
      const before = withTabs(from);
      expect(reducePanel(before, { type: 'bringForward' }, ctx({ room })).state).toBe(before);
    }
  });
});

// Every cell of the table in "자리와 패널의 상태". Rows are the states a panel can be in with
// the room that state implies (옆 has room, 서랍 and 물러남 have none).
const ROWS: readonly [Presentation, boolean][] = [
  ['closed', true],
  ['closed', false],
  ['beside', true],
  ['maximized', true],
  ['maximized', false],
  ['drawer', false],
  ['withdrawn', false],
];
const runTwo: SessionSearch = { panel: 'run', run: 'run_2' };

describe('the table of room and panel states', () => {
  it.each<[Presentation, Presentation]>([
    ['closed', 'closed'],
    ['beside', 'withdrawn'],
    ['maximized', 'maximized'],
    ['drawer', 'drawer'],
    ['withdrawn', 'withdrawn'],
  ])('losing room: %s → %s', (from, to) => {
    expect(reducePanel(withTabs(from), context, narrow()).state.presentation).toBe(to);
  });

  it.each<[Presentation, Presentation]>([
    ['closed', 'closed'],
    ['beside', 'beside'],
    ['maximized', 'maximized'],
    ['drawer', 'beside'],
    ['withdrawn', 'beside'],
  ])('gaining room: %s → %s', (from, to) => {
    expect(reducePanel(withTabs(from), context, ctx()).state.presentation).toBe(to);
  });

  it('closes an open panel without tabs that loses room (물러남 needs a tab)', () => {
    expect(
      reducePanel(panel({ presentation: 'beside' }), context, narrow()).state.presentation,
    ).toBe('closed');
  });

  it.each(ROWS)(
    '주소대로 for an address with panel (outside, OS notification): %s, room %s',
    (from, room) => {
      const { state } = reducePanel(
        withTabs(from),
        { type: 'follow', search: runTwo, source: 'outside' },
        ctx({ room }),
      );
      expect(state.presentation).toBe(room ? 'beside' : 'withdrawn');
      expect(state.selected).toBe('run:run_2');
    },
  );

  it.each(ROWS)('주소대로 for compose: %s, room %s → 닫힘', (from, room) => {
    const { state } = reducePanel(
      withTabs(from),
      { type: 'follow', search: { compose: true }, source: 'outside' },
      ctx({ room }),
    );
    expect(state.presentation).toBe('closed');
    expect(ids(state)).toEqual([files, run('run_1')]);
  });

  it.each(ROWS)(
    '주소대로 on entry (reload, app open, OS notification, outside address): %s, room %s',
    (from, room) => {
      // The address and memory this state leaves behind, entered again.
      const row = withTabs(from);
      const reloaded = reducePanel(
        EMPTY_PANEL,
        enter(panelAddress(row), rememberedPanel(row), 'address'),
        ctx({ room }),
      ).state;
      expect(reloaded.presentation).toBe(
        from === 'closed' ? 'closed' : room ? 'beside' : 'withdrawn',
      );
      expect(ids(reloaded)).toEqual([files, run('run_1')]);
      expect(reloaded.selected).toBe('run:run_1');
      const restored = reducePanel(
        EMPTY_PANEL,
        enter({}, rememberedPanel(row), 'address'),
        ctx({ room }),
      ).state;
      expect(shape(restored)).toEqual(shape(reloaded));
    },
  );

  it.each<[Presentation, boolean, Presentation]>([
    ['closed', true, 'beside'],
    ['closed', false, 'withdrawn'],
    ['beside', true, 'beside'],
    ['maximized', true, 'maximized'],
    ['maximized', false, 'maximized'],
    ['drawer', false, 'drawer'],
    ['withdrawn', false, 'withdrawn'],
  ])(
    'Back/Forward to an address with panel: %s (room %s) → %s, selection follows',
    (from, room, to) => {
      const { state } = reducePanel(
        withTabs(from),
        { type: 'history', search: runTwo },
        ctx({ room }),
      );
      expect(state.presentation).toBe(to);
      expect(state.selected).toBe('run:run_2');
    },
  );

  it.each(ROWS)('Back/Forward to compose: %s, room %s → 닫힘', (from, room) => {
    const { state } = reducePanel(
      withTabs(from),
      { type: 'history', search: { compose: true } },
      ctx({ room }),
    );
    expect(state.presentation).toBe('closed');
    expect(ids(state)).toEqual([files, run('run_1')]);
  });

  it.each<[Presentation, boolean, Presentation]>([
    ['closed', true, 'beside'],
    ['closed', false, 'drawer'],
    ['beside', true, 'beside'],
    ['maximized', true, 'maximized'],
    ['maximized', false, 'maximized'],
    ['drawer', false, 'drawer'],
    ['withdrawn', false, 'drawer'],
  ])(
    'an opening action on this screen or an in-app link with panel: %s (room %s) → %s',
    (from, room, to) => {
      const action = reducePanel(withTabs(from), runLink('run_2'), ctx({ room })).state;
      expect(action.presentation).toBe(to);
      expect(action.selected).toBe('run:run_2');
      const link = reducePanel(
        withTabs(from),
        { type: 'follow', search: runTwo, source: 'in-app' },
        ctx({ room }),
      ).state;
      expect(shape(link)).toEqual(shape(action));
    },
  );

  it('never restores 넓힘 or 서랍 on entry', () => {
    for (const via of ['link', 'address', 'history'] as const) {
      for (const room of [true, false]) {
        const { state } = reducePanel(
          withTabs('maximized'),
          enter({}, { tabs: [files], selected: 'files', open: true }, via),
          ctx({ room }),
        );
        expect(['maximized', 'drawer']).not.toContain(state.presentation);
      }
    }
  });
});

describe('entering a conversation', () => {
  it('restores memory for an address with neither and rewrites it, adding no entry', () => {
    const result = reducePanel(EMPTY_PANEL, enter({}, memoryOf), ctx());
    expect(shape(result.state)).toEqual({
      tabs: [files, run('run_1')],
      selected: 'run:run_1',
      presentation: 'beside',
    });
    expect(result.address).toEqual({ panel: 'run', run: 'run_1' });
    expect(result.history).toBe('replace');
  });

  it('takes the tabs and order from memory and the selection from an address with panel', () => {
    const { state } = reducePanel(
      EMPTY_PANEL,
      enter({ panel: 'files' }, memoryOf, 'address'),
      ctx(),
    );
    expect(ids(state)).toEqual([files, run('run_1')]);
    expect(state.selected).toBe('files');
  });

  it('opens the tab the address names when memory does not have it, at the right end', () => {
    const { state } = reducePanel(EMPTY_PANEL, enter({ panel: 'git' }, memoryOf, 'address'), ctx());
    expect(ids(state)).toEqual([files, run('run_1'), changes]);
    expect(state.selected).toBe('changes');
  });

  it('opens a drawer on entry only for an in-app link with panel and no room', () => {
    const entered = (via: 'link' | 'address' | 'history') =>
      reducePanel(EMPTY_PANEL, enter(runTwo, memoryOf, via), narrow()).state.presentation;
    expect(entered('link')).toBe('drawer');
    expect(entered('address')).toBe('withdrawn');
    expect(entered('history')).toBe('withdrawn');
  });

  it('does not restore on Back or Forward into an address with neither', () => {
    const { state, address } = reducePanel(EMPTY_PANEL, enter({}, memoryOf, 'history'), ctx());
    expect(state.presentation).toBe('closed');
    expect(ids(state)).toEqual([files, run('run_1')]);
    expect(address).toEqual({ compose: true });
  });

  it('starts empty and closed without memory and inherits nothing from the previous state', () => {
    const { state } = reducePanel(withTabs('maximized'), enter({}, null), ctx());
    expect(shape(state)).toEqual(EMPTY);
    expect(state.awaiting).toBeNull();
  });

  it('restores an open panel without tabs as closed', () => {
    const { state, address } = reducePanel(
      EMPTY_PANEL,
      enter({}, { tabs: [], selected: null, open: true }),
      ctx(),
    );
    expect(shape(state)).toEqual(EMPTY);
    expect(address).toEqual({ compose: true });
  });

  it('with a message address without panel, restores first and then brings the conversation forward', () => {
    const result = reducePanel(EMPTY_PANEL, enter({ message: 'msg_1' }, memoryOf), narrow());
    expect(result.state.presentation).toBe('withdrawn');
    expect(result.state.selected).toBe('run:run_1');
    expect(result.bringForward).toBe(true);
  });

  it('with a message address that has panel, lets panel pick the tab as for any panel address', () => {
    const result = reducePanel(
      EMPTY_PANEL,
      enter({ panel: 'files', message: 'msg_1' }, memoryOf),
      narrow(),
    );
    expect(result.state.presentation).toBe('drawer');
    expect(result.state.selected).toBe('files');
    expect(result.bringForward).toBe(false);
  });

  it('asks the conversation forward for respond and advice entries', () => {
    expect(
      reducePanel(EMPTY_PANEL, enter({ panel: 'run', run: 'run_2', respond: true }, null), ctx())
        .bringForward,
    ).toBe(true);
    expect(reducePanel(EMPTY_PANEL, enter({ advice: 'run_2' }, null), ctx()).bringForward).toBe(
      true,
    );
    expect(reducePanel(EMPTY_PANEL, enter({}, null), ctx()).bringForward).toBe(false);
  });
});

describe('entering with panel=run before the run list is known', () => {
  const memory = { tabs: [files], selected: 'files' as const, open: true };

  it('stays 닫힘 with the restored tabs and writes nothing, so the address keeps panel=run', () => {
    const result = reducePanel(EMPTY_PANEL, enter({ panel: 'run' }, memory), unlisted());
    expect(shape(result.state)).toEqual({
      tabs: [files],
      selected: 'files',
      presentation: 'closed',
    });
    expect(result.history).toBeNull();
  });

  it('opens the newest run’s tab with the opening column once the list answers (an in-app link)', () => {
    const waiting = reducePanel(EMPTY_PANEL, enter({ panel: 'run' }, memory), unlisted()).state;
    const result = reducePanel(waiting, context, narrow());
    expect(ids(result.state)).toEqual([files, run('run_2')]);
    expect(result.state.selected).toBe('run:run_2');
    expect(result.state.presentation).toBe('drawer');
    expect(result.address).toEqual({ panel: 'run', run: 'run_2' });
    expect(result.history).toBe('replace');
  });

  it('opens it 주소대로 for an address entry (reload, outside, Back)', () => {
    for (const via of ['address', 'history'] as const) {
      const waiting = reducePanel(
        EMPTY_PANEL,
        enter({ panel: 'run' }, memory, via),
        unlisted({ room: false }),
      ).state;
      expect(reducePanel(waiting, context, narrow()).state.presentation).toBe('withdrawn');
    }
  });

  it('stays 닫힘 and writes compose when the list shows no run', () => {
    const waiting = reducePanel(EMPTY_PANEL, enter({ panel: 'run' }, memory), unlisted()).state;
    const result = reducePanel(waiting, context, ctx({ runIds: [] }));
    expect(shape(result.state)).toEqual({
      tabs: [files],
      selected: 'files',
      presentation: 'closed',
    });
    expect(result.address).toEqual({ compose: true });
    expect(result.history).toBe('replace');
  });

  it.each<[string, PanelEvent]>([
    ['choosing a tab', { type: 'select', key: 'files' }],
    ['the toggle', { type: 'toggle' }],
    ['an opening way', way({ panel: 'changes' })],
    ['Back to compose', { type: 'history', search: { compose: true } }],
    ['a followed link', { type: 'follow', search: { panel: 'files' }, source: 'in-app' }],
  ])('drops the request when the user touched the panel first (%s, late)', (_name, step) => {
    const waiting = reducePanel(EMPTY_PANEL, enter({ panel: 'run' }, memory), unlisted()).state;
    const touched = reducePanel(waiting, step, unlisted()).state;
    const answered = reducePanel(touched, context, ctx()).state;
    expect(ids(answered)).not.toContainEqual(run('run_2'));
    expect(shape(answered)).toEqual(shape(touched));
  });

  it('answers at once when the list is already known on entry', () => {
    const result = reducePanel(EMPTY_PANEL, enter({ panel: 'run' }, memory, 'address'), ctx());
    expect(result.state.selected).toBe('run:run_2');
    expect(result.state.presentation).toBe('beside');
    expect(result.history).toBe('replace');
  });

  it('closes and writes compose on entry when the list is known and has no run', () => {
    const result = reducePanel(
      EMPTY_PANEL,
      enter({ panel: 'run' }, memory, 'address'),
      ctx({ runIds: [] }),
    );
    expect(shape(result.state)).toEqual({
      tabs: [files],
      selected: 'files',
      presentation: 'closed',
    });
    expect(result.address).toEqual({ compose: true });
  });
});

describe('following an address inside the conversation', () => {
  it('leaves the panel alone for a bare link (nothing is restored)', () => {
    const before = withTabs('beside');
    const result = reducePanel(before, { type: 'follow', search: {}, source: 'in-app' }, ctx());
    expect(result.state).toBe(before);
    expect(result.address).toEqual({ panel: 'run', run: 'run_1' });
    expect(result.history).toBe('replace');
    expect(result.bringForward).toBe(false);
  });

  it.each<[Presentation, boolean, Presentation]>([
    ['closed', true, 'closed'],
    ['beside', true, 'beside'],
    ['withdrawn', false, 'withdrawn'],
    ['maximized', true, 'beside'],
    ['maximized', false, 'withdrawn'],
    ['drawer', false, 'closed'],
  ])(
    'brings the conversation forward for respond, advice and message links: %s (room %s) → %s',
    (from, room, to) => {
      for (const search of [
        { panel: 'run', run: 'run_2', respond: true },
        { advice: 'run_2' },
        { message: 'msg_1' },
      ] satisfies SessionSearch[]) {
        const result = reducePanel(
          withTabs(from),
          { type: 'follow', search, source: 'in-app' },
          ctx({ room }),
        );
        expect(result.state.presentation).toBe(to);
        expect(ids(result.state)).toEqual([files, run('run_1')]);
        expect(result.state.selected).toBe('run:run_1');
        expect(result.address).toEqual(
          to === 'closed' ? { compose: true } : { panel: 'run', run: 'run_1' },
        );
        expect(result.history).toBe('replace');
        expect(result.bringForward).toBe(true);
      }
    },
  );

  it('lets panel pick the tab for a message link with panel, without bringing the conversation forward', () => {
    const result = reducePanel(
      withTabs('maximized'),
      { type: 'follow', search: { panel: 'files', message: 'msg_1' }, source: 'in-app' },
      ctx(),
    );
    expect(result.state.presentation).toBe('maximized');
    expect(result.state.selected).toBe('files');
    expect(result.bringForward).toBe(false);
  });

  it('leaves the panel exactly as it is for panel=run in a conversation without runs', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const result = reducePanel(
      before,
      { type: 'follow', search: { panel: 'run' }, source: 'in-app' },
      ctx({ runIds: [] }),
    );
    expect(result.state).toBe(before);
    expect(result.address).toEqual({ panel: 'files' });
  });

  it('changes nothing for a bare panel=run while the run list is not known', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const result = reducePanel(
      before,
      { type: 'follow', search: { panel: 'run' }, source: 'in-app' },
      unlisted(),
    );
    expect(result.state).toBe(before);
  });
});

describe('Back and Forward', () => {
  it('keeps the tabs: a closed tab the address names reopens at the right end', () => {
    const { state } = reducePanel(
      panel({ tabs: [files, changes], selected: 'files', presentation: 'beside' }),
      { type: 'history', search: runTwo },
      ctx(),
    );
    expect(ids(state)).toEqual([files, changes, run('run_2')]);
    expect(state.selected).toBe('run:run_2');
  });

  it('changes nothing for an address with neither', () => {
    const before = withTabs('beside');
    expect(reducePanel(before, { type: 'history', search: {} }, ctx()).state).toBe(before);
  });

  it('leaves the panel exactly as it is for panel=run without runs or before the list is known', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const back: PanelEvent = { type: 'history', search: { panel: 'run' } };
    expect(reducePanel(before, back, ctx({ runIds: [] })).state).toBe(before);
    expect(reducePanel(before, back, unlisted()).state).toBe(before);
  });

  it('never brings the conversation forward', () => {
    expect(
      reducePanel(withTabs('maximized'), { type: 'history', search: { message: 'msg_1' } }, ctx())
        .bringForward,
    ).toBe(false);
  });
});

describe('what adds a history entry', () => {
  const cases: [string, PanelState, PanelEvent, PanelContext, 'push' | 'replace' | null][] = [
    ['an opening way', withTabs('beside'), way({ panel: 'changes' }), ctx(), 'push'],
    [
      'an opening way to the tab already selected',
      withTabs('beside'),
      runLink('run_1'),
      ctx(),
      'push',
    ],
    [
      'the "+" list',
      withTabs('beside'),
      { type: 'open', target: { panel: 'changes' }, from: 'plus' },
      ctx(),
      'replace',
    ],
    [
      'choosing in the strip',
      withTabs('beside'),
      { type: 'select', key: 'files' },
      ctx(),
      'replace',
    ],
    ['closing in the strip', withTabs('beside'), { type: 'close', key: 'files' }, ctx(), 'replace'],
    ['the toggle', withTabs('beside'), { type: 'toggle' }, ctx(), 'replace'],
    [
      'Escape or the dimmed conversation',
      withTabs('drawer'),
      { type: 'closeDrawer' },
      narrow(),
      'replace',
    ],
    [
      'bringing the conversation forward from the drawer',
      withTabs('drawer'),
      { type: 'bringForward' },
      narrow(),
      'replace',
    ],
    ['entering', EMPTY_PANEL, enter({}, null), ctx(), 'replace'],
    [
      'a followed link (the router already added it)',
      withTabs('beside'),
      { type: 'follow', search: runTwo, source: 'in-app' },
      ctx(),
      'replace',
    ],
    ['Back or Forward', withTabs('beside'), { type: 'history', search: runTwo }, ctx(), 'replace'],
    [
      'a change that changes nothing',
      withTabs('beside'),
      { type: 'select', key: 'run:run_1' },
      ctx(),
      null,
    ],
    ['the context changing nothing', withTabs('beside'), context, ctx(), null],
  ];
  it.each(cases)('%s', (_name, state, event, c, history) => {
    expect(reducePanel(state, event, c).history).toBe(history);
  });

  it('writes compose when an open panel loses its last tab', () => {
    const { address } = reducePanel(
      panel({ tabs: [files], selected: 'files', presentation: 'beside' }),
      { type: 'close', key: 'files' },
      ctx(),
    );
    expect(address).toEqual({ compose: true });
  });

  it('writes the window an opening way named', () => {
    expect(reducePanel(EMPTY_PANEL, way({ panel: 'terminal' }), ctx()).address).toEqual({
      panel: 'terminal',
    });
  });

  it.each<[string, PanelEvent, PanelContext]>([
    ['losing room', context, narrow({ front: { files: 'terminal' } })],
    [
      'bringing the conversation forward from 넓힘',
      { type: 'bringForward' },
      ctx({ front: { files: 'terminal' } }),
    ],
    [
      'a followed respond link',
      { type: 'follow', search: { panel: 'run', run: 'run_1', respond: true }, source: 'in-app' },
      ctx({ front: { files: 'terminal' } }),
    ],
  ])('keeps the window in front of 파일 in the address on %s', (_name, event, c) => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'maximized' });
    expect(reducePanel(before, event, c).address).toEqual({ panel: 'terminal' });
  });

  it('writes each tab’s own window in front when it is chosen', () => {
    const before = panel({ tabs: [files, changes], selected: 'files', presentation: 'beside' });
    const fronts = ctx({ front: { files: 'terminal', changes: 'git' } });
    expect(reducePanel(before, { type: 'select', key: 'changes' }, fronts).address).toEqual({
      panel: 'git',
    });
    const plain = ctx({ front: { files: 'terminal' } });
    expect(reducePanel(before, { type: 'select', key: 'changes' }, plain).address).toEqual({
      panel: 'changes',
    });
  });

  it('closes the panel on Back to compose even after the panel was open with no tabs', () => {
    // The frame never dispatches its own write-back; an open empty panel writes compose and a
    // later Back to compose still closes it.
    const empty = reducePanel(EMPTY_PANEL, { type: 'toggle' }, ctx());
    expect(empty.address).toEqual({ compose: true });
    expect(empty.state.presentation).toBe('beside');
    expect(
      reducePanel(empty.state, { type: 'history', search: { compose: true } }, ctx()).state
        .presentation,
    ).toBe('closed');
  });
});

describe('the run list answering', () => {
  const restoredNine = () =>
    reducePanel(
      EMPTY_PANEL,
      enter({}, { tabs: [files, run('run_9')], selected: 'run:run_9', open: true }),
      unlisted(),
    ).state;

  it('keeps restored run tabs until it answers', () => {
    expect(ids(restoredNine())).toEqual([files, run('run_9')]);
  });

  it('drops a restored run tab whose run is not listed and selects the first remaining tab', () => {
    const { state, history, address } = reducePanel(restoredNine(), context, ctx());
    expect(ids(state)).toEqual([files]);
    expect(state.selected).toBe('files');
    expect(state.presentation).toBe('beside');
    expect(history).toBe('replace');
    expect(address).toEqual({ panel: 'files' });
  });

  it('cleans up on entry when the list already answered before it', () => {
    const { state, history } = reducePanel(
      EMPTY_PANEL,
      enter({}, { tabs: [files, run('run_9')], selected: 'run:run_9', open: true }),
      ctx(),
    );
    expect(ids(state)).toEqual([files]);
    expect(state.selected).toBe('files');
    expect(history).toBe('replace');
  });

  it('closes the panel when no tab remains', () => {
    const restored = reducePanel(
      EMPTY_PANEL,
      enter({}, { tabs: [run('run_9')], selected: 'run:run_9', open: true }),
      unlisted(),
    ).state;
    expect(shape(reducePanel(restored, context, ctx()).state)).toEqual(EMPTY);
  });

  it('keeps everything while the list is not known, an unreadable one included (failure)', () => {
    const before = restoredNine();
    const unread = reducePanel(before, context, unlisted());
    expect(unread.state).toBe(before);
    expect(unread.history).toBeNull();
    expect(ids(reducePanel(unread.state, context, ctx()).state)).toEqual([files]);
  });

  it('answers once: a later answer changes nothing (duplicate)', () => {
    const once = reducePanel(restoredNine(), context, ctx()).state;
    const twice = reducePanel(once, context, ctx({ runIds: ['run_1'] }));
    expect(twice.state).toBe(once);
    expect(twice.history).toBeNull();
  });

  it('never opens a tab for a run the list adds (a run that started)', () => {
    const before = withTabs('beside');
    expect(reducePanel(before, context, ctx({ runIds: ['run_1', 'run_2', 'run_3'] })).state).toBe(
      before,
    );
  });

  it('leaves a tab the user already closed alone and keeps their selection (late)', () => {
    const chosen = steps(restoredNine(), [{ type: 'select', key: 'files' }], unlisted()).state;
    const answered = reducePanel(chosen, context, ctx()).state;
    expect(ids(answered)).toEqual([files]);
    expect(answered.selected).toBe('files');
    const closed = steps(
      restoredNine(),
      [
        { type: 'close', key: 'run:run_9' },
        { type: 'open', target: { panel: 'changes' }, from: 'plus' },
      ],
      unlisted(),
    ).state;
    const after = reducePanel(closed, context, ctx()).state;
    expect(ids(after)).toEqual([files, changes]);
    expect(after.selected).toBe('changes');
  });

  it('leaves an open empty panel open when the user closed every tab before it answered (late)', () => {
    const emptied = steps(
      restoredNine(),
      [
        { type: 'close', key: 'files' },
        { type: 'close', key: 'run:run_9' },
      ],
      unlisted(),
    ).state;
    expect(shape(reducePanel(emptied, context, ctx()).state)).toEqual({
      ...EMPTY,
      presentation: 'beside',
    });
  });

  it('does not touch run tabs the user opened after entering', () => {
    const opened = steps(restoredNine(), [runLink('run_3')], unlisted()).state;
    const { state } = reducePanel(opened, context, ctx());
    expect(ids(state)).toEqual([files, run('run_3')]);
    expect(state.selected).toBe('run:run_3');
  });

  const unknownAddress = (memoryTabs: readonly PanelTab[] = []) =>
    reducePanel(
      EMPTY_PANEL,
      enter(
        { panel: 'run', run: 'run_x' },
        memoryTabs.length ? { tabs: memoryTabs, selected: 'files', open: true } : null,
        'address',
      ),
      unlisted(),
    ).state;

  it('keeps the address’s run until it answers', () => {
    const state = unknownAddress();
    expect(ids(state)).toEqual([run('run_x')]);
    expect(state.selected).toBe('run:run_x');
  });

  it('replaces the address’s unknown run with the newest run and rewrites the address', () => {
    const { state, address, history } = reducePanel(unknownAddress([files]), context, ctx());
    expect(ids(state)).toEqual([files, run('run_2')]);
    expect(state.selected).toBe('run:run_2');
    expect(address).toEqual({ panel: 'run', run: 'run_2' });
    expect(history).toBe('replace');
  });

  it('selects the newest run’s tab when it is already open instead of opening another', () => {
    const { state } = reducePanel(unknownAddress([files, run('run_2')]), context, ctx());
    expect(ids(state)).toEqual([files, run('run_2')]);
    expect(state.selected).toBe('run:run_2');
  });

  it('closes the panel when the list shows the conversation has no run', () => {
    const { state, address } = reducePanel(unknownAddress([files]), context, ctx({ runIds: [] }));
    expect(ids(state)).toEqual([files]);
    expect(state.presentation).toBe('closed');
    expect(address).toEqual({ compose: true });
  });

  it('does not move the selection to the newest run when the user already chose another tab (late)', () => {
    const chosen = steps(
      unknownAddress([files]),
      [{ type: 'select', key: 'files' }],
      unlisted(),
    ).state;
    const { state, address } = reducePanel(chosen, context, ctx());
    expect(ids(state)).toEqual([files]);
    expect(state.selected).toBe('files');
    expect(address).toEqual({ panel: 'files' });
  });
});

describe('nothing changes by itself', () => {
  it('changes nothing when the same event comes twice (duplicate)', () => {
    for (const event of [
      { type: 'select', key: 'files' },
      context,
      { type: 'closeDrawer' },
      { type: 'bringForward' },
      { type: 'history', search: runTwo },
      { type: 'follow', search: runTwo, source: 'in-app' },
    ] satisfies PanelEvent[]) {
      const once = reducePanel(withTabs('drawer'), event, narrow()).state;
      expect(reducePanel(once, event, narrow()).state).toBe(once);
    }
  });
});

describe('dropping a confirmation the run tab head asked', () => {
  it('tells the frame when the head loses its controls, and not otherwise', () => {
    const head = withTabs('maximized');
    expect(reducePanel(head, { type: 'select', key: 'files' }, ctx()).dropHeadConfirmation).toBe(
      true,
    );
    expect(
      reducePanel(head, { type: 'history', search: { panel: 'run', run: 'run_1' } }, ctx())
        .dropHeadConfirmation,
    ).toBe(false);
    expect(
      reducePanel(withTabs('beside'), { type: 'select', key: 'files' }, ctx()).dropHeadConfirmation,
    ).toBe(false);
  });

  it('drops it on entering another conversation, even one that opens on a run tab head', () => {
    const elsewhere = reducePanel(
      withTabs('drawer'),
      enter({ panel: 'run', run: 'run_1' }, null),
      narrow(),
    );
    expect(elsewhere.state.presentation).toBe('drawer');
    expect(elsewhere.dropHeadConfirmation).toBe(true);
    expect(reducePanel(withTabs('beside'), enter({}, null), ctx()).dropHeadConfirmation).toBe(
      false,
    );
  });
});

describe('what the frame shows', () => {
  it.each<[Presentation, boolean]>([
    ['closed', true],
    ['beside', true],
    ['withdrawn', true],
    ['maximized', false],
    ['drawer', false],
  ])('the conversation can be operated in %s: %s', (presentation, operable) => {
    expect(conversationOperable(presentation)).toBe(operable);
  });
});
