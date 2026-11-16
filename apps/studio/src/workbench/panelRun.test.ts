import { describe, expect, it } from 'vitest';
import { panelRunId, sessionRunViews } from './panelRun.ts';
import { resolveSessionSearch } from './panels/routes.ts';

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

describe('the runs a session page presents and inspects (chat-widgets-contract.md 3.1)', () => {
  const past = { runId: 'run_past', status: 'succeeded' as const };
  const going = { runId: 'run_going', status: 'running' as const };
  const later = { runId: 'run_later', status: 'failed' as const };

  it('presents the active run although the address selects a past one; the run tab keeps it', () => {
    const search = { panel: 'run', run: 'run_past' };
    expect(sessionRunViews([past, going], [], search, true)).toEqual({
      presentationRunId: 'run_going',
      // The conversation follows the active run and keeps its store open.
      liveRunId: 'run_going',
      inspectedRunId: 'run_past',
    });
  });

  it('presents the active run on the conversation tab while the address still selects a past one', () => {
    // Back from the run record only the panel changes; the address keeps the run (routes.ts).
    expect(sessionRunViews([past, going], [], { run: 'run_past' }, true)).toEqual({
      presentationRunId: 'run_going',
      liveRunId: 'run_going',
      inspectedRunId: null,
    });
  });

  it('presents the last run when none is active, never the one the address selects', () => {
    expect(sessionRunViews([past, later], [], { run: 'run_past' }, true)).toEqual({
      presentationRunId: 'run_later',
      liveRunId: null,
      inspectedRunId: null,
    });
  });

  it('inspects the run the remembered view brings back to a bare run tab address', () => {
    // `?panel=run` carries no run of its own; the page's resolved search has the remembered one.
    const search = resolveSessionSearch({ panel: 'run' }, { run: 'run_past', view: 'run' });
    expect(sessionRunViews([past, going], [], search, true)).toMatchObject({
      presentationRunId: 'run_going',
      inspectedRunId: 'run_past',
    });
  });

  it('inspects the newest run on a run tab address with no run, which need not be the active one', () => {
    expect(sessionRunViews([past, going, later], [], { panel: 'run' }, true)).toEqual({
      presentationRunId: 'run_going',
      liveRunId: 'run_going',
      inspectedRunId: 'run_later',
    });
  });

  it('presents the last run the session names before the run list has it', () => {
    expect(sessionRunViews([], ['run_named'], {}, false)).toEqual({
      presentationRunId: 'run_named',
      liveRunId: null,
      inspectedRunId: null,
    });
  });
});
