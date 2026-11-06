import type { FileOperationView, IntegrationResultView } from '@corral/client';
import type { FileCheckpoint } from '@corral/contracts';
import { expect, it } from 'vitest';
import {
  integrationDisplayState,
  unchangedCheckpoints,
  uniqueFileOperations,
} from './fileReviewPresentation.ts';

it('describes partial reverts without claiming the applied changes were partly applied', () => {
  const result = {
    state: 'partial',
    files: [{ outcome: 'reverted' }, { outcome: 'revert_conflict' }],
  } as IntegrationResultView;
  expect(integrationDisplayState(result)).toBe('partlyReverted');
  expect(
    integrationDisplayState({
      ...result,
      state: 'applied',
      files: [{ outcome: 'revert_conflict' }],
    } as IntegrationResultView),
  ).toBe('notReverted');
  expect(
    integrationDisplayState({
      ...result,
      files: [{ outcome: 'applied' }, { outcome: 'conflict' }],
    } as IntegrationResultView),
  ).toBe('partial');
});

it('deduplicates only the operation identity, retaining repeated writes to one path', () => {
  const first = {
    id: 'one',
    path: 'same.ts',
    run_id: 'run',
    state: 'applied',
  } as FileOperationView;
  const second = { ...first, id: 'two' };
  expect(uniqueFileOperations([first, first, second])).toEqual([first, second]);
});

it('compares checkpoints in creation order within the same target without combining their provenance', () => {
  const item = { state: 'ready', tree: 'same', target: 'working_copy' } as FileCheckpoint;
  const first = { ...item, checkpointId: 'first', createdAt: '2026-10-29T01:00:00Z' };
  const second = { ...item, checkpointId: 'second', createdAt: '2026-10-29T02:00:00Z' };
  const original = { ...second, checkpointId: 'original', target: 'original' as const };
  expect(unchangedCheckpoints([second, original, first])).toEqual(new Set(['second']));
  expect(unchangedCheckpoints([{ ...second, createdAt: first.createdAt }, first])).toEqual(
    new Set(['second']),
  );
});
