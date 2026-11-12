import { describe, expect, it } from 'vitest';
import { fallbackSpeaker, type MeetingPolicy, selectSpeakers } from '../src/meeting-policy.ts';

const roster = ['architect', 'builder', 'tester'];
const policy: MeetingPolicy = { needsReplyThreshold: 0.5 };
const fallback = { participantId: 'architect', reason: 'Rotation.' };

describe('meeting selection policy', () => {
  it('chooses the single highest score', () => {
    const choice = selectSpeakers(
      roster,
      {
        scores: [
          { participantId: 'architect', score: 0.2 },
          { participantId: 'tester', score: 0.7 },
          { participantId: 'builder', score: 0.4 },
        ],
      },
      policy,
      { continuityId: null, fallback },
    );
    expect(choice).toMatchObject({ strategy: 'selector', participantIds: ['tester'] });
    expect(choice.scores).toEqual([
      { participantId: 'architect', score: 0.2 },
      { participantId: 'tester', score: 0.7 },
      { participantId: 'builder', score: 0.4 },
    ]);
  });

  it('breaks a tie by roster order, not by the order of the scores', () => {
    const choice = selectSpeakers(
      roster,
      {
        scores: [
          { participantId: 'tester', score: 0.5 },
          { participantId: 'builder', score: 0.5 },
        ],
      },
      policy,
      { continuityId: null, fallback },
    );
    expect(choice.participantIds).toEqual(['builder']);
  });

  it('drops IDs outside the candidates and the secretary', () => {
    const choice = selectSpeakers(
      ['architect', 'builder'],
      {
        scores: [
          { participantId: 'foreign', score: 9 },
          { participantId: 'secretary', score: 8 },
          { participantId: 'tester', score: 7 },
          { participantId: 'builder', score: 0.1 },
        ],
      },
      policy,
      { continuityId: null, fallback },
    );
    expect(choice).toMatchObject({
      strategy: 'selector',
      participantIds: ['builder'],
      scores: [{ participantId: 'builder', score: 0.1 }],
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'drops a nonfinite score %s',
    (bad) => {
      const choice = selectSpeakers(
        roster,
        {
          scores: [
            { participantId: 'tester', score: bad },
            { participantId: 'architect', score: -0.3 },
          ],
        },
        policy,
        { continuityId: null, fallback },
      );
      expect(choice).toMatchObject({
        strategy: 'selector',
        participantIds: ['architect'],
        scores: [{ participantId: 'architect', score: -0.3 }],
      });
    },
  );

  it('drops a participant scored more than once', () => {
    const choice = selectSpeakers(
      roster,
      {
        scores: [
          { participantId: 'tester', score: 0.9 },
          { participantId: 'tester', score: 0.1 },
          { participantId: 'builder', score: 0.2 },
        ],
      },
      policy,
      { continuityId: null, fallback },
    );
    expect(choice.participantIds).toEqual(['builder']);
  });

  it.each([
    ['no result', null],
    ['no scores', { scores: [] }],
    ['only unusable scores', { scores: [{ participantId: 'foreign', score: 1 }] }],
  ])('uses the fallback rule when there is %s', (_label, result) => {
    expect(selectSpeakers(roster, result, policy, { continuityId: 'tester', fallback })).toEqual({
      strategy: 'fallback',
      participantIds: ['architect'],
      reason: 'Rotation.',
    });
  });

  it('chooses nobody when needsReply is below the threshold', () => {
    const choice = selectSpeakers(
      roster,
      { scores: [{ participantId: 'tester', score: 0.9 }], needsReply: 0.2 },
      policy,
      { continuityId: null, fallback },
    );
    expect(choice).toMatchObject({ strategy: 'selector', participantIds: [] });
    expect(choice.scores).toEqual([{ participantId: 'tester', score: 0.9 }]);
  });

  it('keeps the previous speaker continuing even below the threshold', () => {
    const scores = [
      { participantId: 'builder', score: 0.8 },
      { participantId: 'tester', score: 0.3 },
    ];
    expect(
      selectSpeakers(roster, { scores, needsReply: 0.1 }, policy, {
        continuityId: 'builder',
        fallback,
      }).participantIds,
    ).toEqual(['builder']);
    // Another participant would have been chosen: continuity does not override the threshold.
    expect(
      selectSpeakers(roster, { scores, needsReply: 0.1 }, policy, {
        continuityId: 'tester',
        fallback,
      }).participantIds,
    ).toEqual([]);
  });

  it('replies at or above the threshold, and treats an unusable needsReply as absent', () => {
    const scores = [{ participantId: 'tester', score: 0.9 }];
    for (const needsReply of [0.5, 0.9, Number.NaN, Number.POSITIVE_INFINITY])
      expect(
        selectSpeakers(roster, { scores, needsReply }, policy, { continuityId: null, fallback })
          .participantIds,
      ).toEqual(['tester']);
  });

  it('without needsReply always chooses one participant, whatever the scores', () => {
    for (const score of [-1, 0, 0.0001])
      expect(
        selectSpeakers(roster, { scores: [{ participantId: 'builder', score }] }, policy, {
          continuityId: null,
          fallback,
        }).participantIds,
      ).toEqual(['builder']);
  });

  it('reads the threshold from the policy it is given', () => {
    const result = { scores: [{ participantId: 'tester', score: 0.9 }], needsReply: 0.3 };
    const options = { continuityId: null, fallback };
    expect(
      selectSpeakers(roster, result, { needsReplyThreshold: 0.2 }, options).participantIds,
    ).toEqual(['tester']);
    expect(
      selectSpeakers(roster, result, { needsReplyThreshold: 0.4 }, options).participantIds,
    ).toEqual([]);
  });
});

describe('meeting fallback speaker', () => {
  it('prefers the reply target, then the recent speaker, then rotation', () => {
    expect(
      fallbackSpeaker(roster, { replyTo: 'tester', recent: 'builder', turn: 0 }).participantId,
    ).toBe('tester');
    expect(
      fallbackSpeaker(roster, { replyTo: 'foreign', recent: 'builder', turn: 0 }).participantId,
    ).toBe('builder');
    expect(fallbackSpeaker(roster, { replyTo: null, recent: null, turn: 4 }).participantId).toBe(
      'builder',
    );
  });

  it('never falls back to the secretary and has nobody when nobody is allowed', () => {
    expect(
      fallbackSpeaker(['secretary', 'tester'], { replyTo: 'secretary', recent: null, turn: 0 })
        .participantId,
    ).toBe('tester');
    expect(
      fallbackSpeaker(['secretary'], { replyTo: null, recent: null, turn: 0 }).participantId,
    ).toBeNull();
  });
});
