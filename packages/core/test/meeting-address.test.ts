import { describe, expect, it } from 'vitest';
import { readMeetingAddress } from '../src/meeting-address.ts';

const people = [
  { participantId: 'p1', name: 'OpenAI · GPT-6 Luna', aliases: ['루나', 'Luna'] },
  { participantId: 'p2', name: 'OpenAI · GPT-6.1 Sol', aliases: ['솔', 'Sol'] },
  { participantId: 'p3', name: 'Hive · deepseek', aliases: ['딥시크'] },
];

// Message, who it asks, who it rules out.
const CASES: [string, string[], string[]?][] = [
  ['솔직히 말하면 별로야', []],
  ['솔이 말한 메뉴 어때?', []],
  ['솔은 어때?', ['p2']],
  ['루나, 답해줘', ['p1']],
  ['루나야 넌 어때', ['p1']],
  ['솔아', ['p2']],
  ['솔?', ['p2']],
  ['솔 님 의견 주세요', ['p2']],
  ['그럼 루나는?', ['p1']],
  ['루나는 배안고프냐', ['p1']],
  ['솔도배고프냐', ['p2']],
  ['솔이랑 루나랑 스무고개해봐라', ['p1', 'p2']],
  ['솔 불러봐', []],
  ['넌 루나 불러봐', []],
  ['솔이 답해줘', ['p2']],
  ['루나가 대답해봐', ['p1']],
  ['어떻게 생각해, 솔?', ['p2']],
  ['Luna, what do you think?', ['p1']],
  ['Sol and Luna, what do you think?', ['p1', 'p2']],
  ['what do you think, Sol?', ['p2']],
  ['Sol what do you think', ['p2']],
  ['다들 어때?', ['p1', 'p2', 'p3']],
  ['모두 어떻게 생각해?', ['p1', 'p2', 'p3']],
  ['모두 삭제해줘', []],
  ['요즘 다들 AI 쓰더라', []],
  ['각자 의견 줘', ['p1', 'p2', 'p3']],
  ['What does everyone think?', ['p1', 'p2', 'p3']],
  ['솔 말고 답해줘', [], ['p2']],
  ['솔 빼고 다들 어때?', ['p1', 'p3'], ['p2']],
  ['솔은 빼고 루나는 어때?', ['p1'], ['p2']],
  ['솔 말고 루나가 답해줘', ['p1'], ['p2']],
  ['솔이랑 루나 빼고 어때?', [], ['p1', 'p2']],
  ['솔은 답하지 마', [], ['p2']],
  ['everyone except Sol, what do you think?', ['p1', 'p3'], ['p2']],
  ['솔아 어때? 솔은 빼고', [], ['p2']],
  ['루나 말고 나머지는 어때?', ['p2', 'p3'], ['p1']],
  ['셋 다 빼고: 솔, 루나, 딥시크 빼고', [], []],
  ['비서야 정리해줘', []],
  ['secretary, summarize', []],
];

describe('meeting address rules', () => {
  it.each(CASES)('%s', (text, asked, excluded = []) => {
    const address = readMeetingAddress(text, people);
    expect(address.participantIds).toEqual(asked);
    expect(address.excluded.toSorted()).toEqual(excluded);
  });

  it('matches a display name without aliases, whatever its case or punctuation', () => {
    const roster = [
      { participantId: 'a', name: 'GPT-6.1 (Sol)' },
      { participantId: 'b', name: '아키텍트' },
    ];
    expect(readMeetingAddress('gpt-6.1 (sol), 어때?', roster).participantIds).toEqual(['a']);
    expect(readMeetingAddress('아키텍트님 의견 주세요', roster).participantIds).toEqual(['b']);
    expect(readMeetingAddress('GPT-6.1 Sol, 어때?', roster).participantIds).toEqual([]);
  });

  it('prefers the longest name when one contains another', () => {
    const roster = [
      { participantId: 'a', name: '솔' },
      { participantId: 'b', name: '솔라' },
    ];
    expect(readMeetingAddress('솔라야 어때', roster).participantIds).toEqual(['b']);
  });

  it('never addresses the secretary', () => {
    const roster = [...people, { participantId: 'secretary', name: 'x', aliases: [] }];
    expect(readMeetingAddress('비서야 회의록 정리해줘', roster).participantIds).toEqual([]);
  });
});
