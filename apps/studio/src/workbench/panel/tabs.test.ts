import { describe, expect, it } from 'vitest';
import { SESSION_PANELS } from '../panels/registry.ts';
import {
  PANEL_TAB_OF,
  type PanelTab,
  plusItems,
  plusTarget,
  tabKey,
  tabPanel,
  targetTab,
} from './tabs.ts';

const run = (runId: string): PanelTab => ({ kind: 'run', runId });

describe('the panel tabs (탭)', () => {
  it('has a tab for every panel value, as the 탭 table says', () => {
    expect(Object.keys(PANEL_TAB_OF).sort()).toEqual([...SESSION_PANELS].sort());
    expect(PANEL_TAB_OF).toEqual({
      files: 'files',
      document: 'document',
      graph: 'graph',
      terminal: 'terminal',
      tools: 'files',
      // The bottom dock's debug tab, never the panel's.
      debug: null,
      changes: 'changes',
      git: 'changes',
      checks: 'changes',
      problems: 'changes',
      run: 'run',
      artifacts: 'artifacts',
    });
  });

  it('keys one tab per conversation for 파일, 변경, 결과 and one per run for 실행', () => {
    expect(tabKey({ kind: 'files' })).toBe('files');
    expect(tabKey({ kind: 'changes' })).toBe('changes');
    expect(tabKey({ kind: 'artifacts' })).toBe('artifacts');
    expect(tabKey(run('run_1'))).toBe('run:run_1');
  });

  it('keys 문서 by its source and relative path, 팀 그래프 by its team and 작업 once', () => {
    const copy = { kind: 'document', source: 'copy', path: 'src/a.ts' } as const;
    expect(tabKey(copy)).toBe('document:copy:src/a.ts');
    // The Paddock it was read from is not its identity: the same file is one tab.
    expect(tabKey({ ...copy, copy: { bindingId: 'binding_1', generation: 2 } })).toBe(
      'document:copy:src/a.ts',
    );
    expect(tabKey({ ...copy, source: 'original' })).toBe('document:original:src/a.ts');
    expect(tabKey({ kind: 'graph', corralId: 'team_a' })).toBe('graph:team_a');
    expect(tabKey({ kind: 'tools', view: null })).toBe('tools');
    expect(tabKey({ kind: 'tools', view: 'preview' })).toBe('tools');
  });

  it('opens a document’s tab only with its file, and a team graph’s only with its team', () => {
    expect(targetTab({ panel: 'document', file: 'src/a.ts' }, null)).toEqual({
      kind: 'document',
      source: 'copy',
      path: 'src/a.ts',
    });
    expect(targetTab({ panel: 'document', file: 'README.md', source: 'original' }, null)).toEqual({
      kind: 'document',
      source: 'original',
      path: 'README.md',
    });
    expect(targetTab({ panel: 'document' }, null)).toBeNull();
    expect(targetTab({ panel: 'graph', corral: 'team_a' }, null)).toEqual({
      kind: 'graph',
      corralId: 'team_a',
    });
    expect(targetTab({ panel: 'graph' }, null)).toBeNull();
  });

  it('writes each tab’s own panel value when nothing inside it is in front', () => {
    expect(tabPanel({ kind: 'files' })).toBe('files');
    expect(tabPanel({ kind: 'changes' })).toBe('changes');
    expect(tabPanel({ kind: 'artifacts' })).toBe('artifacts');
    expect(tabPanel(run('run_1'))).toBe('run');
  });

  it('opens the tab a window or view belongs to', () => {
    expect(targetTab({ panel: 'tools' }, [])).toEqual({ kind: 'files' });
    expect(targetTab({ panel: 'git' }, [])).toEqual({ kind: 'changes' });
    expect(targetTab({ panel: 'artifacts' }, [])).toEqual({ kind: 'artifacts' });
    expect(targetTab({ panel: 'run', run: 'run_1' }, ['run_1', 'run_2'])).toEqual(run('run_1'));
  });

  it('opens the newest run’s tab for panel=run without run, and none when there is no run', () => {
    expect(targetTab({ panel: 'run' }, ['run_1', 'run_2'])).toEqual(run('run_2'));
    expect(targetTab({ panel: 'run' }, [])).toBeNull();
  });

  it('opens no newest run’s tab while the run list is not known, but a named run’s', () => {
    expect(targetTab({ panel: 'run' }, null)).toBeNull();
    expect(targetTab({ panel: 'run', run: 'run_3' }, null)).toEqual(run('run_3'));
    expect(targetTab({ panel: 'files' }, null)).toEqual({ kind: 'files' });
  });

  it('keeps a run the list does not know yet (a run just started)', () => {
    expect(targetTab({ panel: 'run', run: 'run_3' }, ['run_1', 'run_2'])).toEqual(run('run_3'));
  });
});

describe('the "+" list', () => {
  it('lists 파일, 변경, 실행 기록, 결과 in this order when a folder is connected and a run exists', () => {
    expect(plusItems({ folder: true, runIds: ['run_1'] })).toEqual([
      'files',
      'changes',
      'run-history',
      'artifacts',
    ]);
  });

  it('lists only what can be opened now', () => {
    expect(plusItems({ folder: true, runIds: [] })).toEqual(['files', 'changes']);
    expect(plusItems({ folder: false, runIds: ['run_1'] })).toEqual(['run-history', 'artifacts']);
    expect(plusItems({ folder: false, runIds: [] })).toEqual([]);
  });

  it('lists the run items only once the run list is known', () => {
    expect(plusItems({ folder: true, runIds: null })).toEqual(['files', 'changes']);
    expect(plusItems({ folder: false, runIds: null })).toEqual([]);
  });

  it('opens the newest run’s tab from 실행 기록, whatever other run tabs are open', () => {
    expect(plusTarget('run-history', { runIds: ['run_1', 'run_2'] })).toEqual({
      panel: 'run',
      run: 'run_2',
    });
    expect(plusTarget('files', { runIds: [] })).toEqual({ panel: 'files' });
    expect(plusTarget('changes', { runIds: [] })).toEqual({ panel: 'changes' });
    expect(plusTarget('artifacts', { runIds: ['run_1'] })).toEqual({ panel: 'artifacts' });
  });
});
