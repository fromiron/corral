import { describe, expect, it } from 'vitest';
import { MeetingConfig, MeetingState } from '../src/index.ts';

const person = (participantId: string, name: string, aliases?: string[]) => ({
  participantId,
  name,
  prompt: '',
  modelProfile: 'model',
  ...(aliases ? { aliases } : {}),
});
const config = (...participants: (ReturnType<typeof person> & { role?: string })[]) => ({
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
    expect(accepts(config(person('a', 'Luna', ['sol']), person('b', 'Sol')))).toBe(false);
    expect(accepts(config(person('a', 'Luna', [' Sol ']), person('b', 'Sol')))).toBe(false);
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

  it('keeps a saved meeting that has no role label', () => {
    const saved = {
      version: 1,
      participants: [
        { participantId: 'a', name: 'Luna', prompt: 'notes', modelProfile: 'model' },
        { participantId: 'b', name: 'Sol', aliases: ['솔'], prompt: '', modelProfile: 'model' },
      ],
      secretary: { modelProfile: 'model' },
    };
    const parsed = MeetingConfig.safeParse(saved);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.participants[0]).not.toHaveProperty('role');
    expect(parsed.data.participants[1]?.aliases).toEqual(['솔']);
    expect(MeetingState.safeParse({ config: saved, rounds: [], queued: null }).success).toBe(true);
  });

  it('stores an optional short role label', () => {
    const labeled = MeetingConfig.safeParse(
      config({ ...person('a', 'Luna'), role: '  설계  ' }, person('b', 'Sol')),
    );
    expect(labeled.success).toBe(true);
    if (labeled.success) expect(labeled.data.participants[0]?.role).toBe('설계');
    expect(accepts(config({ ...person('a', 'Luna'), role: '' }, person('b', 'Sol')))).toBe(false);
    expect(
      accepts(config({ ...person('a', 'Luna'), role: 'x'.repeat(41) }, person('b', 'Sol'))),
    ).toBe(false);
    expect(
      accepts(
        config({ ...person('a', 'Luna'), role: '검토' }, { ...person('b', 'Sol'), role: '검토' }),
      ),
    ).toBe(true);
  });

  it('are bounded', () => {
    const many = Array.from({ length: 9 }, (_, n) => `alias${n}`);
    expect(accepts(config(person('a', 'Luna', many), person('b', 'Sol')))).toBe(false);
    expect(accepts(config(person('a', 'Luna', ['x'.repeat(41)]), person('b', 'Sol')))).toBe(false);
    expect(accepts(config(person('a', 'Luna', ['  ']), person('b', 'Sol')))).toBe(false);
  });
});
