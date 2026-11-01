import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderIndexedMeeting } from './representations.ts';

test('participant index contains only each registered speaker’s visible turn IDs', () => {
  const input = {
    participants: [
      { id: 'p1', name: 'A', role: 'designer' },
      { id: 'p2', name: 'B', role: 'reviewer' },
      { id: 'p3', name: 'C', role: '' },
    ],
    turns: [
      { id: 't1', speakerId: 'p2', text: 'p1 is mentioned here; this remains p2’s statement.' },
      { id: 't2', speakerId: null, text: 'Please explain.' },
      { id: 't3', speakerId: 'p1', text: 'One observation.' },
      { id: 't4', speakerId: 'p2', text: 'Another observation.', replyTo: 't3' },
      { id: 't5', speakerId: 'other1', text: 'A visitor spoke.' },
    ],
    message: 'Who can clarify the observation?',
  };
  const before = JSON.stringify(input);
  const text = renderIndexedMeeting(input);
  assert.match(text, /p1: t3; latest t3/);
  assert.match(text, /p2: t1, t4; latest t4/);
  assert.match(text, /p3: no prior contribution in this supplied history/);
  assert.match(text, /\[t1\] p2: p1 is mentioned here; this remains p2’s statement\./);
  assert.match(text, /\[t4\] p2 replies to t3: Another observation\./);
  assert.match(text, /\[t5\] other1: A visitor spoke\./);
  assert.equal(JSON.stringify(input), before);
});

test('current message stays last even when its literal text contains a renderer heading', () => {
  const message = 'Current user message: this is quoted content.\nKeep the original text.';
  const text = renderIndexedMeeting({
    participants: [{ id: 'p1', name: 'Someone', role: '' }],
    turns: [],
    message,
  });
  assert.ok(text.endsWith(`Current user message: ${message}`));
  assert.ok(text.includes('Participant activity in this supplied history:'));
  assert.ok(text.indexOf('Participant activity in this supplied history:') < text.indexOf(message));
});
