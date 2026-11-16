import type { RunStatus } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import {
  context,
  ctx,
  enter,
  files,
  narrow,
  panel,
  run,
  runLink,
  statuses,
  way,
} from './fixtures.ts';
import { type PanelEvent, type PanelState, type Presentation, reducePanel } from './model.ts';
import {
  headLosesControls,
  receiptsOnlyHead,
  runControlPlace,
  runTabHeadRun,
  stopCommandRoute,
} from './runControls.ts';
import type { PanelContext } from './tabs.ts';

const at = (presentation: Presentation, selected: PanelState['selected'] = 'run:run_1') =>
  panel({ tabs: [files, run('run_1'), run('run_2')], selected, presentation });
const running = statuses({ run_1: 'running', run_2: 'running' });

describe('where run controls stand', () => {
  it.each<Presentation>(['closed', 'beside', 'withdrawn'])(
    'stand in the composer while the conversation can be operated (%s), even with that run’s tab selected',
    (presentation) => {
      expect(runControlPlace(at(presentation), running)).toEqual({ at: 'composer' });
      expect(runTabHeadRun(at(presentation))).toBeNull();
    },
  );

  it.each<Presentation>(['maximized', 'drawer'])(
    'stand on the selected run tab’s head for its run in %s',
    (presentation) => {
      expect(runControlPlace(at(presentation), running)).toEqual({ at: 'run-tab', runId: 'run_1' });
      expect(runTabHeadRun(at(presentation))).toBe('run_1');
    },
  );

  it.each<RunStatus>(['succeeded', 'failed', 'cancelled', 'interrupted'])(
    'stand nowhere on a %s run’s head',
    (status) => {
      expect(runControlPlace(at('maximized'), statuses({ run_1: status }))).toEqual({
        at: 'nowhere',
      });
    },
  );

  it('stand nowhere in 넓힘 or 서랍 with another tab selected or a run not read yet', () => {
    expect(runControlPlace(at('maximized', 'files'), running)).toEqual({ at: 'nowhere' });
    expect(runControlPlace(at('drawer', 'files'), running)).toEqual({ at: 'nowhere' });
    expect(runControlPlace(at('maximized'), statuses({}))).toEqual({ at: 'nowhere' });
  });
});

describe('a finished run’s head keeping its receipts', () => {
  const finished = statuses({ run_1: 'succeeded', run_2: 'running' });

  it.each<Presentation>(['beside', 'maximized', 'drawer'])(
    'shows only its receipts while the panel is on screen (%s)',
    (presentation) => {
      expect(receiptsOnlyHead(at(presentation), finished)).toBe('run_1');
    },
  );

  it.each<Presentation>(['closed', 'withdrawn'])(
    'shows nothing off screen (%s)',
    (presentation) => {
      expect(receiptsOnlyHead(at(presentation), finished)).toBeNull();
    },
  );

  it('is not a running run’s head, another tab, or a run not read yet', () => {
    expect(receiptsOnlyHead(at('beside', 'run:run_2'), finished)).toBeNull();
    expect(receiptsOnlyHead(at('beside', 'files'), finished)).toBeNull();
    expect(receiptsOnlyHead(at('beside'), statuses({}))).toBeNull();
  });
});

describe('the stop command', () => {
  it('has nothing to stop without a run in progress', () => {
    expect(stopCommandRoute(at('beside'), running, null)).toBeNull();
  });

  it('acts as the composer’s Stop while the conversation can be operated', () => {
    for (const presentation of ['closed', 'beside', 'withdrawn'] as const) {
      expect(stopCommandRoute(at(presentation), running, 'run_2')).toEqual({
        at: 'composer',
        bringForward: false,
      });
    }
  });

  it('acts as the head’s Stop when that head carries the controls of the run in progress', () => {
    expect(stopCommandRoute(at('maximized'), running, 'run_1')).toEqual({
      at: 'run-tab',
      runId: 'run_1',
    });
    expect(stopCommandRoute(at('drawer'), running, 'run_1')).toEqual({
      at: 'run-tab',
      runId: 'run_1',
    });
  });

  it('brings the conversation forward otherwise and acts as the composer’s Stop', () => {
    const forward = { at: 'composer', bringForward: true };
    expect(stopCommandRoute(at('maximized', 'files'), running, 'run_1')).toEqual(forward);
    expect(stopCommandRoute(at('drawer', 'run:run_2'), running, 'run_1')).toEqual(forward);
    expect(stopCommandRoute(at('maximized'), statuses({}), 'run_1')).toEqual(forward);
    expect(stopCommandRoute(at('maximized'), statuses({ run_1: 'succeeded' }), 'run_2')).toEqual(
      forward,
    );
  });
});

describe('the run tab head losing the controls (cancellation boundary)', () => {
  const step = (state: PanelState, event: PanelEvent, c: PanelContext) =>
    headLosesControls(state, reducePanel(state, event, c).state);

  it.each<[string, PanelState, PanelEvent, PanelContext]>([
    ['releasing maximize', at('maximized'), { type: 'maximize' }, ctx()],
    ['the drawer closing by Escape', at('drawer'), { type: 'closeDrawer' }, narrow()],
    ['the drawer closing by the toggle', at('drawer'), { type: 'toggle' }, narrow()],
    [
      'the drawer closing as the conversation comes forward',
      at('drawer'),
      { type: 'bringForward' },
      narrow(),
    ],
    ['the drawer becoming 옆 as room appears', at('drawer'), context, ctx()],
    ['choosing another tab in 넓힘', at('maximized'), { type: 'select', key: 'files' }, ctx()],
    [
      'choosing another run’s tab in 서랍',
      at('drawer'),
      { type: 'select', key: 'run:run_2' },
      narrow(),
    ],
    ['closing that tab', at('maximized'), { type: 'close', key: 'run:run_1' }, ctx()],
    ['an opening way selecting another tab', at('maximized'), way({ panel: 'changes' }), ctx()],
    [
      'Back selecting another tab',
      at('maximized'),
      { type: 'history', search: { panel: 'files' } },
      ctx(),
    ],
    [
      'Back closing the panel',
      at('maximized'),
      { type: 'history', search: { compose: true } },
      ctx(),
    ],
    ['going to another conversation', at('maximized'), enter({}, null), ctx()],
  ])('loses them on %s', (_name, state, event, c) => {
    expect(step(state, event, c)).toBe(true);
  });

  it.each<[string, PanelState, PanelEvent, PanelContext]>([
    [
      'Back or Forward keeping the same tab selected',
      at('maximized'),
      { type: 'history', search: { panel: 'run', run: 'run_1' } },
      ctx(),
    ],
    ['losing room while 넓힘', at('maximized'), context, narrow()],
    ['the context changing while 서랍', at('drawer'), context, narrow()],
    ['an opening way to the same run’s tab', at('maximized'), runLink('run_1'), ctx()],
    [
      'choosing the tab already selected',
      at('drawer'),
      { type: 'select', key: 'run:run_1' },
      narrow(),
    ],
    ['closing another tab', at('maximized'), { type: 'close', key: 'files' }, ctx()],
    [
      'the run list answering',
      at('maximized'),
      context,
      ctx({ runIds: ['run_1', 'run_2', 'run_3'] }),
    ],
  ])('keeps them on %s', (_name, state, event, c) => {
    expect(step(state, event, c)).toBe(false);
  });

  it.each<[Presentation, boolean]>([
    ['closed', true],
    ['beside', true],
    ['withdrawn', false],
  ])('has nothing to lose while the composer holds them (%s)', (presentation, room) => {
    for (const event of [
      { type: 'history', search: { compose: true } },
      { type: 'select', key: 'files' },
      { type: 'toggle' },
    ] satisfies PanelEvent[]) {
      expect(step(at(presentation), event, ctx({ room }))).toBe(false);
    }
  });
});
