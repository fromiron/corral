import { describe, expect, it } from 'vitest';
import { type SessionSearch, validateSessionSearch } from '../panels/routes.ts';
import {
  FRAME_PARAMS,
  nextSearch,
  panelAddress,
  readAddress,
  withoutFrameParams,
} from './address.ts';
import { context, ctx, enter, files, panel, run, unlisted } from './fixtures.ts';
import {
  EMPTY_PANEL,
  type PanelEvent,
  type PanelState,
  type Presentation,
  reducePanel,
} from './model.ts';

const read = (search: Record<string, unknown>) => readAddress(validateSessionSearch(search));

describe('reading the session address (주소와 기억)', () => {
  it('reads panel as an open panel with that tab selected', () => {
    expect(read({ panel: 'files' })).toEqual({
      kind: 'panel',
      target: { panel: 'files' },
      bringForward: false,
    });
    expect(read({ panel: 'run', run: 'run_1', view: 'results' })).toEqual({
      kind: 'panel',
      target: { panel: 'run', run: 'run_1' },
      bringForward: false,
    });
    expect(read({ panel: 'terminal', terminal: 'term_1' })).toEqual({
      kind: 'panel',
      target: { panel: 'terminal', terminal: 'term_1' },
      bringForward: false,
    });
  });

  it('reads compose as a closed panel', () => {
    expect(read({ compose: true })).toEqual({ kind: 'compose', bringForward: false });
  });

  it('follows panel when both panel and compose are present', () => {
    expect(readAddress({ panel: 'changes', compose: true })).toEqual({
      kind: 'panel',
      target: { panel: 'changes' },
      bringForward: false,
    });
  });

  it('reads an address with neither as neither, whatever else it carries', () => {
    expect(read({})).toEqual({ kind: 'neither', bringForward: false });
    expect(read({ advice: 'run_1' })).toEqual({ kind: 'neither', bringForward: true });
  });

  it('reads going to a message without panel as bringing the conversation forward', () => {
    expect(read({ message: 'msg_1' })).toEqual({ kind: 'neither', bringForward: true });
    expect(read({ compose: true, message: 'msg_1' })).toEqual({
      kind: 'compose',
      bringForward: true,
    });
    // With panel it is a panel address: panel picks the tab, the conversation is only placed.
    expect(read({ panel: 'files', message: 'msg_1' })).toEqual({
      kind: 'panel',
      target: { panel: 'files' },
      bringForward: false,
    });
  });

  it('counts respond as neither even when it carries panel=run', () => {
    expect(read({ panel: 'run', run: 'run_2', respond: true })).toEqual({
      kind: 'neither',
      bringForward: true,
    });
  });

  it('lists the frame parameters the spec names, and no others', () => {
    expect([...FRAME_PARAMS].sort()).toEqual(
      [
        'panel',
        'run',
        'view',
        'result',
        'execution',
        'artifact',
        'atSeq',
        'terminal',
        'review',
        'scope',
        'runId',
        'file',
        'message',
        'respond',
        'advice',
        'compose',
      ].sort(),
    );
  });

  it('drops the frame parameters and leaves the ones it does not read', () => {
    expect(
      withoutFrameParams({ panel: 'run', run: 'run_1', respond: true, settings: 'models' }),
    ).toEqual({ settings: 'models' });
  });
});

const state = (presentation: Presentation, over: Parameters<typeof panel>[0] = {}): PanelState =>
  panel({ tabs: [files, run('run_1')], selected: 'run:run_1', presentation, ...over });

describe('the frame’s part of the address', () => {
  it.each<Presentation>(['beside', 'maximized', 'drawer', 'withdrawn'])(
    'writes the selected tab’s panel while the panel is open (%s)',
    (presentation) => {
      expect(panelAddress(state(presentation))).toEqual({ panel: 'run', run: 'run_1' });
    },
  );

  it('writes compose when the panel is closed, the tabs kept', () => {
    expect(panelAddress(state('closed'))).toEqual({ compose: true });
  });

  it('writes compose for an open panel with no tabs', () => {
    expect(panelAddress({ ...EMPTY_PANEL, presentation: 'beside' })).toEqual({ compose: true });
    expect(panelAddress({ ...EMPTY_PANEL, presentation: 'drawer' })).toEqual({ compose: true });
  });

  it('writes the window or view in front of 파일 or 변경 only for the selected tab', () => {
    const onFiles = state('beside', { selected: 'files' });
    expect(panelAddress(onFiles)).toEqual({ panel: 'files' });
    expect(panelAddress(onFiles, { files: 'tools' })).toEqual({ panel: 'tools' });
    expect(panelAddress(onFiles, { changes: 'git' })).toEqual({ panel: 'files' });
    expect(panelAddress(state('beside'), { files: 'tools' })).toEqual({
      panel: 'run',
      run: 'run_1',
    });
  });
});

describe('the whole search the frame writes', () => {
  const settings = { settings: 'models' } as unknown as SessionSearch;
  const write = (
    current: SessionSearch,
    before: PanelState,
    event: PanelEvent,
    c = ctx(),
    own?: SessionSearch,
  ) => nextSearch(current, reducePanel(before, event, c), own);

  it('drops the other frame parameters when it restores on entry, keeping the rest and the message it goes to', () => {
    const current = { ...settings, message: 'msg_1', view: 'results' } as SessionSearch;
    const event = enter(current, { tabs: [files], selected: 'files', open: true });
    expect(write(current, EMPTY_PANEL, event)).toEqual({
      settings: 'models',
      panel: 'files',
      message: 'msg_1',
    });
  });

  it('writes the selected tab’s own state on a strip choice, never a one-time request', () => {
    const current: SessionSearch = { panel: 'files' };
    expect(
      write(
        current,
        state('beside', { selected: 'files' }),
        { type: 'select', key: 'run:run_1' },
        ctx(),
        {
          view: 'results',
          result: 'res_1',
          respond: true,
        },
      ),
    ).toEqual({ panel: 'run', run: 'run_1', view: 'results', result: 'res_1' });
  });

  it('keeps the tab’s own state while the same tab stays selected', () => {
    const current: SessionSearch = {
      panel: 'run',
      run: 'run_1',
      view: 'results',
      execution: 'ex_1',
    };
    expect(write(current, state('beside'), context, ctx())).toEqual(current);
  });

  it('consumes respond and advice', () => {
    const respond: SessionSearch = { panel: 'run', run: 'run_2', respond: true };
    expect(
      write(respond, state('beside'), { type: 'follow', search: respond, source: 'in-app' }),
    ).toEqual({ panel: 'run', run: 'run_1' });
    const advice: SessionSearch = { compose: true, advice: 'run_2' };
    expect(
      write(advice, state('closed'), { type: 'follow', search: advice, source: 'in-app' }),
    ).toEqual({ compose: true });
  });

  it('keeps an in-conversation message, with compose and with panel', () => {
    const quote: SessionSearch = { compose: true, message: 'msg_1' };
    expect(
      write(quote, state('closed'), { type: 'follow', search: quote, source: 'in-app' }),
    ).toEqual({ compose: true, message: 'msg_1' });
    const withPanel: SessionSearch = { panel: 'files', message: 'msg_1' };
    expect(
      write(withPanel, state('beside'), { type: 'follow', search: withPanel, source: 'in-app' }),
    ).toEqual({ panel: 'files', message: 'msg_1' });
  });

  it('drops the old run’s view, result, execution, artifact and position when a clean-up swaps the run', () => {
    const current: SessionSearch = {
      panel: 'run',
      run: 'run_x',
      view: 'results',
      result: 'res_1',
      execution: 'ex_1',
      artifact: 'art_1',
      atSeq: 4,
    };
    const waiting = reducePanel(EMPTY_PANEL, enter(current, null, 'address'), unlisted()).state;
    expect(write(current, waiting, context, ctx())).toEqual({ panel: 'run', run: 'run_2' });
  });

  it('drops a legacy tab parameter so it cannot reopen a tab', () => {
    const current = { compose: true, tab: 'run' } as SessionSearch;
    expect(write(current, state('closed'), context)).toEqual({ compose: true });
  });

  it('always writes exactly one of panel and compose, and compose survives validation', () => {
    const cases: [SessionSearch, PanelState, PanelEvent][] = [
      [{ panel: 'run', run: 'run_1', view: 'results' }, state('beside'), { type: 'toggle' }],
      [{ panel: 'run', run: 'run_1' }, state('beside'), { type: 'toggle' }],
      [{ compose: true }, state('closed'), { type: 'toggle' }],
      [{ panel: 'files' }, state('beside', { selected: 'files' }), { type: 'close', key: 'files' }],
      [{}, EMPTY_PANEL, enter({}, null)],
    ];
    for (const [current, before, event] of cases) {
      const next = write(current, before, event);
      expect('panel' in next !== 'compose' in next).toBe(true);
      expect(validateSessionSearch({ ...next })).toEqual(next);
    }
  });
});
