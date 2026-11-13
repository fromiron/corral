import { type MeetingView, SECRETARY_ID } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { answerLabel, HOLD_LABEL, meetingLine, meetingRows } from './meetingActivity.ts';

// The meeting's activity bar (workbench.md, the meeting's composer): what the closed line says
// and which rows open below it, read from the meeting and from what is on screen.

type Round = MeetingView['rounds'][number];
type Answer = Round['answers'][number];
const answer = (participantId: string, status: Answer['status'], runId?: string): Answer => ({
  participantId,
  runId: runId ?? (status === 'waiting' ? null : `run_${participantId}`),
  status,
  text: status === 'answered' ? 'Yes.' : null,
  detail: null,
  usage: null,
});
const round = (id: string, answers: Answer[], change: Partial<Round> = {}): Round =>
  ({
    roundId: id,
    commandId: `c_${id}`,
    kind: 'all',
    message: `Message ${id}`,
    basedOnRoundId: null,
    rebuttalNo: null,
    participantIds: answers.map((item) => item.participantId),
    createdAt: 'x',
    stoppedAt: null,
    active: answers.some((item) => item.status === 'running' || item.status === 'waiting'),
    answers,
    ...change,
  }) as Round;
const view = (rounds: Round[], change: Partial<MeetingView> = {}) =>
  ({
    sessionId: 'session_1',
    revision: 1,
    config: { version: 1, participants: [], secretary: { modelProfile: 'model-a' } },
    rounds,
    queued: null,
    rebuttal: null,
    ...change,
  }) as MeetingView;
const nothing = { visible: new Set<string>(), open: false };
const seeing = (...labels: string[]) => ({ visible: new Set(labels), open: false });
const hold = { hold: { kind: 'chain' as const, after: 'r1' } };

describe('the closed line', () => {
  it('says nothing in a meeting where nothing ran', () => {
    expect(meetingLine(view([]), nothing)).toBeNull();
  });

  it('a continue card out of view comes first; on screen, the card says it', () => {
    const held = view([round('r1', [answer('p1', 'answered')])], hold);
    expect(meetingLine(held, nothing)).toEqual({ kind: 'hold', waiting: 0 });
    // The card is in view and nothing runs: the line is at rest.
    expect(meetingLine(held, seeing(HOLD_LABEL))).toEqual({
      kind: 'summary',
      answered: 1,
      failed: 0,
    });
  });

  it('a hold with an answer still running: the card first, else who answers out of view', () => {
    const held = view(
      [round('r1', [answer('p1', 'answered'), answer('p2', 'running'), answer('p3', 'waiting')])],
      hold,
    );
    expect(meetingLine(held, nothing)).toEqual({ kind: 'hold', waiting: 1 });
    expect(meetingLine(held, seeing(HOLD_LABEL))).toEqual({
      kind: 'answering',
      participantId: 'p2',
      runId: 'run_p2',
      waiting: 1,
    });
  });

  it('an answer whose row is on screen is not named again', () => {
    const going = view([round('r1', [answer('p2', 'running'), answer('p3', 'waiting')])]);
    expect(meetingLine(going, nothing)).toMatchObject({ kind: 'answering', participantId: 'p2' });
    expect(meetingLine(going, seeing(answerLabel('run_p2')))).toEqual({
      kind: 'busy',
      waiting: 1,
    });
  });

  it('counts the people waiting, not their turns, and not the one already answering', () => {
    const going = view([
      round('r1', [answer('p2', 'running'), answer('p3', 'waiting')]),
      round('r2', [answer('p3', 'waiting'), answer('p2', 'waiting')]),
      round('r3', [answer('p3', 'waiting'), answer('p1', 'waiting')]),
    ]);
    expect(meetingLine(going, nothing)).toMatchObject({ kind: 'answering', waiting: 2 });
    expect(meetingLine(going, seeing(answerLabel('run_p2')))).toEqual({
      kind: 'busy',
      waiting: 2,
    });
  });

  it('open, the rows say who answers and who waits: the line does not', () => {
    const going = view([round('r1', [answer('p2', 'running'), answer('p3', 'waiting')])]);
    expect(meetingLine(going, { visible: new Set(), open: true })).toEqual({
      kind: 'busy',
      waiting: 0,
    });
    // The card out of view is not a row: still said, without the waiting count.
    expect(meetingLine({ ...going, ...hold }, { visible: new Set(), open: true })).toEqual({
      kind: 'hold',
      waiting: 0,
    });
  });

  it('at rest: the last replies and failures; a message for no one is not counted again', () => {
    const rested = view([
      round('r1', [answer('p1', 'answered'), answer('p2', 'failed'), answer('p3', 'stopped')]),
      // Posted for no one: its own line says No reply.
      round('r2', [], { participantIds: [] }),
    ]);
    expect(meetingLine(rested, nothing)).toEqual({ kind: 'summary', answered: 1, failed: 1 });
  });

  it('a round whose answers all failed is summed up by its failures', () => {
    const failed = view([
      round('r1', [answer('p1', 'failed'), answer('p2', 'refused'), answer('p3', 'interrupted')]),
    ]);
    expect(meetingLine(failed, nothing)).toEqual({ kind: 'summary', answered: 0, failed: 3 });
  });

  it('after a stop: at rest, with what was received', () => {
    const stopped = view([
      round('r1', [answer('p1', 'answered'), answer('p2', 'stopped'), answer('p3', 'stopped')], {
        stoppedAt: 'y',
      }),
    ]);
    expect(meetingLine(stopped, nothing)).toEqual({ kind: 'summary', answered: 1, failed: 0 });
  });
});

describe('the rows', () => {
  it('one per participant: the one answering, then those waiting, each once with its turns', () => {
    const going = view([
      round('r1', [answer('p1', 'answered'), answer('p2', 'running')]),
      round('r2', [answer('p3', 'waiting'), answer('p1', 'waiting')]),
      round('r3', [answer('p3', 'waiting'), answer('p2', 'waiting')]),
      round('r4', [answer('p3', 'waiting')]),
    ]);
    expect(meetingRows(going)).toEqual([
      { participantId: 'p2', runId: 'run_p2', waiting: 1 },
      { participantId: 'p3', runId: null, waiting: 3 },
      { participantId: 'p1', runId: null, waiting: 1 },
    ]);
  });

  it('the secretary has its row like anyone', () => {
    expect(meetingRows(view([round('r1', [answer(SECRETARY_ID, 'running')])]))).toEqual([
      { participantId: SECRETARY_ID, runId: `run_${SECRETARY_ID}`, waiting: 0 },
    ]);
  });

  it('none once nothing runs or waits', () => {
    expect(meetingRows(view([round('r1', [answer('p1', 'answered')])]))).toEqual([]);
  });
});
