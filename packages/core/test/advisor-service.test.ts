import { describe, expect, it } from 'vitest';
import {
  type AdvisorAction,
  type AdvisorSchedule,
  advisorSchedule,
  advisorsSettled,
  onAdvisorStopped,
  onExecutionEnded,
  onFlowEnded,
  onModelFinished,
  onReviewEnded,
} from '../src/advisor/service.ts';

// The advisor's review schedule (docs/specs/features/advisor.md, 계약), as a table of steps.

type Input =
  | ['call', string, string]
  | ['uncounted', string, string]
  | ['ended', string, string]
  | ['reviewed', string]
  | ['stopped', string]
  | ['flow'];

function play(start: AdvisorSchedule, inputs: Input[]) {
  let state = start;
  const actions: AdvisorAction[][] = [];
  for (const input of inputs) {
    const step =
      input[0] === 'call'
        ? onModelFinished(state, { nodeId: input[1], executionId: input[2], counts: true })
        : input[0] === 'uncounted'
          ? onModelFinished(state, { nodeId: input[1], executionId: input[2], counts: false })
          : input[0] === 'ended'
            ? onExecutionEnded(state, { nodeId: input[1], executionId: input[2] })
            : input[0] === 'reviewed'
              ? onReviewEnded(state, input[1])
              : input[0] === 'stopped'
                ? onAdvisorStopped(state, input[1])
                : onFlowEnded(state);
    state = step.state;
    actions.push(step.actions);
  }
  return { state, actions };
}

const one = (interval = 3) =>
  advisorSchedule({
    adv: {
      nodeId: 'adv',
      roleId: 'r',
      review: { interval, maxRequestsPerReview: 8 },
      watches: ['w', 'x'],
    },
  });
const review = (executionId: string): AdvisorAction => ({
  kind: 'review',
  advisorNodeId: 'adv',
  executionId,
});
const finish: AdvisorAction = { kind: 'finish', advisorNodeId: 'adv' };

describe('advisor review schedule', () => {
  it.each<[string, Input[], AdvisorAction[][]]>([
    [
      'a review starts when the interval is reached, not before',
      [
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
      ],
      [[], [], [review('e1')]],
    ],
    [
      'calls that are not answers are not counted',
      [
        ['call', 'w', 'e1'],
        ['uncounted', 'w', 'e1'],
        ['uncounted', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
      ],
      [[], [], [], [], [review('e1')]],
    ],
    [
      'six calls during a review become one next review',
      [
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['reviewed', 'adv'],
        ['reviewed', 'adv'],
      ],
      [[], [], [review('e1')], [], [], [], [], [], [], [review('e1')], []],
    ],
    [
      'two watched executions are reviewed one after the other, in order',
      [
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'x', 'e2'],
        ['call', 'w', 'e1'],
        ['call', 'x', 'e2'],
        ['call', 'x', 'e2'],
        ['reviewed', 'adv'],
        ['reviewed', 'adv'],
      ],
      [[], [], [], [review('e1')], [], [], [review('e2')], []],
    ],
    [
      'counts are kept per execution: a retry starts from zero',
      [
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e2'],
        ['call', 'w', 'e2'],
        ['call', 'w', 'e1'],
      ],
      [[], [], [], [], [review('e1')]],
    ],
    [
      'an ended execution gets one last review',
      [
        ['call', 'w', 'e1'],
        ['ended', 'w', 'e1'],
        ['reviewed', 'adv'],
      ],
      [[], [review('e1')], []],
    ],
    [
      'an execution that ends while its review is queued keeps that one review',
      [
        ['call', 'x', 'e2'],
        ['call', 'x', 'e2'],
        ['call', 'x', 'e2'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['ended', 'w', 'e1'],
        ['reviewed', 'adv'],
        ['reviewed', 'adv'],
      ],
      [[], [], [review('e2')], [], [], [], [], [review('e1')], []],
    ],
    [
      'an execution that ends during its own review is read once more',
      [
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['ended', 'w', 'e1'],
        ['reviewed', 'adv'],
      ],
      [[], [], [review('e1')], [], [review('e1')]],
    ],
    [
      'unwatched nodes are ignored',
      [
        ['call', 'other', 'e9'],
        ['call', 'other', 'e9'],
        ['call', 'other', 'e9'],
        ['ended', 'other', 'e9'],
      ],
      [[], [], [], []],
    ],
    ['the flow ending finishes an idle advisor', [['flow']], [[finish]]],
    [
      'the flow ending waits for the queue and the running review',
      [
        ['call', 'w', 'e1'],
        ['ended', 'w', 'e1'],
        ['call', 'x', 'e2'],
        ['ended', 'x', 'e2'],
        ['flow'],
        ['reviewed', 'adv'],
        ['reviewed', 'adv'],
      ],
      [[], [review('e1')], [], [], [], [review('e2')], [finish]],
    ],
    [
      'a stopped advisor never reviews again and does not hold the end',
      [
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['stopped', 'adv'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['call', 'w', 'e1'],
        ['ended', 'w', 'e1'],
        ['reviewed', 'adv'],
        ['flow'],
      ],
      [[], [], [review('e1')], [], [], [], [], [], [], []],
    ],
  ])('%s', (_name, inputs, expected) => {
    expect(play(one(), inputs).actions).toEqual(expected);
  });

  it('the interval is the advisor’s own', () => {
    expect(
      play(one(1), [
        ['call', 'w', 'e1'],
        ['reviewed', 'adv'],
        ['call', 'w', 'e1'],
      ]).actions,
    ).toEqual([[review('e1')], [], [review('e1')]]);
  });

  it('settles once every advisor finished or stopped', () => {
    const two = advisorSchedule({
      a: {
        nodeId: 'a',
        roleId: 'r',
        review: { interval: 1, maxRequestsPerReview: 8 },
        watches: ['w'],
      },
      b: {
        nodeId: 'b',
        roleId: 'r',
        review: { interval: 1, maxRequestsPerReview: 8 },
        watches: ['w'],
      },
    });
    let state = onModelFinished(two, { nodeId: 'w', executionId: 'e1', counts: true }).state;
    expect(advisorsSettled(state)).toBe(false);
    state = onFlowEnded(state).state;
    expect(advisorsSettled(state)).toBe(false);
    state = onReviewEnded(state, 'a').state;
    expect(advisorsSettled(state)).toBe(false);
    state = onAdvisorStopped(state, 'b').state;
    expect(advisorsSettled(state)).toBe(true);
  });
});
