// The panel model for the tabs S3 adds (features/session-panel.md 탭, 주소와 기억): 문서 per
// file, 팀 그래프 per team, 작업 with its inner tab.
import { describe, expect, it } from 'vitest';
import { nextSearch } from './address.ts';
import { changes, ctx, enter, files, ids, panel, way } from './fixtures.ts';
import { parsePanelMemory, rememberedPanel, serializePanelMemory } from './memory.ts';
import { DOCUMENT_LIMIT, documentLimitReached, EMPTY_PANEL, reducePanel } from './model.ts';
import { type PanelTab, tabKey } from './tabs.ts';

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

// The restored 문서 tabs' clean-up (features/session-panel.md 주소와 기억): each is read once
// after entry; the page reports what it found.
describe('the 20 문서 tab limit', () => {
  const twenty = Array.from({ length: 20 }, (_, n) => doc(`src/f${n}.ts`));
  const full = () =>
    panel({ tabs: [files, ...twenty], selected: 'files', presentation: 'beside' });

  it('opens no 21st 문서 tab: the panel stays as it was', () => {
    const before = full();
    const result = reducePanel(before, way({ panel: 'document', file: 'src/new.ts' }), ctx());
    expect(result.state).toBe(before);
    expect(DOCUMENT_LIMIT).toBe(20);
    expect(documentLimitReached(before, doc('src/new.ts'))).toBe(true);
  });

  it('still selects an open 문서 tab, and opens other kinds of tab (counterexample)', () => {
    const before = full();
    const reopened = reducePanel(before, way({ panel: 'document', file: 'src/f3.ts' }), ctx());
    expect(reopened.state.selected).toBe('document:copy:src/f3.ts');
    expect(documentLimitReached(before, doc('src/f3.ts'))).toBe(false);
    const other = reducePanel(before, way({ panel: 'changes' }), ctx());
    expect(ids(other.state)).toEqual([files, ...twenty, changes]);
  });

  it('counts the source folder’s files with the copy’s, and only 문서 tabs', () => {
    const mixed = panel({
      tabs: [files, changes, ...twenty.slice(0, 19), doc('README.md', 'original')],
      selected: 'files',
      presentation: 'beside',
    });
    expect(documentLimitReached(mixed, doc('src/new.ts'))).toBe(true);
    const nineteen = panel({ tabs: [files, changes, ...twenty.slice(0, 19)], selected: 'files' });
    expect(documentLimitReached(nineteen, doc('src/new.ts'))).toBe(false);
  });
});

describe('restored 문서 tabs', () => {
  const copyA = { bindingId: 'binding_a', generation: 1 };
  const remembered = (tabs: PanelTab[], selected: string) => ({
    tabs,
    selected: selected as never,
    open: true,
  });
  const restore = (tabs: PanelTab[], selected: string) =>
    reducePanel(EMPTY_PANEL, enter({}, remembered(tabs, selected), 'address'), ctx()).state;
  const withCopy = (path: string): PanelTab => ({ ...doc(path), copy: copyA }) as PanelTab;
  const checked = (
    results: { key: string; outcome: 'keep' | 'drop'; draft?: boolean; instance?: number }[],
    state: ReturnType<typeof restore>,
  ) =>
    reducePanel(
      state,
      {
        type: 'documentsChecked',
        results: results.map((result) => ({
          key: result.key as never,
          instance:
            result.instance ?? state.tabs.find((tab) => tabKey(tab) === result.key)?.instance ?? 0,
          outcome: result.outcome,
          draft: result.draft ?? false,
        })),
      },
      ctx(),
    );

  it('drops a tab whose file is gone or whose copy is not the Paddock, and keeps one it could not read', () => {
    const state = restore(
      [withCopy('a.ts'), withCopy('b.ts'), withCopy('c.ts')],
      'document:copy:c.ts',
    );
    const result = checked(
      [
        { key: 'document:copy:a.ts', outcome: 'drop' },
        { key: 'document:copy:b.ts', outcome: 'keep' },
      ],
      state,
    );
    expect(ids(result.state).map((tab) => tabKey(tab))).toEqual([
      'document:copy:b.ts',
      'document:copy:c.ts',
    ]);
    expect(result.state.selected).toBe('document:copy:c.ts');
    expect(result.history).toBe('replace');
  });

  it('moves the selection to the first tab left when the selected one goes, and closes an emptied panel', () => {
    const state = restore([withCopy('a.ts'), changes], 'document:copy:a.ts');
    const result = checked([{ key: 'document:copy:a.ts', outcome: 'drop' }], state);
    expect(result.state.selected).toBe('changes');
    const alone = restore([withCopy('a.ts')], 'document:copy:a.ts');
    expect(checked([{ key: 'document:copy:a.ts', outcome: 'drop' }], alone).state).toMatchObject({
      tabs: [],
      selected: null,
      presentation: 'closed',
    });
  });

  it('opens 파일 where the first dropped tab with a draft stood, selected only if that tab was', () => {
    const state = restore([changes, withCopy('a.ts'), withCopy('b.ts')], 'document:copy:b.ts');
    const result = checked(
      [
        { key: 'document:copy:a.ts', outcome: 'drop', draft: true },
        { key: 'document:copy:b.ts', outcome: 'drop', draft: true },
      ],
      state,
    );
    expect(ids(result.state)).toEqual([changes, files]);
    expect(result.state.selected).toBe('files');
    // Not selected: 파일 opens in its place, and the selection stays.
    const other = restore([changes, withCopy('a.ts')], 'changes');
    const quiet = checked([{ key: 'document:copy:a.ts', outcome: 'drop', draft: true }], other);
    expect(ids(quiet.state)).toEqual([changes, files]);
    expect(quiet.state.selected).toBe('changes');
  });

  it('opens no 파일 tab for a dropped tab without a draft, nor a second one when 파일 is open (counterexample)', () => {
    const plain = restore([changes, withCopy('a.ts')], 'changes');
    expect(ids(checked([{ key: 'document:copy:a.ts', outcome: 'drop' }], plain).state)).toEqual([
      changes,
    ]);
    const open = restore([files, withCopy('a.ts')], 'document:copy:a.ts');
    const result = checked([{ key: 'document:copy:a.ts', outcome: 'drop', draft: true }], open);
    expect(ids(result.state)).toEqual([files]);
    expect(result.state.selected).toBe('files');
  });

  it('answers once, and never for a tab the person closed and opened again (counterexample)', () => {
    const state = restore([withCopy('a.ts'), changes], 'changes');
    const first = reducePanel(state, { type: 'close', key: 'document:copy:a.ts' }, ctx()).state;
    const reopened = reducePanel(first, way({ panel: 'document', file: 'a.ts' }), ctx()).state;
    const late = checked(
      [{ key: 'document:copy:a.ts', outcome: 'drop', instance: state.tabs[0]?.instance }],
      reopened,
    );
    expect(ids(late.state).map((tab) => tabKey(tab))).toContain('document:copy:a.ts');
    const done = checked([{ key: 'document:copy:a.ts', outcome: 'keep' }], state).state;
    expect(
      ids(checked([{ key: 'document:copy:a.ts', outcome: 'drop' }], done).state).map((tab) =>
        tabKey(tab),
      ),
    ).toContain('document:copy:a.ts');
  });

  it("stamps a tab's copy once read, as no touch and with no entry of its own", () => {
    const opened = reducePanel(EMPTY_PANEL, way({ panel: 'document', file: 'a.ts' }), ctx()).state;
    const tab = opened.tabs[0];
    const result = reducePanel(
      opened,
      {
        type: 'documentCopy',
        key: 'document:copy:a.ts',
        instance: tab?.instance ?? 0,
        copy: copyA,
      },
      ctx(),
    );
    expect(ids(result.state)).toEqual([withCopy('a.ts')]);
    expect(result.history).not.toBe('push');
    expect(rememberedPanel(result.state).tabs).toEqual([withCopy('a.ts')]);
  });
});

describe('팀 그래프 tabs', () => {
  it('drops restored tabs of a team the project does not list, once, and keeps the rest', () => {
    const memory = {
      tabs: [{ kind: 'graph', corralId: 'team_gone' } as PanelTab, files, graph],
      selected: 'graph:team_gone' as const,
      open: true,
    };
    const result = reducePanel(EMPTY_PANEL, enter({}, memory, 'address'), {
      ...ctx(),
      corralIds: ['team_a'],
    });
    expect(ids(result.state)).toEqual([files, graph]);
    expect(result.state.selected).toBe('files');
    // A later list never drops what the person opened after entering.
    const later = reducePanel(
      reducePanel(result.state, way({ panel: 'graph', corral: 'team_new' }), ctx()).state,
      { type: 'context' },
      { ...ctx(), corralIds: [] },
    );
    expect(ids(later.state)).toEqual([files, graph, { kind: 'graph', corralId: 'team_new' }]);
  });

  it('keeps restored tabs while the team list is not known (counterexample)', () => {
    const memory = { tabs: [graph], selected: 'graph:team_a' as const, open: true };
    const result = reducePanel(EMPTY_PANEL, enter({}, memory, 'address'), ctx());
    expect(ids(result.state)).toEqual([graph]);
  });

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
