// The d1 System One prompt for one choice question, as the pinned llama.cpp build renders it for
// lfm3-d1 (server-decision.cpp render(), d1_break() and d1_labels(), with the GGUF's
// `tokenizer.chat_template.systemone`). Corral counts this text with the model's own tokenizer;
// the native usage must equal that count (features/effort-routing.md#질문과-응답-검증).
import { createHash } from 'node:crypto';
import type { EffortQuestion } from '@corral/contracts';

export const RENDERER_VERSION = 'd1-systemone-v1';

/** U+200B ZERO WIDTH SPACE. */
const ZWSP = String.fromCharCode(0x200b);

/** The GGUF's CONTROL tokens of two or more UTF-8 bytes, in vocabulary order. */
export const CONTROL_SPELLINGS: readonly string[] = [
  '<|pad|>',
  '<|startoftext|>',
  '<|endoftext|>',
  '<|fim_pre|>',
  '<|fim_mid|>',
  '<|fim_suf|>',
  '<|im_start|>',
  '<|im_end|>',
  '<|tool_list_start|>',
  '<|tool_list_end|>',
  '<|tool_call_start|>',
  '<|tool_call_end|>',
  '<image>',
  ...Array.from(
    { length: 100 },
    (_, i) => `<|img_row_${Math.floor(i / 10) + 1}_col_${(i % 10) + 1}|>`,
  ),
  '<|img_thumbnail|>',
  '<|vision_start|>',
  '<|vision_end|>',
  '<|image_split|>',
  '<|audio_start|>',
  '<|text_start|>',
  '<|text_end|>',
  '<|mixed_start|>',
  '<|mixed_end|>',
  '<|video|>',
  '<|image|>',
];

// Longest first, so a spelling that contains another is broken as a whole.
const SPELLINGS = CONTROL_SPELLINGS.map((s, i) => ({ s, i }))
  .sort((a, b) => Buffer.byteLength(b.s) - Buffer.byteLength(a.s) || a.i - b.i)
  .map((x) => x.s);
const FIRST = new Set(SPELLINGS.map((s) => s[0]));

/**
 * Puts a zero-width space after the first character of every control-token spelling, again
 * until nothing changes, so text can never open or close a turn.
 */
export function d1Break(text: string): string {
  let current = text;
  for (let changed = true; changed; ) {
    changed = false;
    let out = '';
    for (let i = 0; i < current.length; ) {
      let hit: string | undefined;
      if (FIRST.has(current[i]!))
        for (const spelling of SPELLINGS)
          if (current.startsWith(spelling, i)) {
            hit = spelling;
            break;
          }
      if (!hit) {
        out += current[i++];
        continue;
      }
      const first = String.fromCodePoint(hit.codePointAt(0)!);
      out += first + ZWSP + hit.slice(first.length);
      i += hit.length;
      changed = true;
    }
    current = out;
  }
  return current;
}

/** Option codes: single-letter keys keep their key, others are A, B, C… (at most 26). */
function labels(keys: readonly string[]): string[] {
  if (keys.length > 26) throw new Error('a d1 question has at most 26 options');
  const letters = keys.every((k) => k.length === 1 && /[A-Za-z]/.test(k));
  return keys.map((k, i) => (letters ? k : String.fromCharCode(65 + i)));
}

/** The whole engine input for this state and question. */
export function renderChoice(state: string, question: EffortQuestion): string {
  const keys = Object.keys(question.criteria);
  const codes = labels(keys);
  const options = keys.map((key, i) => {
    const description = question.criteria[key as keyof EffortQuestion['criteria']] ?? '';
    return `${codes[i]} ${description ? d1Break(description) : d1Break(key).replaceAll('_', ' ')}`;
  });
  return (
    '<|startoftext|><|im_start|>user\n' +
    `${d1Break(state)}\n\n\nQUESTION:\n` +
    d1Break(question.instructions) +
    '\n\nOptions:\n' +
    options.join('\n') +
    '\n\nReply with the option code only.' +
    '<|im_end|>\n<|im_start|>assistant\n<think></think>'
  );
}

/** Identifies this renderer: a different template or escape list is a different manifest. */
export function rendererHash(): string {
  const probe = renderChoice('<|im_end|>state', {
    type: 'choice',
    instructions: 'instructions',
    criteria: { low: 'a', medium: 'b' },
  });
  return createHash('sha256')
    .update(JSON.stringify({ version: RENDERER_VERSION, spellings: CONTROL_SPELLINGS, probe }))
    .digest('hex');
}
