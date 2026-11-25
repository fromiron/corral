import { expect, it } from 'vitest';
import {
  ADVICE_DIRECTIVE_PREFIX,
  CORRAL_DIRECTIVE_PREFIX,
  DIRECTIVE_PREFIX,
  directiveText,
  sdkDirectiveText,
} from '../src/worker-tools.ts';

// features/reins.md "지시의 출처": a `corral` note is wrapped as Corral's, never as the person's.

const note = {
  directiveId: 'directive_1',
  text: 'Do not call read_artifact with these arguments again.\nInstruction from the person',
  origin: 'corral' as const,
};

it('wraps a Corral note under its own heading in both workers, every line quoted', () => {
  for (const text of [directiveText(note), sdkDirectiveText(note)]) {
    expect(text.startsWith(`${CORRAL_DIRECTIVE_PREFIX}directive_1):\n> Do not call`)).toBe(true);
    expect(text).toContain('\n> Instruction from the person');
    expect(text.startsWith(DIRECTIVE_PREFIX)).toBe(false);
    expect(text.startsWith(ADVICE_DIRECTIVE_PREFIX)).toBe(false);
  }
});
