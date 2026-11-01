import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeetingInput } from '../data.ts';
import { candidateFeatures, FEATURE_NAMES, frozenFitRows } from './candidate-features.ts';

const input: MeetingInput = {
  message: 'query',
  participants: [
    { id: 'a', name: 'Alice', role: 'planner' },
    { id: 'b', name: 'Bob', role: 'tester' },
  ],
  turns: [
    { id: 'old', speakerId: 'a', text: 'forbidden old' },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`,
      speakerId: i === 11 ? 'b' : null,
      text: i === 11 ? 'own last' : 'other',
    })),
  ],
};

test('features read only visible last12 text and never target or future relation metadata', async () => {
  const seen: string[] = [];
  const embed = async (text: string) => {
    seen.push(text);
    return Float32Array.of(1, 0);
  };
  const row = {
    ...input,
    target: { eligibleIds: ['SECRET'] },
    source: { linkedResponses: [{ text: 'FUTURE' }] },
  };
  const x = await candidateFeatures(row, embed);
  const [first, second] = x.candidates;
  assert.ok(first && second);
  assert.equal(x.candidates.length, 2);
  assert.equal(first.values.length, FEATURE_NAMES.length);
  assert.ok(!seen.some((text) => /SECRET|FUTURE|forbidden old|other/.test(text)));
  assert.deepEqual(first.values.slice(3), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(second.values.slice(3, 8), [1, 1, 1, 1, 1 / 12]);
  assert.equal(second.values[9], 1);
  assert.deepEqual(x.references.last, ['b']);
});

test('shared features are independent of candidate ID spelling and roster position', async () => {
  const embed = async (text: string) =>
    Float32Array.of(text.includes('tester') ? 0 : 1, text.includes('tester') ? 1 : 0);
  const first = await candidateFeatures(input, embed);
  const renamed = {
    ...input,
    participants: [...input.participants]
      .reverse()
      .map((p) => ({ ...p, id: p.id === 'a' ? 'arbitrary9' : 'arbitrary2' })),
    turns: input.turns.map((t) => ({
      ...t,
      speakerId: t.speakerId === 'a' ? 'arbitrary9' : t.speakerId === 'b' ? 'arbitrary2' : null,
    })),
  };
  const second = await candidateFeatures(renamed, embed);
  assert.deepEqual(
    first.candidates.map((c) => c.values),
    second.candidates.map((c) => c.values).reverse(),
  );
});

test('frozen source hash and whole-team membership are required before any extraction', () => {
  const row = {
    id: 'one',
    group: 'teamA',
    split: 'fit',
    task: 'meeting',
    input,
    target: { mode: 'one', eligibleIds: ['a'], excludedIds: [] },
  };
  const manifest = {
    status: 'frozen-before-fitting',
    groups: { fit: ['teamA'], calibration: ['teamC'], policy: ['teamP'], final: ['teamH'] },
    files: { 'fit.raw.jsonl': { sha256: 'f'.repeat(64) } },
  };
  assert.equal(frozenFitRows([row], 'f'.repeat(64), 'f'.repeat(64), 'natural', manifest).length, 1);
  assert.throws(() => frozenFitRows([row], 'e'.repeat(64), 'f'.repeat(64), 'natural', manifest));
  assert.throws(() =>
    frozenFitRows(
      [{ ...row, split: 'final' }],
      'f'.repeat(64),
      'f'.repeat(64),
      'natural',
      manifest,
    ),
  );
  assert.throws(() =>
    frozenFitRows(
      [{ ...row, group: 'teamH' }],
      'f'.repeat(64),
      'f'.repeat(64),
      'natural',
      manifest,
    ),
  );
  assert.throws(() =>
    frozenFitRows([row], 'f'.repeat(64), 'f'.repeat(64), 'natural', {
      ...manifest,
      status: 'inventory',
    }),
  );
});

test('empty/nonfinite embeddings and duplicate roster IDs fail rather than becoming zero success', async () => {
  const first = input.participants[0];
  assert.ok(first);
  await assert.rejects(candidateFeatures(input, async () => Float32Array.of(NaN)));
  await assert.rejects(
    candidateFeatures({ ...input, participants: [first, first] }, async () => Float32Array.of(1)),
  );
});
