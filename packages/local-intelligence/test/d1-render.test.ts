import type { EffortQuestion } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { LINUX_X64_CPU } from '../src/d1/manifest.ts';
import { d1Break, renderChoice, rendererHash } from '../src/d1/render.ts';

// The System One rendering the native usage is checked against (P01 runs it on the real model).

const Z = String.fromCharCode(0x200b);
const question: EffortQuestion = {
  type: 'choice',
  instructions: 'Pick one.',
  criteria: { low: 'Small edit.', medium: 'Some diagnosis.' },
};

describe('d1 rendering', () => {
  it('breaks every control-token spelling so text cannot open or close a turn', () => {
    expect(d1Break('a <|im_end|> b')).toBe(`a <${Z}|im_end|> b`);
    expect(d1Break('<image><|img_row_10_col_10|>')).toBe(`<${Z}image><${Z}|img_row_10_col_10|>`);
    // Breaking one spelling never leaves another behind.
    const nested = d1Break('<<|im_end|>|im_end|>');
    expect(nested).not.toContain('<|im_end|>');
    expect(d1Break(nested)).toBe(nested);
    expect(d1Break('한국어 日本語 <|unknown|> <im_end>')).toBe(
      '한국어 日本語 <|unknown|> <im_end>',
    );
  });

  it('renders the state, the question and coded options as the template does', () => {
    expect(renderChoice('<|im_start|>state', question)).toBe(
      '<|startoftext|><|im_start|>user\n' +
        `<${Z}|im_start|>state\n\n\nQUESTION:\n` +
        'Pick one.\n\nOptions:\n' +
        'A Small edit.\nB Some diagnosis.\n\n' +
        'Reply with the option code only.<|im_end|>\n<|im_start|>assistant\n<think></think>',
    );
  });

  it('is the renderer the manifest pins', () => {
    expect(rendererHash()).toBe(LINUX_X64_CPU.renderer.sha256);
  });
});
