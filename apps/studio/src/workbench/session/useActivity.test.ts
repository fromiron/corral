import { executionPresence, runPresence } from '@corral/react';
import { describe, expect, it } from 'vitest';
import { type ActivityInput, type ActivityRole, closedLine } from './useActivity.ts';

// The activity bar's closed line (features/composer-flow.md "활동 바"): the first that holds of
// an off-screen waiting request, an off-screen working role, the join target's activity and the
// idle summary. What a visible run row or card already says is not said again.

const role = (id: string, name: string, activity: string | null = null): ActivityRole => ({
  id,
  name,
  presence: executionPresence({ status: 'active' }),
  activity,
  startedAt: '2026-11-13T00:00:00.000Z',
  endedAt: null,
});

const team = [
  role('exec_lead', 'Implementer', 'Edit file'),
  role('exec_research', 'Researcher', 'Read file'),
  role('exec_review', 'Reviewer'),
];

const input = (change: Partial<ActivityInput> = {}): ActivityInput => ({
  connection: 'ok',
  run: {
    runId: 'run_a',
    presence: runPresence({ status: 'running' }, [], []),
    live: true,
    lead: 'exec_lead',
    roles: team.length,
  },
  roles: team,
  waiting: { count: 0, first: null },
  tray: 'unknown',
  visible: new Set(),
  target: null,
  ...change,
});

describe('closedLine', () => {
  it('says an off-screen waiting request first, before any role', () => {
    const line = closedLine(
      input({
        tray: 'out-of-view',
        waiting: {
          count: 1,
          first: { kind: 'approval', approvalId: 'approval_a', subject: 'Run command' },
        },
      }),
    );
    expect(line).toMatchObject({ kind: 'waiting', count: 1, item: { approvalId: 'approval_a' } });
  });

  it('counts several waiting requests and names none of them', () => {
    const line = closedLine(
      input({
        tray: 'out-of-view',
        waiting: {
          count: 3,
          first: { kind: 'question', subject: 'Which database?' },
        },
      }),
    );
    expect(line).toEqual({ kind: 'waiting', count: 3, item: null });
  });

  it('does not take the tray as off-screen before it is measured, nor while it is in view', () => {
    const waiting = {
      count: 1,
      first: { kind: 'question' as const, subject: 'Which database?' },
    };
    expect(closedLine(input({ tray: 'unknown', waiting })).kind).not.toBe('waiting');
    expect(closedLine(input({ tray: 'in-view', waiting })).kind).not.toBe('waiting');
  });

  it('leaves out the roles whose rows are on screen', () => {
    const line = closedLine(
      input({ visible: new Set(['execution:exec_research', 'execution:exec_review']) }),
    );
    // The lead's row is the run row's body: off-screen too, it is the one left.
    expect(line).toMatchObject({ kind: 'role', role: { id: 'exec_lead' }, others: 0 });
    const all = closedLine(input());
    expect(all).toMatchObject({ kind: 'role', others: 2 });
  });

  it('takes the run row on screen as the lead role on screen', () => {
    const line = closedLine(
      input({
        visible: new Set(['run:run_a', 'execution:exec_research']),
        roles: team.slice(0, 2),
      }),
    );
    // Nothing working is off-screen: the join target's activity.
    expect(line).toMatchObject({ kind: 'target', role: { id: 'exec_lead' }, stateShown: false });
  });

  it('names the off-screen role that is the join target before the others', () => {
    const line = closedLine(input({ target: 'exec_review' }));
    expect(line).toMatchObject({ kind: 'role', role: { id: 'exec_review' }, others: 2 });
  });

  it('says the join target’s activity when every working role is on screen', () => {
    const line = closedLine(
      input({
        visible: new Set(['run:run_a', 'execution:exec_research', 'execution:exec_review']),
        target: 'exec_research',
      }),
    );
    expect(line).toMatchObject({ kind: 'target', role: { id: 'exec_research' } });
    // Its row says its state: the bar says what it does, not the state again.
    expect(line).toMatchObject({ stateShown: false });
  });

  it('says a single off-screen role as its activity', () => {
    const single = [role('exec_lead', 'Corral')];
    const line = closedLine(
      input({ roles: single, run: { ...input().run!, roles: 1 }, visible: new Set() }),
    );
    // One role: the role is off-screen, and the closed line is its activity.
    expect(line).toMatchObject({ kind: 'role', role: { id: 'exec_lead' } });
  });

  it('ends in the summary of an ended run, without the state its row says', () => {
    const ended = {
      runId: 'run_a',
      presence: runPresence({ status: 'succeeded' }, [], []),
      live: false,
      lead: 'exec_lead',
      roles: 1,
    };
    expect(closedLine(input({ run: ended, roles: [] }))).toEqual({
      kind: 'summary',
      stateShown: true,
    });
    expect(closedLine(input({ run: ended, roles: [], visible: new Set(['run:run_a']) }))).toEqual(
      { kind: 'summary', stateShown: false },
    );
  });

  it('falls to the summary while the live run has no target to speak of', () => {
    const line = closedLine(input({ roles: [], visible: new Set(['run:run_a']) }));
    expect(line).toEqual({ kind: 'summary', stateShown: false });
  });

  it('has nothing to say without a run', () => {
    expect(closedLine(input({ run: null, roles: [] }))).toEqual({ kind: 'none' });
  });

  it('says a lost connection or record before anything else', () => {
    const waiting = {
      count: 1,
      first: { kind: 'approval' as const, approvalId: 'approval_a', subject: 'Run command' },
    };
    expect(closedLine(input({ connection: 'lost', tray: 'out-of-view', waiting }))).toEqual({
      kind: 'disconnected',
      reason: 'lost',
    });
    expect(closedLine(input({ connection: 'record', run: null, roles: [] }))).toEqual({
      kind: 'disconnected',
      reason: 'record',
    });
  });
});
