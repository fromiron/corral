import { expect, it, vi } from 'vitest';
import { RunSleepBlocker, runRoute } from '../src/lifecycle.ts';
import { recentWorkspaces } from '../src/security.ts';

it('simultaneous runs share a blocker and terminal runs release it', () => {
  const power = { start: vi.fn(() => 17), stop: vi.fn() };
  const blocker = new RunSleepBlocker(power);
  const run = { runId: 'run1', sessionId: 's1', status: 'running' };
  blocker.update([run], true, false);
  blocker.update([run, { ...run, runId: 'run2' }], true, false);
  expect(power.start).toHaveBeenCalledTimes(1);
  blocker.update([{ ...run, status: 'succeeded' }], true, false);
  expect(power.stop).toHaveBeenCalledWith(17);
  blocker.dispose();
  expect(power.stop).toHaveBeenCalledTimes(1);
});

it('waiting policy and disabling awake release ownership', () => {
  const power = { start: vi.fn(() => 18), stop: vi.fn() };
  const blocker = new RunSleepBlocker(power);
  const runs = [{ runId: 'r', sessionId: null, status: 'awaiting_user' }];
  blocker.update(runs, true, false);
  expect(power.start).not.toHaveBeenCalled();
  blocker.update(runs, true, true);
  expect(power.start).toHaveBeenCalledTimes(1);
  blocker.update(runs, false, true);
  expect(power.stop).toHaveBeenCalledWith(18);
});

it('tray navigation fixes both session and run identity', () => {
  expect(runRoute({ runId: 'run_1', sessionId: 'session_2', status: 'paused' })).toBe(
    '/sessions/session_2?panel=run&view=run&run=run_1',
  );
  expect(runRoute({ runId: 'run_1', sessionId: null, status: 'paused' })).toBe('/runs/run_1');
});

it('Windows recent folders are preserved across app restart', () => {
  expect(recentWorkspaces(['C:\\Toys\\one', 'D:\\two', 'relative'], 'D:\\two')).toEqual([
    'D:\\two',
    'C:\\Toys\\one',
  ]);
});
