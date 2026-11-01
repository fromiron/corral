import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiresExposure } from './evaluation-input.ts';

test('sealed rows cannot enter baseline replay through a mixed input file', () => {
  assert.throws(() => requiresExposure([{ split: 'policy' }, { split: 'final' }], false));
  assert.equal(requiresExposure([{ split: 'final' }], true), true);
  assert.equal(requiresExposure([{ split: 'policy' }], false), false);
});
