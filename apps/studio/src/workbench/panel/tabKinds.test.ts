// The panel model for the tabs S3 adds (features/session-panel.md 탭, 주소와 기억): 문서 per
// file, 팀 그래프 per team, 작업 with its inner tab.
import { describe, expect, it } from 'vitest';
import { nextSearch } from './address.ts';
import { ctx, enter, files, ids, panel, way } from './fixtures.ts';
import { parsePanelMemory, rememberedPanel, serializePanelMemory } from './memory.ts';
import { EMPTY_PANEL, reducePanel } from './model.ts';
import type { PanelTab } from './tabs.ts';

const doc = (path: string, source: 'copy' | 'original' = 'copy'): PanelTab => ({
  kind: 'document',
  source,
  path,
});
const graph: PanelTab = { kind: 'graph', corralId: 'team_a' };

describe('문서 tabs', () => {
  it('opens a file’s tab at the right end and writes panel=document with its path', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const result = reducePanel(before, way({ panel: 'document', file: 'src/a.ts' }), ctx());
    expect(ids(result.state)).toEqual([files, doc('src/a.ts')]);
    expect(result.state.selected).toBe('document:copy:src/a.ts');
    expect(result.address).toEqual({ panel: 'document', file: 'src/a.ts' });
    expect(result.history).toBe('push');
  });

  it('keeps the source folder’s file and the copy’s file of one path apart', () => {
    const before = panel({
      tabs: [doc('README.md')],
      selected: 'document:copy:README.md',
      presentation: 'beside',
    });
    const result = reducePanel(
      before,
      way({ panel: 'document', file: 'README.md', source: 'original' }),
      ctx(),
    );
    expect(ids(result.state)).toEqual([doc('README.md'), doc('README.md', 'original')]);
    expect(result.address).toEqual({ panel: 'document', file: 'README.md', target: 'original' });
  });

  it('selects the open tab of the same file instead of opening another, keeping its instance', () => {
    const before = panel({
      tabs: [doc('src/a.ts'), files],
      selected: 'files',
      presentation: 'beside',
    });
    const { state } = reducePanel(before, way({ panel: 'document', file: 'src/a.ts' }), ctx());
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0]?.instance).toBe(1);
    expect(state.selected).toBe('document:copy:src/a.ts');
  });

  it('opens no document’s tab for panel=document without a file (counterexample)', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const result = reducePanel(before, way({ panel: 'document' }), ctx());
    expect(result.state).toBe(before);
    expect(result.history).toBeNull();
  });

  it('opens the addressed document on entry beside the remembered tabs', () => {
    const memory = parsePanelMemory(
      serializePanelMemory(rememberedPanel(panel({ tabs: [files], selected: 'files' }))),
    );
    const search = { panel: 'document', file: 'docs/x.md', target: 'original' } as const;
    const result = reducePanel(EMPTY_PANEL, enter(search, memory, 'address'), ctx());
    expect(ids(result.state)).toEqual([files, doc('docs/x.md', 'original')]);
    expect(result.state.presentation).toBe('beside');
    expect(nextSearch(search, result)).toEqual(search);
  });

  it('drops the document’s path from the address when another tab is chosen', () => {
    const before = panel({
      tabs: [doc('src/a.ts'), files],
      selected: 'document:copy:src/a.ts',
      presentation: 'beside',
    });
    const result = reducePanel(before, { type: 'select', key: 'files' }, ctx());
    expect(nextSearch({ panel: 'document', file: 'src/a.ts' }, result)).toEqual({
      panel: 'files',
    });
  });
});

describe('팀 그래프 tabs', () => {
  it('opens one tab per team and writes panel=graph with the team', () => {
    const result = reducePanel(EMPTY_PANEL, way({ panel: 'graph', corral: 'team_a' }), ctx());
    expect(ids(result.state)).toEqual([graph]);
    expect(result.address).toEqual({ panel: 'graph', corral: 'team_a' });
    const again = reducePanel(result.state, way({ panel: 'graph', corral: 'team_b' }), ctx()).state;
    expect(ids(again)).toEqual([graph, { kind: 'graph', corralId: 'team_b' }]);
  });

  it('opens no team graph’s tab for panel=graph without a team (counterexample)', () => {
    const result = reducePanel(EMPTY_PANEL, way({ panel: 'graph' }), ctx());
    expect(result.state.tabs).toEqual([]);
    expect(result.history).toBeNull();
  });
});

describe('작업’s inner tab', () => {
  const tools = (view: 'tasks' | 'preview' | null): PanelTab => ({ kind: 'tools', view });
  const withTools = (view: 'tasks' | 'preview' | null) =>
    panel({ tabs: [files, tools(view)], selected: 'tools', presentation: 'beside' });

  it('remembers the inner tab the person picked, replacing the address', () => {
    const result = reducePanel(withTools(null), { type: 'toolsView', view: 'preview' }, ctx());
    expect(ids(result.state)).toEqual([files, tools('preview')]);
    expect(result.state.selected).toBe('tools');
    expect(result.history).toBe('replace');
    expect(rememberedPanel(result.state).tabs[1]).toEqual(tools('preview'));
  });

  it('changes nothing when the inner tab is already in front (duplicate)', () => {
    const before = withTools('tasks');
    const result = reducePanel(before, { type: 'toolsView', view: 'tasks' }, ctx());
    expect(result.state).toBe(before);
    expect(result.history).toBeNull();
  });

  it('changes nothing without a 작업 tab (late event)', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const result = reducePanel(before, { type: 'toolsView', view: 'preview' }, ctx());
    expect(result.state).toBe(before);
  });

  it('keeps the inner tab while another tab is selected and chosen again', () => {
    const away = reducePanel(withTools('preview'), { type: 'select', key: 'files' }, ctx()).state;
    const back = reducePanel(away, { type: 'select', key: 'tools' }, ctx()).state;
    expect(ids(back)).toEqual([files, tools('preview')]);
  });
});
