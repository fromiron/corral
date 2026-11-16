import { describe, expect, it } from 'vitest';
import { panelRunId, sessionRunViews } from './panelRun.ts';

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

describe('the run a session page presents (chat-widgets-contract.md 3.1)', () => {
  const past = { runId: 'run_past', status: 'succeeded' as const };
  const going = { runId: 'run_going', status: 'running' as const };
  const later = { runId: 'run_later', status: 'failed' as const };

  it('presents the active run, which the conversation follows and keeps open', () => {
    expect(sessionRunViews([past, going], [])).toEqual({
      presentationRunId: 'run_going',
      liveRunId: 'run_going',
    });
  });

  it('presents the last run when none is active', () => {
    expect(sessionRunViews([past, later], [])).toEqual({
      presentationRunId: 'run_later',
      liveRunId: null,
    });
  });

  it('presents the active run even when a later one has ended', () => {
    expect(sessionRunViews([past, going, later], [])).toEqual({
      presentationRunId: 'run_going',
      liveRunId: 'run_going',
    });
  });

  it('presents the last run the session names before the run list has it', () => {
    expect(sessionRunViews([], ['run_named'])).toEqual({
      presentationRunId: 'run_named',
      liveRunId: null,
    });
  });
});
