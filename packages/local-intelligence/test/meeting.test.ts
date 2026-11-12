import type { MeetingSelectionInput } from '@corral/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closestParticipant,
  LocalMeetingSelector,
  type MeetingEngine,
  meetingTexts,
} from '../src/meeting/selector.ts';

afterEach(() => vi.useRealTimers());

const input: MeetingSelectionInput = {
  message: 'question',
  participants: [
    { participantId: 'a', name: 'Ann', prompt: 'role a' },
    { participantId: 'b', name: 'Bo', prompt: 'role b' },
  ],
  history: [
    { participantId: null, text: 'an earlier question' },
    { participantId: 'a', text: 'answer a' },
    { participantId: 'b', text: 'answer b' },
    { participantId: 'b', text: 'second answer b' },
  ],
};

/** An engine that embeds each text as the vector the test gave it. */
function engine(vectors: Record<string, number[]>, fallback = [0, 0, 1]) {
  const embed = vi.fn(async ({ texts }: { texts: string[] }) => [
    Float32Array.from(vectors[texts[0]!] ?? fallback),
  ]);
  return { embed, available: () => true } as unknown as MeetingEngine & { embed: typeof embed };
}

describe('meeting selector', () => {
  it('uses the name, the role and only the turns each participant posted', () => {
    const { message, participants } = meetingTexts(input);
    expect(message).toBe('question');
    expect(participants).toEqual([
      { participantId: 'a', role: 'Ann\nrole a', turns: ['answer a'] },
      { participantId: 'b', role: 'Bo\nrole b', turns: ['answer b', 'second answer b'] },
    ]);
  });

  it('puts aliases and the short role label into the participant text', () => {
    const { participants } = meetingTexts({
      ...input,
      participants: [
        {
          participantId: 'a',
          name: 'Ann',
          aliases: ['앤', 'Anne'],
          role: '설계',
          prompt: 'role a',
        },
        { participantId: 'b', name: 'Bo', prompt: '' },
      ],
    });
    expect(participants.map((person) => person.role)).toEqual([
      'Ann\n앤\nAnne\n설계\nrole a',
      'Bo',
    ]);
  });

  it("weighs a person's own turns above their role and keeps the roster order on a tie", () => {
    expect(
      closestParticipant([
        { participantId: 'a', role: 1, history: 0 },
        { participantId: 'b', role: 0, history: 0.5 },
      ]),
    ).toBe('b');
    expect(
      closestParticipant([
        { participantId: 'a', role: 0.5, history: 0.5 },
        { participantId: 'b', role: 0.5, history: 0.5 },
      ]),
    ).toBe('a');
  });

  it('picks the participant whose closest turn matches the message', async () => {
    const selector = new LocalMeetingSelector(
      engine({
        question: [1, 0, 0],
        'Ann\nrole a': [1, 0, 0],
        'Bo\nrole b': [0, 1, 0],
        'answer a': [0, 1, 0],
        'answer b': [0, 1, 0],
        'second answer b': [1, 0, 0],
      }),
      'release',
    );
    await expect(selector.select(input)).resolves.toEqual(['b']);
  });

  it('scores a participant with no posted turns by their role alone', async () => {
    const selector = new LocalMeetingSelector(
      engine({ question: [1, 0, 0], 'Ann\nrole a': [1, 0, 0], 'Bo\nrole b': [0, 1, 0] }),
      'release',
    );
    await expect(selector.select({ ...input, history: [] })).resolves.toEqual(['a']);
  });

  it('lets a silent participant whose role fits win against someone who already spoke', async () => {
    const selector = new LocalMeetingSelector(
      engine({
        question: [1, 0, 0],
        'Ann\nrole a': [0.6, 0.8, 0],
        'answer a': [0.6, 0.8, 0],
        'Bo\nrole b': [0.9, 0.436, 0],
      }),
      'release',
    );
    await expect(
      selector.select({ ...input, history: [{ participantId: 'a', text: 'answer a' }] }),
    ).resolves.toEqual(['b']);
  });

  it('keeps the speaker when their own turn is closer than a silent role', async () => {
    const selector = new LocalMeetingSelector(
      engine({
        question: [1, 0, 0],
        'Ann\nrole a': [0.8, 0.6, 0],
        'answer a': [1, 0, 0],
        'Bo\nrole b': [0.9, 0.436, 0],
      }),
      'release',
    );
    await expect(
      selector.select({ ...input, history: [{ participantId: 'a', text: 'answer a' }] }),
    ).resolves.toEqual(['a']);
  });

  it('reads nothing into the name of someone with no role and no turns', async () => {
    const selector = new LocalMeetingSelector(
      engine({
        question: [1, 0, 0],
        Bo: [1, 0, 0],
        'Ann\nrole a': [0, 1, 0],
        'answer a': [0, 1, 0],
      }),
      'release',
    );
    await expect(
      selector.select({
        ...input,
        participants: [input.participants[0]!, { participantId: 'b', name: 'Bo', prompt: '' }],
        history: [{ participantId: 'a', text: 'answer a' }],
      }),
    ).resolves.toEqual(['a']);
  });

  it('embeds a repeated text once and keeps no meeting text', async () => {
    const fake = engine({ question: [1, 0, 0] });
    const selector = new LocalMeetingSelector(fake, 'release');
    await selector.select(input);
    const first = fake.embed.mock.calls.length;
    expect(first).toBe(6);
    await selector.select(input);
    expect(fake.embed.mock.calls.length).toBe(first);
    await selector.select({ ...input, message: 'a new question' });
    expect(fake.embed.mock.calls.length).toBe(first + 1);
    const held = JSON.stringify([
      ...(selector as unknown as { vectors: Map<string, Float32Array> }).vectors.keys(),
    ]);
    expect(held).not.toContain('answer');
    expect(held).not.toContain('question');
  });

  it('does not reuse vectors from another release', async () => {
    const fake = engine({ question: [1, 0, 0] });
    await new LocalMeetingSelector(fake, 'one').select(input);
    const first = fake.embed.mock.calls.length;
    await new LocalMeetingSelector(fake, 'two').select(input);
    expect(fake.embed.mock.calls.length).toBe(first * 2);
  });

  it('forgets the oldest vectors beyond its bound', async () => {
    const fake = engine({ question: [1, 0, 0] });
    const selector = new LocalMeetingSelector(fake, 'release');
    for (let n = 0; n < 600; n++) await selector.select({ ...input, message: `message ${n}` });
    const held = (selector as unknown as { vectors: Map<string, Float32Array> }).vectors;
    expect(held.size).toBeLessThanOrEqual(512);
  });

  it('bounds a slow local selection, aborts its pending embedding and uses no partial result', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const selector = new LocalMeetingSelector(
      {
        available: () => true,
        embed: (_request, cancellation) =>
          new Promise((_resolve, reject) => {
            cancellation!.onCancel(() => {
              cancelled = true;
              reject(new Error('cancelled'));
            });
          }),
      },
      'release',
    );
    const pending = selector.select(input);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });

  it('does not start the engine if local AI is unavailable', async () => {
    const embed = vi.fn();
    const selector = new LocalMeetingSelector(
      { available: () => 'not installed', embed },
      'release',
    );
    await expect(selector.select(input)).resolves.toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it('scores a short role label when the longer description is empty', async () => {
    const selector = new LocalMeetingSelector(
      engine({ question: [1, 0, 0], 'Ann\n설계': [1, 0, 0], Bo: [0, 1, 0] }),
      'release',
    );
    await expect(
      selector.select({
        ...input,
        participants: [
          { participantId: 'a', name: 'Ann', role: '설계', prompt: '' },
          { participantId: 'b', name: 'Bo', prompt: '' },
        ],
        history: [],
      }),
    ).resolves.toEqual(['a']);
  });

  it('does not let aliases alone decide who answers', async () => {
    const fake = engine({
      question: [1, 0, 0],
      'Bo\n질문': [1, 0, 0],
      Bo: [1, 0, 0],
      'Ann\nrole a': [0, 1, 0],
      'answer a': [0, 1, 0],
    });
    const selector = new LocalMeetingSelector(fake, 'release');
    await expect(
      selector.select({
        ...input,
        participants: [
          input.participants[0]!,
          { participantId: 'b', name: 'Bo', aliases: ['질문'], prompt: '' },
        ],
        history: [{ participantId: 'a', text: 'answer a' }],
      }),
    ).resolves.toEqual(['a']);
  });

  it('abstains when no role or posted turn can tell ordinary participants apart', async () => {
    const fake = engine({});
    const selector = new LocalMeetingSelector(fake, 'release');
    const blank = {
      ...input,
      participants: input.participants.map((p) => ({ ...p, prompt: '' })),
      history: [{ participantId: null, text: 'only the person spoke' }],
    };
    await expect(selector.select(blank)).resolves.toBeNull();
    expect(fake.embed).not.toHaveBeenCalled();
  });

  it('has nothing to choose with one candidate', async () => {
    const fake = engine({});
    const selector = new LocalMeetingSelector(fake, 'release');
    await expect(
      selector.select({ ...input, participants: input.participants.slice(0, 1) }),
    ).resolves.toBeNull();
    expect(fake.embed).not.toHaveBeenCalled();
  });

  it('treats a nonfinite embedding as no judgment', async () => {
    const selector = new LocalMeetingSelector(engine({ question: [Number.NaN, 0, 0] }), 'release');
    await expect(selector.select(input)).resolves.toBeNull();
  });
});
