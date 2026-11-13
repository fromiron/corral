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
    ['a line feed', 0x0a],
    ['a carriage return', 0x0d],
    ['a next line', 0x85],
    ['a line separator', 0x2028],
    ['a paragraph separator', 0x2029],
    ['a vertical tab', 0x0b],
    ['a form feed', 0x0c],
  ])('counts a command split by %s as several lines: View alone', (_name, code) => {
    const separator = String.fromCodePoint(code);
    expect(line(resolved({ command: `echo ok${separator}rm -rf build` })).whole).toBe(false);
    expect(line(call('delete_file', { path: `src/index.ts${separator}` })).whole).toBe(false);
  });

  it("does not count line feeds at a command's end, with the blanks between them", () => {
    for (const command of ['echo ok\n', 'echo ok\n\n', 'echo ok\n \t\n', 'echo ok \n'])
      expect(line(resolved({ command }))).toMatchObject({ subject: 'echo ok', whole: true });
    // A path's is part of the name the line cannot show.
    expect(line(call('delete_file', { path: 'src/index.ts\n' })).whole).toBe(false);
  });

  it.each([
    ['a carriage return', 0x0d],
    ['a next line', 0x85],
    ['a line separator', 0x2028],
    ['a paragraph separator', 0x2029],
    ['a vertical tab', 0x0b],
    ['a form feed', 0x0c],
  ])(
    'leaves a command ending in %s to its card: the shell runs it as part of the last word',
    (_name, code) => {
      const end = String.fromCodePoint(code);
      for (const command of [`./deploy.sh${end}`, `./deploy.sh${end}\n`])
        expect(line(resolved({ command })).whole).toBe(false);
    },
  );

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
    ['a right-to-left override', 0x202e],
    ['a left-to-right isolate', 0x2066],
    ['a zero-width space', 0x200b],
    ['a zero-width joiner', 0x200d],
    ['a byte order mark', 0xfeff],
    ['a soft hyphen', 0xad],
    ['an escape', 0x1b],
    ['a null', 0x00],
    ['an emoji presentation selector', 0xfe0f],
    ['a variation selector supplement', 0xe0100],
    ['a combining grapheme joiner', 0x034f],
    ['a Hangul filler', 0x3164],
    ['a Hangul choseong filler', 0x115f],
    ['a Hangul jungseong filler', 0x1160],
    ['a halfwidth Hangul filler', 0xffa0],
    ['a blank braille pattern', 0x2800],
    ['a Mongolian free variation selector', 0x180b],
    ['a Khmer inherent vowel', 0x17b4],
    ['a musical null notehead', 0x1d159],
    ['an object replacement character', 0xfffc],
    ['a Khitan filler', 0x16fe4],
    ['an Egyptian hieroglyph insertion mark', 0x13441],
    ['an Egyptian hieroglyph lost sign', 0x13442],
    ['a no-break space', 0xa0],
    ['an en quad', 0x2000],
    ['an em space', 0x2003],
    ['a hair space', 0x200a],
    ['a narrow no-break space', 0x202f],
    ['a medium mathematical space', 0x205f],
    ['an ideographic space', 0x3000],
    ['an ogham space mark', 0x1680],
  ])('leaves a subject with %s to its card: the line cannot show all of it', (_name, code) => {
    const hidden = String.fromCodePoint(code);
    expect(line(resolved({ command: `echo ${hidden}ok` })).whole).toBe(false);
    expect(line(call('delete_file', { path: `src/${hidden}index.ts` })).whole).toBe(false);
  });

  it.each([
    ['an ideographic level tone mark', 0x302a],
    ['an ideographic rising tone mark', 0x302b],
  ])(
    'leaves a subject with %s standing alone to its card, and decides one on its letter',
    (_name, code) => {
      const mark = String.fromCodePoint(code);
      for (const command of [`echo ${mark}`, `${mark}echo ok`, `echo ${mark} ok`])
        expect(line(resolved({ command })).whole).toBe(false);
      expect(line(resolved({ command: `echo 中${mark}` })).whole).toBe(true);
    },
  );

  it.each([
    ['before', ' src/index.ts'],
    ['after', 'src/index.ts '],
    ['as a tab after', 'src/index.ts\t'],
  ])('leaves a path with a blank %s it to its card', (_name, path) => {
    expect(line(call('delete_file', { path })).whole).toBe(false);
    expect(line(call('move_file', { from: path, to: 'src/main.ts' })).whole).toBe(false);
    expect(line(call('move_file', { from: 'src/main.ts', to: path })).whole).toBe(false);
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
