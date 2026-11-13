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

  it('with the buttons hidden, brings them back only with a pixel to spare beside them', () => {
    expect(decisionsFit({ shown: false, room: 327, words: 200, buttons: 120, gap: 6 })).toBe(true);
    // The words would fit beside them, but with less than a pixel to spare: still View only.
    expect(decisionsFit({ shown: false, room: 326.9, words: 200, buttons: 120, gap: 6 })).toBe(
      false,
    );
    expect(decisionsFit({ shown: false, room: 325, words: 200, buttons: 120, gap: 6 })).toBe(false);
  });

  it('gives one answer at its edge: the room its own answer leaves never turns it back', () => {
    // The words' room with the buttons away, a fraction of a pixel at a time; with them, that
    // room less the buttons and the gap, give or take half a pixel of the layout's rounding.
    const words = 288.88;
    const flips: string[] = [];
    for (const buttons of [146, 146.296875, 146.7, 120.49])
      for (const gap of [6, 8])
        for (let base = words + buttons + gap - 3; base < words + buttons + gap + 3; base += 0.01)
          for (const jitter of [-0.5, -0.2, 0, 0.2, 0.5])
            for (const start of [false, true]) {
              const room = (shown: boolean) => (shown ? base - buttons - gap + jitter : base);
              let shown = start;
              const answers: boolean[] = [];
              for (let pass = 0; pass < 4; pass += 1) {
                shown = decisionsFit({ shown, room: room(shown), words, buttons, gap });
                answers.push(shown);
              }
              if (answers.some((answer) => answer !== answers[0]))
                flips.push(`${buttons} ${gap} ${base.toFixed(2)} ${jitter} ${start}`);
            }
    expect(flips.slice(0, 5)).toEqual([]);
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

// A call as the run asks for it: a command's plan carries the server's resolution of the agent's
// own arguments (`request`); other calls carry the agent's arguments as they are.
const call = (name: string, args: Record<string, unknown>, source = 'corral') =>
  ({ descriptor: { name, source }, arguments: args }) as never;
const resolved = (request: Record<string, unknown>, plan: Record<string, unknown> = {}) =>
  call('run_command', {
    operationId: 'op_1',
    shellId: 'bash',
    command: request.command,
    executable: '/bin/bash',
    argv: ['-c', request.command],
    cwd: '.',
    timeoutMs: 120000,
    launchFingerprint: 'a'.repeat(64),
    fingerprint: 'b'.repeat(64),
    ...plan,
    request,
  });
const line = (plan: never) => callLine(plan, (name) => name);

describe('callLine: decided on the line only when it holds every argument of the call', () => {
  it('a command alone, in the working copy, in the foreground', () => {
    expect(line(resolved({ command: 'npm test' }))).toMatchObject({
      text: 'run_command · npm test',
      whole: true,
    });
    // Named as the default, they are still the default.
    expect(line(resolved({ command: 'npm test', cwd: '.', mode: 'foreground' })).whole).toBe(true);
  });

  it('a command with a folder, a mode, a shell or a timeout of its own says more than its line', () => {
    expect(
      line(resolved({ command: 'rm -rf build', cwd: 'packages/x' }, { cwd: 'packages/x' })),
    ).toMatchObject({ text: 'run_command · rm -rf build', whole: false });
    expect(
      line(resolved({ command: 'rm -rf build', mode: 'service' }, { mode: 'service' })).whole,
    ).toBe(false);
    expect(line(resolved({ command: 'ls', shellId: 'sh' }, { shellId: 'sh' })).whole).toBe(false);
    expect(line(resolved({ command: 'ls', timeoutMs: 5000 }, { timeoutMs: 5000 })).whole).toBe(
      false,
    );
    // The resolution itself is what runs: a folder there that the request did not name is not
    // the default either.
    expect(line(resolved({ command: 'ls' }, { cwd: 'packages/x' })).whole).toBe(false);
    expect(line(resolved({ command: 'ls' }, { mode: 'service' })).whole).toBe(false);
  });

  it('a write or an edit carries what it writes, which no line says', () => {
    expect(
      line(call('write_file', { path: 'src/index.ts', text: 'export const a = 1;\n' })),
    ).toMatchObject({ text: 'write_file · src/index.ts', whole: false });
    expect(line(call('write_file', { path: 'src/index.ts', text: '' })).whole).toBe(false);
    expect(
      line(call('edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] })).whole,
    ).toBe(false);
    expect(line(call('edit_hashline', { path: 'a.ts', ops: '1#ab|x' })).whole).toBe(false);
  });

  it('a move says where from and where to, and is whole only with both on the line', () => {
    expect(line(call('move_file', { from: 'notes.md', to: 'src/index.ts' }))).toMatchObject({
      subject: 'notes.md → src/index.ts',
      text: 'move_file · notes.md → src/index.ts',
      whole: true,
    });
    expect(line(call('move_file', { from: 'notes.md', to: 'archive/notes.md' })).subject).toBe(
      'notes.md → archive/notes.md',
    );
    const far = `deep/${'x'.repeat(70)}.md`;
    expect(line(call('move_file', { from: 'notes.md', to: far })).whole).toBe(false);
  });

  it('a delete or a read names its one file whole', () => {
    expect(line(call('delete_file', { path: 'src/index.ts' }))).toMatchObject({
      text: 'delete_file · src/index.ts',
      whole: true,
    });
    expect(line(call('read', { path: 'README.md' })).whole).toBe(true);
  });

  it('an argument the line does not write, of any tool, leaves View alone', () => {
    expect(line(call('delete_file', { path: 'src/index.ts', recursive: true })).whole).toBe(false);
    expect(line(call('read', { path: 'README.md', offset: 40 })).whole).toBe(false);
    // A tool the line knows nothing of, and one from elsewhere, are never decided there.
    expect(line(call('lookup', { query: 'x' })).whole).toBe(false);
    expect(line(call('search', { path: 'a' }, 'mcp')).whole).toBe(false);
  });

  it.each([
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['a carriage return and line feed', '\r\n'],
    ['a next line', '\u0085'],
    ['a line separator', '\u2028'],
    ['a paragraph separator', '\u2029'],
    ['a vertical tab', '\u000B'],
    ['a form feed', '\u000C'],
  ])('counts a command split by %s as several lines: View alone', (_name, separator) => {
    expect(line(resolved({ command: `echo ok${separator}rm -rf build` })).whole).toBe(false);
    expect(line(resolved({ command: `echo ok${separator}${separator}` })).subject).toBe('echo ok');
    // A command's line break at its end ends no line of its: the shell runs the one line.
    expect(line(resolved({ command: `echo ok${separator}` })).whole).toBe(true);
    expect(line(resolved({ command: `echo ok${separator} \t${separator}` })).whole).toBe(true);
    // A path's is part of the name the line cannot show.
    expect(line(call('delete_file', { path: `src/index.ts${separator}` })).whole).toBe(false);
  });

  it.each([
    ['Hebrew letters', 'echo שלום'],
    ['Arabic letters', 'echo مرحبا'],
    ['Arabic-Indic digits', 'echo ١٢٣'],
    ['Syriac letters', 'echo ܫܠܡܐ'],
    ['Thaana letters', 'echo ދިވެހި'],
    ['NKo letters', 'echo ߒߞߏ'],
    ['Adlam letters', 'echo 𞤀𞤁'],
    ['Phoenician letters', 'echo 𐤀𐤁'],
  ])(
    'leaves a subject with %s to its card: right-to-left text reorders the line around it',
    (_name, command) => {
      expect(line(resolved({ command })).whole).toBe(false);
      expect(line(call('delete_file', { path: command.replace('echo ', 'src/') })).whole).toBe(
        false,
      );
    },
  );

  it.each([
    ['a right-to-left override', '\u202E'],
    ['a left-to-right isolate', '\u2066'],
    ['a zero-width space', '\u200B'],
    ['a zero-width joiner', '\u200D'],
    ['a byte order mark', '\uFEFF'],
    ['a soft hyphen', '\u00AD'],
    ['an escape', '\u001B'],
    ['a null', '\u0000'],
    ['an emoji presentation selector', '️'],
    ['a variation selector supplement', '\u{E0100}'],
    ['a combining grapheme joiner', '͏'],
    ['a Hangul filler', 'ㅤ'],
    ['a Hangul choseong filler', 'ᅟ'],
    ['a Hangul jungseong filler', 'ᅠ'],
    ['a halfwidth Hangul filler', 'ﾠ'],
    ['a blank braille pattern', '⠀'],
    ['a Mongolian free variation selector', '᠋'],
    ['a Khmer inherent vowel', '឴'],
    ['a musical null notehead', '\u{1D159}'],
  ])('leaves a subject with %s to its card: the line cannot show all of it', (_name, hidden) => {
    expect(line(resolved({ command: `echo ${hidden}ok` })).whole).toBe(false);
    expect(line(call('delete_file', { path: `src/${hidden}index.ts` })).whole).toBe(false);
  });

  it('still decides a command with a tab in it', () => {
    expect(line(resolved({ command: 'printf "a\tb"' })).whole).toBe(true);
  });

  it('cuts at 80: a subject of 80 is whole, one of 81 is not', () => {
    const at = (length: number) => call('delete_file', { path: 'x'.repeat(length) });
    expect(line(at(80))).toMatchObject({ subject: 'x'.repeat(80), whole: true });
    expect(line(at(81))).toMatchObject({ subject: `${'x'.repeat(79)}…`, whole: false });
  });
});
