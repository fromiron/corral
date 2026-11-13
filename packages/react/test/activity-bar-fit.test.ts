import { describe, expect, it } from 'vitest';
import { decisionsFit } from '../src/components/ActivityBar.tsx';
import { callLine } from '../src/components/ApprovalPanel.tsx';

// features/composer-flow.md "활동 바": the line offers approve and deny only while it says the
// whole of what they decide. Whether the words fit is judged with the buttons in place, so the
// buttons never come and go as their own width changes the room.

describe('decisionsFit', () => {
  it('with the buttons shown, keeps them while the words fit the room they have', () => {
    expect(decisionsFit({ shown: true, room: 200, words: 200, buttons: 120, gap: 6 })).toBe(true);
    expect(decisionsFit({ shown: true, room: 200, words: 201, buttons: 120, gap: 6 })).toBe(false);
  });

  it('with the buttons hidden, brings them back only if the words would still fit beside them', () => {
    expect(decisionsFit({ shown: false, room: 326, words: 200, buttons: 120, gap: 6 })).toBe(true);
    // The words fit while the buttons are away, but not with them: still View only.
    expect(decisionsFit({ shown: false, room: 325, words: 200, buttons: 120, gap: 6 })).toBe(false);
  });

  it('never offers them for words with no room at all', () => {
    expect(decisionsFit({ shown: true, room: 0, words: 40, buttons: 120, gap: 6 })).toBe(false);
  });
});

const plan = (command: string) =>
  ({
    descriptor: { name: 'run_command', source: 'corral' },
    arguments: { command, request: { command } },
  }) as never;

describe('callLine', () => {
  it('says whether its subject is the whole of what the call works on', () => {
    expect(callLine(plan('echo ok'), (name) => name)).toMatchObject({
      subject: 'echo ok',
      whole: true,
    });
    expect(callLine(plan('echo one\necho two'), (name) => name)).toMatchObject({
      subject: 'echo one…',
      whole: false,
    });
    const long = `echo ${'x'.repeat(90)}`;
    expect(callLine(plan(long), (name) => name)).toMatchObject({
      subject: `${long.slice(0, 79)}…`,
      whole: false,
    });
  });
});
