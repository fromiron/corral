import type { MeetingSelectionInput } from '@corral/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalMeetingSelector,
  loadMeetingWeights,
  selectMeetingVectors,
} from '../src/meeting/selector.ts';

afterEach(() => vi.useRealTimers());

const raw = {
  schemaVersion: 1,
  version: 'meeting-test',
  dims: 3,
  baseModelSha256: 'a'.repeat(64),
  preprocessVersion: 'meeting-text-v1',
  intent: {
    weights: [
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
      [0, 0, 0],
    ],
    bias: [0, 0, 0, -5],
  },
  rank: { weights: [8, 8, 0, 8, 0, 0], bias: -4 },
  allThreshold: 0.8,
  minimumScore: 0.5,
  minimumMargin: 0.1,
};
const expected = { dims: 3, baseModelSha256: 'a'.repeat(64) };
const input: MeetingSelectionInput = {
  message: 'question',
  participants: [
    { participantId: 'a', prompt: 'role a' },
    { participantId: 'b', prompt: 'role b' },
  ],
  history: [
    { participantId: 'a', text: 'answer a' },
    { participantId: 'b', text: 'answer b' },
  ],
};
const v = (xs: number[][]) => xs.map((x) => Float32Array.from(x));

describe('meeting selector', () => {
  it('bounds a slow local selection and aborts its pending embedding', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const selector = new LocalMeetingSelector(
      {
        available: () => true,
        isReady: () => true,
        warmUp: async () => {},
        embed: (_request, cancellation) =>
          new Promise((_resolve, reject) => {
            cancellation!.onCancel(() => {
              cancelled = true;
              reject(new Error('cancelled'));
            });
          }),
      },
      loadMeetingWeights(raw, expected),
    );
    const pending = selector.select(input);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });

  it('does not start the engine if local AI is unavailable', async () => {
    const embed = vi.fn();
    const selector = new LocalMeetingSelector(
      { available: () => 'not installed', isReady: () => false, warmUp: async () => {}, embed },
      loadMeetingWeights(raw, expected),
    );
    await expect(selector.select(input)).resolves.toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });
  it('uses semantic relevance for a topic and the posted speaker for a follow-up', () => {
    const weights = loadMeetingWeights(raw, expected);
    expect(
      selectMeetingVectors(
        input,
        v([
          [1, 0, 0],
          [1, 0, 0],
          [0, 0, 1],
          [1, 0, 0],
          [0, 0, 1],
        ]),
        weights,
      ),
    ).toEqual(['a']);
    expect(
      selectMeetingVectors(
        input,
        v([
          [0, 1, 0],
          [1, 0, 0],
          [0, 0, 1],
          [1, 0, 0],
          [0, 0, 1],
        ]),
        weights,
      ),
    ).toEqual(['b']);
    expect(
      selectMeetingVectors(
        input,
        v([
          [0, 0, 1],
          [1, 0, 0],
          [0, 0, 1],
          [1, 0, 0],
          [0, 0, 1],
        ]),
        weights,
      ),
    ).toEqual(['a', 'b']);
  });

  it('abstains when no role or posted answer can distinguish ordinary participants', () => {
    const empty = {
      ...input,
      participants: input.participants.map((p) => ({ ...p, prompt: '' })),
      history: [],
    };
    expect(
      selectMeetingVectors(
        empty,
        v([
          [1, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ]),
        loadMeetingWeights(raw, expected),
      ),
    ).toBeNull();
  });

  it('can select two related perspectives without inviting an unrelated participant', () => {
    const group = {
      ...input,
      participants: [...input.participants, { participantId: 'c', prompt: 'unrelated' }],
    };
    const weights = loadMeetingWeights({ ...raw, rank: { ...raw.rank, bias: -2 } }, expected);
    expect(
      selectMeetingVectors(
        group,
        v([
          [1, 0, 0],
          [1, 0, 0],
          [1, 0, 0],
          [0, 0, 1],
          [1, 0, 0],
          [1, 0, 0],
          [0, 0, 0],
        ]),
        weights,
      )?.toSorted(),
    ).toEqual(['a', 'b']);
  });

  it('rejects mismatched, nonfinite or malformed weights and vectors', () => {
    expect(() => loadMeetingWeights(raw, { ...expected, dims: 768 })).toThrow();
    expect(() =>
      loadMeetingWeights({ ...raw, rank: { weights: [NaN], bias: 0 } }, expected),
    ).toThrow();
    expect(() =>
      selectMeetingVectors(input, v([[1, 0, 0]]), loadMeetingWeights(raw, expected)),
    ).toThrow();
  });
});
