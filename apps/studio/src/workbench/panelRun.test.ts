import { describe, expect, it } from 'vitest';
import { panelRunId } from './panelRun.ts';

const runs = [{ runId: 'run_old' }, { runId: 'run_new' }];

describe('run shown in the session history panel', () => {
  it('shows the requested run when the session has it', () => {
    expect(panelRunId(runs, 'run_old', true)).toBe('run_old');
  });

  it('shows the newest run when none is requested', () => {
    expect(panelRunId(runs, undefined, true)).toBe('run_new');
  });

  it('falls back to the newest run when the requested one is no longer listed', () => {
    expect(panelRunId(runs, 'run_gone', true)).toBe('run_new');
  });

  it('shows no run when the loaded list is empty, even if one was requested', () => {
    expect(panelRunId([], 'run_gone', true)).toBeUndefined();
  });

  it('keeps the requested run until the list has loaded', () => {
    expect(panelRunId([], 'run_new', false)).toBe('run_new');
    expect(panelRunId(runs, 'run_started', false)).toBe('run_started');
  });
});
