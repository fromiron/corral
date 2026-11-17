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
