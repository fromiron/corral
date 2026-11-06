import type { ScheduledOccurrence } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { expect, it } from 'vitest';
import {
  completedScheduleRuns,
  scheduledRunOutcomes,
  scheduleHistoryStatus,
} from './scheduledRuns.ts';

const session = {
  sessionId: 'session',
  entries: [
    { commandId: 'scheduled_123', runId: 'scheduled' },
    { commandId: 'manual_123', runId: 'manual' },
    { commandId: 'scheduled_123', runId: 'scheduled' },
  ],
} as WorkSession;
const run = (status: RunSummary['status']) =>
  ({ runId: 'scheduled', sessionId: 'session', status }) as RunSummary;

it('notifies newly observed scheduled completion once without notifying initial history', () => {
  const running = scheduledRunOutcomes([session], [run('running')]);
  const done = scheduledRunOutcomes([session], [run('succeeded')]);
  expect(completedScheduleRuns(done, null)).toEqual([]);
  expect(completedScheduleRuns(done, running)).toEqual([
    { runId: 'scheduled', sessionId: 'session', status: 'succeeded' },
  ]);
  expect(completedScheduleRuns(done, done)).toEqual([]);
  expect(completedScheduleRuns(done, [])).toHaveLength(1);
  expect(scheduledRunOutcomes([session], [{ ...run('succeeded'), runId: 'manual' }])).toEqual([]);
  expect(scheduledRunOutcomes([session], [{ ...run('succeeded'), sessionId: 'other' }])).toEqual(
    [],
  );
});

it.each(['failed', 'cancelled', 'interrupted'] as const)(
  'uses the recorded %s result and preserves a missing run as unknown',
  (status) => {
    const occurrence = { runId: 'scheduled', status: 'started' } as ScheduledOccurrence;
    expect(scheduleHistoryStatus(occurrence, [run(status)])).toBe(status);
    expect(scheduleHistoryStatus(occurrence, [])).toBeNull();
    expect(completedScheduleRuns(scheduledRunOutcomes([session], [run(status)]), [])).toHaveLength(
      1,
    );
  },
);
