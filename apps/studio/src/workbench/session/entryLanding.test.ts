import { expect, it } from 'vitest';
import { unseenAnswerRun } from './entryLanding.ts';

// workbench.md 대화 스크롤: only an answer that ended well and was not seen here lands; a
// conversation this device never entered has no news.
it('names the newest run only when it succeeded and a record says it was not seen', () => {
  const runs = (status: 'running' | 'succeeded' | 'failed') => [
    { runId: 'run_1', status: 'succeeded' as const },
    { runId: 'run_2', status },
  ];
  const seen = (seenRun: string | null) => ({ openedAt: null, seenRun });
  expect(unseenAnswerRun(runs('succeeded'), seen('run_1'))).toBe('run_2');
  expect(unseenAnswerRun(runs('succeeded'), seen(null))).toBe('run_2');
  expect(unseenAnswerRun(runs('succeeded'), seen('run_2'))).toBeNull();
  expect(unseenAnswerRun(runs('succeeded'), null)).toBeNull();
  expect(unseenAnswerRun(runs('running'), seen('run_1'))).toBeNull();
  expect(unseenAnswerRun(runs('failed'), seen('run_1'))).toBeNull();
  expect(unseenAnswerRun([], seen(null))).toBeNull();
});
