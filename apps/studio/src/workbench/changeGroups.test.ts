import type { FileChangeView } from '@corral/client';
import { expect, it } from 'vitest';
import { changeGroups } from './changeGroups.ts';

// features/review-run-groups.md: how the whole-conversation list is grouped.
const file = (path: string, runs?: string[], outsideRuns?: boolean): FileChangeView => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  binary: false,
  provenance: 'external_observed',
  beforeBlob: 'a',
  afterBlob: 'b',
  ...(runs ? { runs, outsideRuns: outsideRuns ?? false } : {}),
});
const set = (files: FileChangeView[], runs?: string[]) => ({
  from: 'f',
  to: 't',
  unavailable: null,
  files,
  ...(runs ? { runs } : {}),
});
const shape = (groups: ReturnType<typeof changeGroups>) =>
  groups?.map((group) => [group.runId, group.files.map((f) => f.path)]) ?? null;
const none = () => false;

it('puts the newest run first and what changed outside any run last, a file in every group it changed during', () => {
  const groups = changeGroups(
    set(
      [file('a.ts', ['run_1']), file('b.ts', ['run_1', 'run_2']), file('c.ts', [], true)],
      ['run_1', 'run_2'],
    ),
    none,
  );
  expect(shape(groups)).toEqual([
    ['run_2', ['b.ts']],
    ['run_1', ['a.ts', 'b.ts']],
    [null, ['c.ts']],
  ]);
});

it('a file a run changed and someone changed again is under the run and outside', () => {
  const groups = changeGroups(set([file('a.ts', ['run_1'], true)], ['run_1']), none);
  expect(shape(groups)).toEqual([
    ['run_1', ['a.ts']],
    [null, ['a.ts']],
  ]);
});

it('one group is no grouping, and neither is an answer without the fields', () => {
  expect(changeGroups(set([file('a.ts', ['run_1'])], ['run_1']), none)).toBeNull();
  expect(changeGroups(set([file('a.ts', [], true), file('b.ts', [], true)], []), none)).toBeNull();
  expect(changeGroups(set([file('a.ts'), file('b.ts')]), none)).toBeNull();
  expect(changeGroups(null, none)).toBeNull();
});

it('a file that would be in no group keeps the list flat rather than dropping it', () => {
  expect(
    changeGroups(
      set([file('a.ts', ['run_1']), file('b.ts', [], true), file('lost.ts', [])], ['run_1']),
      none,
    ),
  ).toBeNull();
});

it('leaves out the files the list folds away, and counts groups without them', () => {
  const folded = (f: FileChangeView) => f.path === 'pnpm-lock.yaml';
  expect(
    shape(
      changeGroups(
        set(
          [
            file('a.ts', ['run_1']),
            file('b.ts', [], true),
            file('pnpm-lock.yaml', ['run_1', 'run_2']),
          ],
          ['run_1', 'run_2'],
        ),
        folded,
      ),
    ),
  ).toEqual([
    ['run_1', ['a.ts']],
    [null, ['b.ts']],
  ]);
  expect(
    changeGroups(
      set([file('a.ts', ['run_1']), file('pnpm-lock.yaml', ['run_2'])], ['run_1', 'run_2']),
      folded,
    ),
  ).toBeNull();
});
