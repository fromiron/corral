import assert from 'node:assert/strict';
import test from 'node:test';
import { fitEffortRows } from './native-features.ts';

const row = () => ({
  id: 'case-a',
  group: 'group-a',
  split: 'fit',
  task: 'effort',
  inputVersion: 'judge-structured-v2',
  text: 'Current request: fix the typo.',
  target: { level: 'low', acceptableLevels: ['low'] },
});

test('native extraction rejects every non-F row before task filtering', () => {
  for (const split of ['calibration', 'policy', 'final']) {
    assert.throws(() => fitEffortRows([row(), { ...row(), id: 'other', split }]));
    assert.throws(() => fitEffortRows([row(), { ...row(), task: 'meeting', split }]));
  }
});

test('native extraction keeps only structured effort rows without substituting old text', () => {
  assert.equal(fitEffortRows([row(), { ...row(), task: 'meeting' }]).length, 1);
  assert.throws(() => fitEffortRows([{ ...row(), inputVersion: 'legacy', oldText: 'old' }]));
  assert.throws(() => fitEffortRows([{ ...row(), text: undefined, oldText: 'old' }]));
  assert.throws(() => fitEffortRows([row(), row()]));
});
