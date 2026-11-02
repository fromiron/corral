import { describe, expect, it } from 'vitest';
import { MeetingConfig } from '../src/index.ts';

const person = (participantId: string, name: string, aliases?: string[]) => ({
  participantId,
  name,
  prompt: '',
  modelProfile: 'model',
  ...(aliases ? { aliases } : {}),
});
const config = (...participants: ReturnType<typeof person>[]) => ({
  version: 1,
  participants,
  secretary: { modelProfile: 'model' },
});
const accepts = (value: unknown) => MeetingConfig.safeParse(value).success;

describe('meeting participant aliases', () => {
  it('are optional, so stored meetings keep parsing', () => {
    expect(accepts(config(person('a', 'Luna'), person('b', 'Sol')))).toBe(true);
    expect(accepts(config(person('a', 'Luna', ['루나', 'moon']), person('b', 'Sol')))).toBe(true);
  });

  it('must point at one participant only', () => {
    expect(accepts(config(person('a', 'Luna', ['Sol']), person('b', 'Sol')))).toBe(false);
    expect(accepts(config(person('a', 'Luna', ['별']), person('b', 'Sol', ['별'])))).toBe(false);
    expect(accepts(config(person('a', 'Luna', ['STAR']), person('b', 'Sol', ['star'])))).toBe(
      false,
    );
    expect(accepts(config(person('a', 'Luna', ['b']), person('b', 'Sol')))).toBe(false);
    expect(accepts(config(person('a', 'Luna', ['루나', '루나']), person('b', 'Sol')))).toBe(false);
  });

  it('cannot name the secretary', () => {
    for (const alias of ['secretary', 'Secretary', '비서'])
      expect(accepts(config(person('a', 'Luna', [alias]), person('b', 'Sol')))).toBe(false);
  });

  it('are bounded', () => {
    const many = Array.from({ length: 9 }, (_, n) => `alias${n}`);
    expect(accepts(config(person('a', 'Luna', many), person('b', 'Sol')))).toBe(false);
    expect(accepts(config(person('a', 'Luna', ['x'.repeat(41)]), person('b', 'Sol')))).toBe(false);
    expect(accepts(config(person('a', 'Luna', ['  ']), person('b', 'Sol')))).toBe(false);
  });
});
