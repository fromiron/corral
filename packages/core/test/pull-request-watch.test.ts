import { describe, expect, it } from 'vitest';
import {
  evaluatePullRequestWatch,
  type PullRequestWatchState,
  pullRequestWakeEntry,
  pullRequestWakeText,
} from '../src/pull-request-watch.ts';
import type { WorkSession } from '../src/repository/index.ts';

// docs/specs/features/pull-requests.md 감시·깨우기: what wakes the agent, and what it reads.

const check = (name: string, failed: boolean, url: string | null = null) => ({
  name,
  url,
  failed,
});

describe('the watch evaluation', () => {
  it('takes the first read as a baseline and wakes for nothing in it', () => {
    const report = evaluatePullRequestWatch(null, {
      headSha: 'a1',
      checks: [check('lint', true)],
      mergeable: 'CONFLICTING',
    });
    expect(report.changes).toEqual([]);
    expect(report.next).toEqual({ headSha: 'a1', failedChecks: ['lint'], conflicting: true });
  });

  it('wakes for a check that newly fails on the same head, once', () => {
    const state = { headSha: 'a1', failedChecks: ['lint'], conflicting: false };
    const read = {
      headSha: 'a1',
      checks: [check('lint', true), check('test', true, 'https://ci/test')],
      mergeable: 'MERGEABLE',
    };
    const first = evaluatePullRequestWatch(state, read);
    expect(first.changes).toEqual([
      { kind: 'checks_failed', failed: [check('test', true, 'https://ci/test')] },
    ]);
    expect(evaluatePullRequestWatch(first.next, read).changes).toEqual([]);
  });

  it('starts over when the head moves, so the same check failing again is news', () => {
    const state = { headSha: 'a1', failedChecks: ['test'], conflicting: true };
    const report = evaluatePullRequestWatch(state, {
      headSha: 'b2',
      checks: [check('test', true)],
      mergeable: 'CONFLICTING',
    });
    expect(report.changes.map((change) => change.kind)).toEqual(['checks_failed', 'conflicting']);
  });

  it('keeps the prior state when checks could not be read or are empty, and while mergeability is unknown', () => {
    const state = { headSha: 'a1', failedChecks: ['test'], conflicting: true };
    for (const checks of [null, []]) {
      const report = evaluatePullRequestWatch(state, {
        headSha: 'a1',
        checks,
        mergeable: 'UNKNOWN',
      });
      expect(report.changes).toEqual([]);
      expect(report.next).toEqual(state);
    }
  });

  it('wakes for a conflict once, until a clean answer clears it', () => {
    let state: PullRequestWatchState = { headSha: 'a1', failedChecks: [], conflicting: false };
    const conflict = { headSha: 'a1', checks: [], mergeable: 'CONFLICTING' };
    const first = evaluatePullRequestWatch(state, conflict);
    expect(first.changes).toEqual([{ kind: 'conflicting' }]);
    state = first.next;
    expect(evaluatePullRequestWatch(state, conflict).changes).toEqual([]);
    state = evaluatePullRequestWatch(state, { ...conflict, mergeable: 'MERGEABLE' }).next;
    expect(evaluatePullRequestWatch(state, conflict).changes).toEqual([{ kind: 'conflicting' }]);
  });
});

describe('the wake', () => {
  it('names the PR, at most ten failed checks with their addresses, and a conflict', () => {
    const failed = Array.from({ length: 12 }, (_, i) =>
      check(`job-${i + 1}`, true, i === 0 ? 'https://ci/1' : null),
    );
    const text = pullRequestWakeText({
      number: 12,
      url: 'https://github.com/acme/widgets/pull/12',
      base: 'main',
      headSha: 'abcdef1234',
      changes: [{ kind: 'checks_failed', failed }, { kind: 'conflicting' }],
    });
    expect(text.startsWith('Note from Corral, not from the person:')).toBe(true);
    expect(text).toContain('#12 (https://github.com/acme/widgets/pull/12)');
    expect(text).toContain('- Checks failed on abcdef1:');
    expect(text).toContain('  - job-1 https://ci/1');
    expect(text).toContain('  - job-10');
    expect(text).not.toContain('  - job-11');
    expect(text).toContain('  - and 2 more');
    expect(text).toContain('- The branch now conflicts with main.');
  });

  it("queues the wake with the latest started request's choices, or nothing without one", () => {
    const start = {
      choice: { modelProfile: 'deepseek-hive' },
      mode: 'live',
      taskScope: null,
      verificationScope: null,
    };
    const session = {
      entries: [
        { entryId: 'e1', intent: 'next', text: 'first', start, permissionMode: 'default' },
        { entryId: 'e2', intent: 'steer', text: 'note' },
      ],
    } as unknown as WorkSession;
    expect(pullRequestWakeEntry(session, { number: 12, headSha: 'a1', text: 'wake' })).toEqual({
      intent: 'queue',
      state: 'queued',
      text: 'wake',
      start,
      permissionMode: 'default',
      pullRequest: { number: 12, headSha: 'a1' },
    });
    expect(
      pullRequestWakeEntry({ entries: [] } as unknown as WorkSession, {
        number: 12,
        headSha: 'a1',
        text: 'wake',
      }),
    ).toBeNull();
  });
});
