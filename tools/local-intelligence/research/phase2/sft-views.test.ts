import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meetingView, sftRow } from './sft-views.ts';

const input = {
  participants: [
    { id: 'a', name: 'Alpha', role: 'designer' },
    { id: 'alpha', name: 'Beta', role: 'reviewer' },
  ],
  message: 'Take a look at the alphabet.',
  turns: [
    { id: 'long-id-1', speakerId: 'alpha', text: 'a is a literal word.' },
    { id: 'long-id-2', speakerId: 'a', text: 'My note.', replyTo: 'long-id-1' },
  ],
};

test('two meeting views share compact structure and preserve all visible body bytes', () => {
  const before = JSON.stringify(input);
  const timeline = meetingView(input, 'timeline');
  const indexed = meetingView(input, 'participant-index');
  assert.deepEqual(timeline.input, indexed.input);
  assert.match(indexed.text, /p1: t2; latest t2/);
  assert.match(indexed.text, /p2: t1; latest t1/);
  assert.match(indexed.text, /\[t2\] p1 replies to t1: My note\./);
  assert.ok(indexed.text.includes(input.message));
  assert.ok(input.turns[0]);
  assert.ok(indexed.text.includes(input.turns[0].text));
  assert.equal(JSON.stringify(input), before);
});

test('labels are remapped separately from the renderer and NONE remains empty', () => {
  const raw = {
    id: 'case',
    group: 'scene',
    split: 'fit' as const,
    task: 'meeting' as const,
    language: 'en',
    input,
    target: { mode: 'one', eligibleIds: ['alpha'], excludedIds: ['a'] },
  };
  const original = JSON.stringify(raw);
  const one = sftRow(raw, 'synthetic', 'timeline');
  const none = sftRow(
    { ...raw, target: { mode: 'none', eligibleIds: [], excludedIds: [] } },
    'synthetic',
    'timeline',
  );
  assert.deepEqual(one.target.eligibleIds, ['p2']);
  assert.deepEqual(one.target.excludedIds, ['p1']);
  assert.deepEqual(none.target.eligibleIds, []);
  assert.equal(one.text, none.text);
  assert.equal(JSON.stringify(raw), original);
  assert.throws(() =>
    sftRow(
      { ...raw, target: { ...raw.target, eligibleIds: ['unknown'] } },
      'synthetic',
      'timeline',
    ),
  );
});

test('effort text is byte-identical in both views and non-F records are rejected', () => {
  const row = {
    id: 'e',
    group: 'effort-scene',
    task: 'effort' as const,
    split: 'fit' as const,
    language: 'ko',
    text: 'raw\r\n가\n',
    input: {},
    target: { level: 'low' },
  };
  assert.equal(sftRow(row, 'effort', 'timeline').text, row.text);
  assert.equal(sftRow(row, 'effort', 'participant-index').text, row.text);
  assert.throws(() => sftRow({ ...row, split: 'final' }, 'effort', 'timeline'));
});
