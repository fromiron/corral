import type { FileChangeView, FileOperationView } from '@corral/client';
import { expect, it } from 'vitest';
import { runResultFiles } from './runResults.ts';

let seq = 0;
const op = (
  run_id: string,
  path: string,
  change: Partial<FileOperationView> = {},
): FileOperationView => ({
  id: `op_${++seq}`,
  run_id,
  execution_id: 'exec_1',
  kind: 'write',
  path,
  to_path: null,
  state: 'applied',
  detail: null,
  created_at: `2026-11-10T00:00:${String(seq).padStart(2, '0')}.000Z`,
  ...change,
});
const changed = (
  path: string,
  provenance: FileChangeView['provenance'] = 'managed_agent',
  status: FileChangeView['status'] = 'added',
): FileChangeView => ({
  path,
  status,
  additions: 1,
  deletions: 0,
  binary: false,
  provenance,
  beforeBlob: null,
  afterBlob: 'blob',
});

it('names the run whose applied write is the file’s current content, and nothing else', () => {
  // The server lists operations newest first.
  const operations = [
    op('run_3', 'moved/h.txt', { kind: 'move', path: 'g.txt', to_path: 'moved/h.txt' }),
    op('run_2', 'f.txt', { kind: 'delete' }),
    op('run_2', 'b.txt'),
    op('run_2', 'c.txt', { state: 'uncertain' }),
    op('run_2', 'c2.txt', { state: 'failed' }),
    op('run_2', 'c3.txt', { state: 'planned' }),
    op('run_1', 'f.txt'),
    op('run_1', 'g.txt'),
    op('run_1', 'b.txt'),
    op('run_1', 'a.txt'),
    op('run_1', 'd.txt'),
  ];
  const changes = [
    changed('a.txt'),
    changed('b.txt', 'managed_agent', 'modified'),
    changed('c.txt', 'external_observed'),
    changed('c2.txt', 'external_observed'),
    changed('c3.txt', 'external_observed'),
    // Run 1 wrote it, then something else changed it: its content is no longer the run's.
    changed('d.txt', 'mixed'),
    changed('e.txt', 'external_observed'),
    changed('f.txt', 'managed_agent', 'deleted'),
    changed('moved/h.txt'),
  ];
  expect(Object.fromEntries(runResultFiles(operations, changes))).toEqual({
    'a.txt': 'run_1',
    'b.txt': 'run_2',
    'moved/h.txt': 'run_3',
  });
});

it('a changed file without a recorded write is not a run result', () => {
  expect(runResultFiles([], [changed('a.txt')]).size).toBe(0);
  expect(runResultFiles([op('run_1', 'a.txt')], []).size).toBe(0);
});
