import assert from 'node:assert/strict';
import test from 'node:test';
import { meanProbabilities } from './reference-ensemble.ts';

test('averages member probabilities, preserving roster order and exact zero support', () => {
  assert.deepEqual(
    meanProbabilities([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 1, 0],
      [0, 0, 1, 0],
    ]),
    [0.2, 0.2, 0.6, 0],
  );
});

test('refuses incomplete or invalid head outputs', () => {
  assert.throws(() => meanProbabilities([[1, 0, 0, 0]]));
  assert.throws(() => meanProbabilities(Array.from({ length: 5 }, () => [NaN, 0, 0, 1])));
  assert.throws(() => meanProbabilities(Array.from({ length: 5 }, () => [1, 1, 0, 0])));
});
