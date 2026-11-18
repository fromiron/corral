// The tree's Refresh found source-folder files gone (workbench.md Paddock의 수동 파일 변경): their
// 문서 tabs are dropped as a restored 문서 tab's missing file is (features/session-panel.md 주소와
// 기억): a dropped selection goes to the first tab left, or the panel closes, and the address is
// rewritten without an entry.
import { describe, expect, it } from 'vitest';
import { ctx, files, ids, panel } from './fixtures.ts';
import { type PanelEvent, reducePanel } from './model.ts';
import { type PanelTab, type TabKey, tabKey } from './tabs.ts';

const source = (path: string): PanelTab => ({ kind: 'document', source: 'original', path });
const copy = (path: string): PanelTab => ({ kind: 'document', source: 'copy', path });
const gone = (...tabs: { key: TabKey; instance: number }[]): PanelEvent => ({
  type: 'sourceFilesGone',
  tabs,
});

describe('source-folder files gone on a refresh', () => {
  it('drop the selected tab: the first tab left is selected and the address is rewritten', () => {
    const state = panel({
      tabs: [copy('a.ts'), source('gone.md'), source('README.md')],
      selected: tabKey(source('gone.md')),
      presentation: 'beside',
    });
    const result = reducePanel(state, gone({ key: tabKey(source('gone.md')), instance: 2 }), ctx());
    expect(ids(result.state)).toEqual([copy('a.ts'), source('README.md')]);
    expect(result.state.selected).toBe(tabKey(copy('a.ts')));
    expect(result.state.presentation).toBe('beside');
    expect(result.history).toBe('replace');
    expect(result.address).toMatchObject({ panel: 'document', file: 'a.ts' });
  });

  it('drop an unselected tab: the selection stays', () => {
    const state = panel({
      tabs: [source('gone.md'), source('README.md')],
      selected: tabKey(source('README.md')),
      presentation: 'beside',
    });
    const result = reducePanel(state, gone({ key: tabKey(source('gone.md')), instance: 1 }), ctx());
    expect(ids(result.state)).toEqual([source('README.md')]);
    expect(result.state.selected).toBe(tabKey(source('README.md')));
  });

  it('drop the only tab: the panel closes', () => {
    const state = panel({
      tabs: [source('gone.md')],
      selected: tabKey(source('gone.md')),
      presentation: 'beside',
    });
    const result = reducePanel(state, gone({ key: tabKey(source('gone.md')), instance: 1 }), ctx());
    expect(result.state.tabs).toEqual([]);
    expect(result.state.selected).toBeNull();
    expect(result.state.presentation).toBe('closed');
    expect(result.address).toEqual({ compose: true });
  });

  it('a wide panel left with 파일 and one 문서 tab draws the tree beside that tab', () => {
    const state = panel({
      tabs: [files, source('gone.md'), source('README.md')],
      selected: tabKey(source('gone.md')),
      presentation: 'beside',
    });
    const wide = ctx({ wide: true });
    const result = reducePanel(state, gone({ key: tabKey(source('gone.md')), instance: 2 }), wide);
    expect(ids(result.state)).toEqual([files, source('README.md')]);
    expect(result.state.selected).toBe(tabKey(source('README.md')));
  });

  it('a tab closed and opened again since the read is a new instance and stays (반례)', () => {
    const state = panel({
      tabs: [source('README.md'), source('gone.md')],
      selected: tabKey(source('gone.md')),
      lastDocument: tabKey(source('gone.md')),
      presentation: 'beside',
    });
    const result = reducePanel(state, gone({ key: tabKey(source('gone.md')), instance: 9 }), ctx());
    expect(result.state).toBe(state);
    expect(result.history).toBeNull();
  });

  it('only a source-folder tab is dropped; the copy tab of the same path stays (반례)', () => {
    const state = panel({
      tabs: [copy('gone.md'), source('README.md')],
      selected: tabKey(copy('gone.md')),
      lastDocument: tabKey(copy('gone.md')),
      presentation: 'beside',
    });
    const result = reducePanel(state, gone({ key: tabKey(copy('gone.md')), instance: 1 }), ctx());
    expect(result.state).toBe(state);
    expect(result.history).toBeNull();
  });
});
