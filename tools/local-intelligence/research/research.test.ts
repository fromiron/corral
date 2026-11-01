import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertTeacher,
  assignSplit,
  renderCandidateHistory,
  renderEffort,
  renderMeeting,
} from './data.ts';
import { assignGroups } from './group-splits.ts';
import { permuteCanonicalRoster, permuteMeeting, remapTarget } from './permutation.ts';
import { completedTeacherJson } from './teacher-result.ts';

test('roster-order stress uses the same compact IDs as the production formatter', () => {
  const input = {
    participants: [
      { id: 'p1', name: 'Owner', role: '' },
      { id: 'p2', name: 'Observer', role: '' },
    ],
    turns: [{ id: 't1', speakerId: 'p1', text: 'p1 proposed the red lantern.' }],
    message: 'Ask the original proposer.',
  };
  const changed = permuteCanonicalRoster(input, [1, 0]);
  assert.deepEqual(
    changed.input.participants.map((p) => p.id),
    ['p1', 'p2'],
  );
  assert.equal(changed.input.participants[1]!.name, 'Owner');
  assert.equal(changed.input.turns[0]!.speakerId, 'p2');
  assert.equal(changed.remap('p1'), 'p2');
  assert.match(changed.input.turns[0]!.text, /p2 proposed/);
  assert.equal(input.turns[0]!.speakerId, 'p1');
});

test('identity and roster changes preserve proposal ownership, exclusions and reply links', () => {
  const scene = {
    participants: [
      { id: 'p1', name: '아람', role: '' },
      { id: 'p2', name: '보람', role: '' },
    ],
    message: 'p1이 제안한 붉은 등불을 설명해 줘. 보람은 제외.',
    turns: [
      { id: 't1', speakerId: 'p1', text: '붉은 등불을 제안합니다' },
      { id: 't2', speakerId: 'p2', text: 'p1 의견에 동의해요', replyTo: 't1' },
    ],
  };
  const changed = permuteMeeting(scene, ['p2', 'p1'], [1, 0]);
  const label = remapTarget(
    { mode: 'one', eligibleIds: ['p1'], excludedIds: ['p2'] },
    changed.remap,
  );
  assert.deepEqual(label.eligibleIds, ['p2']);
  assert.deepEqual(label.excludedIds, ['p1']);
  assert.equal(changed.input.participants[1]!.name, '아람');
  assert.equal(changed.input.turns[0]!.speakerId, label.eligibleIds[0]);
  assert.equal(changed.input.turns[1]!.replyTo, 't1');
  assert.match(changed.input.turns[1]!.text, /p2 의견/);
  assert.throws(() => permuteMeeting(scene, ['p1', 'p1'], [0, 1]));
});

test('a duplicate arriving in another split cannot move exposed training data into holdout', () => {
  const groups = Array.from({ length: 1000 }, (_, i) => `source-${i}`);
  const fit = groups.find((g) => assignSplit(g) === 'fit')!;
  const holdout = groups.find((g) => assignSplit(g) === 'final')!;
  const initial = assignGroups([{ group: fit, fingerprint: 'shared' }]);
  assert.equal(initial.get(fit)?.split, 'fit');
  const expanded = assignGroups([
    { group: fit, fingerprint: 'shared' },
    { group: holdout, fingerprint: 'shared' },
    { group: holdout, fingerprint: 'another-turn-in-same-conversation' },
  ]);
  assert.equal(expanded.get(fit)?.split, null);
  assert.equal(expanded.get(holdout)?.split, null);
  assert.equal(expanded.get(fit)?.group, expanded.get(holdout)?.group);
});

test('a provider stop flag cannot approve a truncated JSON or an exhausted output budget', () => {
  assert.throws(() =>
    completedTeacherJson(
      { choices: [{ finish_reason: 'stop', message: { content: '{"labels":[' } }] },
      100,
    ),
  );
  assert.throws(() =>
    completedTeacherJson(
      {
        choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
        usage: { completion_tokens: 100 },
      },
      100,
    ),
  );
  assert.equal(
    completedTeacherJson(
      {
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
        usage: { completion_tokens: 10 },
      },
      100,
    ),
    '{"ok":true}',
  );
});

test('teachers cannot silently use automatic, missing or medium reasoning', () => {
  for (const effort of [undefined, 'auto', 'low', 'medium']) {
    assert.throws(() => assertTeacher({ model: 'gpt-6.1-sol', effort }));
  }
  assert.doesNotThrow(() => assertTeacher({ model: 'gpt-6.1-sol', effort: 'high' }));
  assert.doesNotThrow(() => assertTeacher({ model: 'deepseek', effort: 'max' }));
});

test('all variants of one conversation remain in one split', () => {
  const group = 'conversation-unchanged';
  assert.equal(assignSplit(group), assignSplit(group));
  assert.equal(new Set(Array.from({ length: 100 }, () => assignSplit(group))).size, 1);
  assert.equal(new Set(Array.from({ length: 1000 }, (_, i) => assignSplit(`group-${i}`))).size, 4);
});

test('effort representation retains the request tail, tool status and middle evidence', () => {
  const base = {
    goal: 'Repair test',
    request: `${'context '.repeat(250)}fix only the typo`,
    stage: 'step',
    tools: [{ name: 'test', status: 'error', content: `${'a'.repeat(400)}FAIL${'b'.repeat(200)}` }],
  };
  const text = renderEffort(base);
  assert.match(text, /fix only the typo/);
  assert.match(text, /FAIL/);
  assert.match(text, /error/);
  assert.notEqual(
    text,
    renderEffort({ ...base, request: `${'context '.repeat(250)}redesign recovery` }),
  );
  assert.notEqual(
    text,
    renderEffort({ ...base, tools: [{ ...base.tools[0]!, status: 'success' }] }),
  );
});

test('meeting representation preserves earlier ownership and participant identity', () => {
  const participants = [
    { id: 'a', name: '아람', role: '' },
    { id: 'b', name: '보람', role: '' },
  ];
  const before = {
    participants,
    message: '붉은 등불을 제안한 사람이 설명해 줘',
    turns: [
      { id: 't1', speakerId: 'a', text: '붉은 등불을 제안합니다' },
      { id: 't2', speakerId: 'b', text: '푸른 장식을 제안합니다' },
      { id: 't3', speakerId: 'a', text: '확인했습니다' },
      { id: 't4', speakerId: 'b', text: '동의합니다' },
    ],
  };
  const after = {
    ...before,
    turns: before.turns.map((t, i) =>
      i < 2 ? { ...t, speakerId: t.speakerId === 'a' ? 'b' : 'a' } : t,
    ),
  };
  assert.notEqual(renderMeeting(before), renderMeeting(after));
  assert.match(renderMeeting(before), /아람/);
  assert.match(renderMeeting(before), /붉은 등불을 제안합니다/);
  assert.notEqual(renderMeeting(before, 'a'), renderMeeting(before, 'b'));
  const candidate = renderCandidateHistory(before, 'a');
  assert.match(candidate, /붉은 등불을 제안합니다/);
  assert.match(candidate, /확인했습니다/);
  assert.doesNotMatch(candidate, /푸른 장식을 제안합니다/);
  assert.match(candidate, /Current user message: 붉은 등불을 제안한 사람이 설명해 줘/);
});
