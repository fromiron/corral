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

  it('cuts at 80: a subject of 80 is whole, one of 81 is not', () => {
    const at = (length: number) => call('delete_file', { path: 'x'.repeat(length) });
    expect(line(at(80))).toMatchObject({ subject: 'x'.repeat(80), whole: true });
    expect(line(at(81))).toMatchObject({ subject: `${'x'.repeat(79)}…`, whole: false });
  });
});
