import { expect, it } from 'vitest';
import { unseenAnswerRun } from './entryLanding.ts';

// workbench.md 대화 스크롤: only an answer that ended well and was not seen here lands.
it('names the newest run only when it succeeded and was not seen before the entry', () => {
  const runs = (status: 'running' | 'succeeded' | 'failed') => [
    { runId: 'run_1', status: 'succeeded' as const },
    { runId: 'run_2', status },
  ];
  expect(unseenAnswerRun(runs('succeeded'), 'run_1')).toBe('run_2');
  expect(unseenAnswerRun(runs('succeeded'), null)).toBe('run_2');
  expect(unseenAnswerRun(runs('succeeded'), 'run_2')).toBeNull();
  expect(unseenAnswerRun(runs('running'), 'run_1')).toBeNull();
  expect(unseenAnswerRun(runs('failed'), 'run_1')).toBeNull();
  expect(unseenAnswerRun([], null)).toBeNull();
});
