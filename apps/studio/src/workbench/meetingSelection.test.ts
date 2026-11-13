import { MEETING_SELECTION_REASONS, type MeetingSelection } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { rankedScores, roundMeta } from './meetingSelection.ts';

const names: Record<string, string> = { p1: 'Architect', p2: 'Builder', p3: 'Critic' };
const nameOf = (id: string) => names[id];
const answer = (participantId: string) => ({ participantId });
const round = (
  change: {
    kind?: 'all' | 'mention' | 'rebuttal' | 'secretary';
    participantIds?: string[];
    answers?: { participantId: string }[];
    selection?: MeetingSelection;
  } = {},
) => ({
  kind: 'all' as const,
  participantIds: [] as string[],
  answers: [] as { participantId: string }[],
  ...change,
});

describe('what a person’s message says about who receives it', () => {
  it.each([
    ['explicit', 'composer_recipients'],
    ['explicit', 'saved_recipients'],
    ['mention', 'mention'],
  ] as const)('%s (%s): the receivers by name', (strategy, reason) => {
    expect(
      roundMeta(
        round({
          kind: 'mention',
          participantIds: ['p2', 'p1'],
          answers: [answer('p2'), answer('p1')],
          selection: { strategy, reason } as MeetingSelection,
        }),
        nameOf,
      ),
    ).toEqual({ kind: 'names', names: ['Builder', 'Architect'] });
  });

  it.each([
    ['address', 'addressed'],
    ['selector', 'top_score'],
    ['selector', 'continuity'],
    ['fallback', 'recent_speaker'],
    ['fallback', 'analysis_off'],
  ] as const)(
    '%s (%s) with an answer: Auto, the picked name left to the answer',
    (strategy, reason) => {
      expect(
        roundMeta(
          round({
            participantIds: ['p2'],
            answers: [answer('p2')],
            selection: { strategy, reason } as MeetingSelection,
          }),
          nameOf,
        ),
      ).toEqual({ kind: 'auto' });
    },
  );

  it('nobody answers: No reply, explained only when the meeting picked nobody', () => {
    expect(
      roundMeta(round({ selection: { strategy: 'none', reason: 'no_recipients' } }), nameOf),
    ).toEqual({ kind: 'noReply', explained: false });
    expect(
      roundMeta(round({ selection: { strategy: 'selector', reason: 'no_reply_needed' } }), nameOf),
    ).toEqual({ kind: 'noReply', explained: true });
    expect(
      roundMeta(round({ selection: { strategy: 'fallback', reason: 'nobody_available' } }), nameOf),
    ).toEqual({ kind: 'noReply', explained: true });
  });

  it('a round kept before its selection was: only whom a mention or the secretary was for', () => {
    expect(
      roundMeta(
        round({ kind: 'mention', participantIds: ['p3'], answers: [answer('p3')] }),
        nameOf,
      ),
    ).toEqual({ kind: 'names', names: ['Critic'] });
    expect(
      roundMeta(
        round({ kind: 'secretary', participantIds: ['secretary'], answers: [answer('secretary')] }),
        (id) => (id === 'secretary' ? 'Secretary' : nameOf(id)),
      ),
    ).toEqual({ kind: 'names', names: ['Secretary'] });
    // A general message: the meeting picked, but how was not kept, so nothing is said.
    expect(
      roundMeta(round({ participantIds: ['p1', 'p2'], answers: [answer('p1')] }), nameOf),
    ).toBeNull();
    expect(roundMeta(round(), nameOf)).toBeNull();
  });

  it('a receiver no longer in the meeting is still named, by what the meeting knows', () => {
    expect(
      roundMeta(
        round({
          kind: 'mention',
          participantIds: ['gone'],
          answers: [answer('gone')],
          selection: { strategy: 'mention', reason: 'mention' },
        }),
        (id) => nameOf(id),
      ),
    ).toEqual({ kind: 'names', names: ['gone'] });
  });
});

describe('the selector’s scores, as a ranking', () => {
  it('highest first, the picked marked; ties keep the order they came in', () => {
    expect(
      rankedScores(
        {
          strategy: 'selector',
          reason: 'top_score',
          scores: [
            { participantId: 'p1', score: 0.42 },
            { participantId: 'p2', score: 0.81 },
            { participantId: 'p3', score: 0.42 },
          ],
        },
        ['p2'],
        nameOf,
      ),
    ).toEqual([
      { participantId: 'p2', name: 'Builder', score: 0.81, picked: true },
      { participantId: 'p1', name: 'Architect', score: 0.42, picked: false },
      { participantId: 'p3', name: 'Critic', score: 0.42, picked: false },
    ]);
  });

  it('leaves out scores that are not finite and participants the meeting no longer has', () => {
    expect(
      rankedScores(
        {
          strategy: 'selector',
          reason: 'top_score',
          scores: [
            { participantId: 'p1', score: Number.NaN },
            { participantId: 'gone', score: 0.99 },
            { participantId: 'p2', score: Number.POSITIVE_INFINITY },
            { participantId: 'p3', score: 0.2 },
          ],
        },
        ['p3'],
        nameOf,
      ),
    ).toEqual([{ participantId: 'p3', name: 'Critic', score: 0.2, picked: true }]);
  });

  it('nothing to rank without scores', () => {
    expect(rankedScores({ strategy: 'fallback', reason: 'rotation' }, ['p1'], nameOf)).toEqual([]);
    expect(rankedScores(undefined, ['p1'], nameOf)).toEqual([]);
  });
});

it('every reason a selection may record is worded in English and Korean', () => {
  const reasons = Object.values(MEETING_SELECTION_REASONS).flat();
  for (const [locale, messages] of [
    ['en', en],
    ['ko', ko],
  ] as const) {
    const worded = messages.Meetings.selection.reason as Record<string, string>;
    for (const reason of reasons)
      expect(worded[reason]?.trim(), `${locale} ${reason}`).toBeTruthy();
    // No wording for a code the contract does not have.
    expect(Object.keys(worded).sort(), locale).toEqual([...reasons].sort());
  }
});
