import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  effortBaselineInput,
  historyCosineReferences,
  meetingCosineInputs,
  ROLE_HISTORY_WEIGHTS,
} from './baseline-inputs.ts';
import type { MeetingInput } from './data.ts';

test('effort baseline uses the authoritative runtime legacy text over the earlier research view', () => {
  assert.deepEqual(
    effortBaselineInput({ oldText: 'stale view', runtimeView: { legacyText: 'core view' } }),
    { text: 'core view', source: 'runtimeView.legacyText' },
  );
  assert.equal(
    effortBaselineInput({ runtimeView: { legacyText: 'only core view' } }).text,
    'only core view',
  );
  assert.equal(effortBaselineInput({ oldText: 'stale', runtimeView: { legacyText: '' } }).text, '');
});

test('effort baseline preserves old inputs but rejects invalid explicitly supplied runtime views', () => {
  assert.deepEqual(effortBaselineInput({ oldText: 'legacy' }), {
    text: 'legacy',
    source: 'oldText',
  });
  assert.equal(
    effortBaselineInput({ oldText: 'legacy', runtimeView: { scope: 'other' } }).text,
    'legacy',
  );
  for (const legacyText of [null, undefined, 123, {}, []])
    assert.throws(() =>
      effortBaselineInput({ oldText: 'fallback must not mask this', runtimeView: { legacyText } }),
    );
  for (const runtimeView of [null, undefined, 123, 'invalid', []])
    assert.throws(() =>
      effortBaselineInput({ oldText: 'fallback must not mask this', runtimeView }),
    );
  assert.throws(() => effortBaselineInput({ oldText: null }));
});

test('the predetermined cosine grid selects one participant with deterministic roster-order ties', () => {
  assert.deepEqual(ROLE_HISTORY_WEIGHTS, [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(historyCosineReferences(['later-id', 'first-id'], [1, 0], [0, 1]), {
    maxHistoryCosine: ['first-id'],
    roleHistoryCosine_0: ['first-id'],
    'roleHistoryCosine_0.25': ['first-id'],
    'roleHistoryCosine_0.5': ['later-id'],
    'roleHistoryCosine_0.75': ['later-id'],
    roleHistoryCosine_1: ['later-id'],
  });
  assert.throws(() => historyCosineReferences(['p1'], [NaN], [1]));
  assert.throws(() => historyCosineReferences(['p1'], [1, 0], [1]));
});

test('meeting references use name/role and every owned turn only inside the actual last12 window', () => {
  const input: MeetingInput = {
    message: 'current visible message',
    participants: [
      { id: 'p2', name: 'Mina', role: 'planner' },
      { id: 'p1', name: 'Haru', role: '' },
    ],
    turns: Array.from({ length: 15 }, (_, i) => ({
      id: `t${i}`,
      speakerId: i % 2 ? 'p2' : 'p1',
      text: `turn ${i}`,
    })),
  };
  const before = structuredClone(input);
  assert.deepEqual(meetingCosineInputs(input), {
    query: input.message,
    participants: [
      {
        id: 'p2',
        role: 'Mina\nplanner',
        history: ['turn 3', 'turn 5', 'turn 7', 'turn 9', 'turn 11', 'turn 13'],
      },
      {
        id: 'p1',
        role: 'Haru',
        history: ['turn 4', 'turn 6', 'turn 8', 'turn 10', 'turn 12', 'turn 14'],
      },
    ],
  });
  assert.deepEqual(input, before);
});

test('meeting reference rendering excludes labels, other speakers and turns outside the window', () => {
  const input = {
    message: 'visible question',
    participants: [{ id: 'p1', name: 'Riley', role: '' }],
    turns: [
      { id: 'old', speakerId: 'p1', text: 'too old' },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `t${i}`,
        speakerId: null,
        text: 'user turn',
      })),
    ],
    target: { eligibleIds: ['FORBIDDEN_LABEL'] },
  };
  const view = meetingCosineInputs(input);
  assert.deepEqual(view.participants[0]?.history, []);
  assert.equal(JSON.stringify(view).includes('FORBIDDEN_LABEL'), false);
});
