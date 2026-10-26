import type { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { LspRunner } from '../src/files/lsp.ts';
import { spawnOwnedProcess } from '../src/processes/owned-process.ts';
import { systemTimers } from '../src/runtime.ts';

const dirs: string[] = [];
// Windows queries include native Job helper startup before the LSP handshake.
vi.setConfig({ testTimeout: 45000 });
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(mode = 'normal') {
  const cwd = mkdtempSync(join(tmpdir(), 'corral-lsp-'));
  dirs.push(cwd);
  return {
    cwd,
    argv: [
      process.execPath,
      fileURLToPath(new URL('./fixtures/lsp-server.mjs', import.meta.url)),
      mode,
    ],
    timeoutMs: process.platform === 'win32' ? 10000 : 1000,
    document: {
      uri: pathToFileURL(join(cwd, 'source.ts')).href,
      text: '😀value\n',
      languageId: 'typescript',
      version: 1,
    },
  };
}
const live = { aborted: false, onCancel: () => () => {} };
it('obtains rename and resolved code-action edits without applying them or running commands', async () => {
  const runner = new LspRunner({ clock: new FakeClock(), timers: systemTimers });
  const input = fixture();
  const rename = await runner.query(
    { ...input, operation: 'rename', position: { line: 0, character: 2 }, newName: 'renamed' },
    live,
  );
  expect(rename).toMatchObject({
    kind: 'edits',
    actions: [
      {
        title: 'Rename to renamed',
        edit: {
          documentChanges: [
            {
              textDocument: { uri: input.document.uri, version: 1 },
              edits: [{ newText: 'renamed' }],
            },
          ],
        },
      },
    ],
  });
  const actions = await runner.query(
    {
      ...input,
      operation: 'code_actions',
      range: { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } },
    },
    live,
  );
  expect(actions).toMatchObject({
    kind: 'edits',
    actions: [
      {
        title: 'Resolved fix',
        edit: { changes: { [input.document.uri]: [{ newText: 'fixed' }] } },
      },
      { title: 'Command only', unsupported: 'command' },
    ],
  });
});
it('server exception text never becomes a public tool error', async () => {
  const runner = new LspRunner({ clock: new FakeClock(), timers: systemTimers });
  await expect(
    runner.query({ ...fixture('initialize_error'), operation: 'diagnostics' }, live),
  ).rejects.toThrow('language server query failed');
});
it('uses public LSP initialization, full document sync and UTF-16 positions for definition/references', async () => {
  const runner = new LspRunner({ clock: new FakeClock(), timers: systemTimers });
  for (const operation of ['definition', 'references'] as const) {
    const input = fixture();
    const result = await runner.query(
      { ...input, operation, position: { line: 0, character: 2 } },
      live,
    );
    expect(result).toMatchObject({
      kind: 'locations',
      locations: [
        {
          uri: input.document.uri,
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
        },
      ],
    });
  }
});
it('supports both push and pull diagnostics, without allowing server-initiated edits', async () => {
  const runner = new LspRunner({ clock: new FakeClock(), timers: systemTimers });
  for (const mode of ['normal', 'pull', 'apply_edit']) {
    const result = await runner.query({ ...fixture(mode), operation: 'diagnostics' }, live);
    expect(result).toMatchObject({
      kind: 'diagnostics',
      diagnostics: [{ message: mode === 'apply_edit' ? 'applied=false' : 'Fixture diagnostic' }],
    });
  }
});
it.each([
  'initialize_error',
  'initialize_hang',
  'no_diagnostics',
  'wrong_version',
  'utf8',
  'oversized',
])('%s never becomes a clean diagnostic result', async (mode) => {
  const runner = new LspRunner({ clock: new FakeClock(), timers: systemTimers });
  await expect(runner.query({ ...fixture(mode), operation: 'diagnostics' }, live)).rejects.toThrow(
    /language server|diagnostic|version|UTF-16|limit/i,
  );
});
it('cancellation terminates the owned server and cannot publish a late result', async () => {
  const controller = new AbortController();
  let pid = 0;
  const runner = new LspRunner({
    clock: new FakeClock(),
    timers: systemTimers,
    spawn: (...args: Parameters<typeof spawn>) => {
      const child = (spawnOwnedProcess as typeof spawn)(...args);
      pid = child.pid ?? 0;
      child.stderr?.once('data', () => controller.abort());
      return child;
    },
  });
  await expect(
    runner.query(
      { ...fixture('query_hang'), operation: 'definition', position: { line: 0, character: 2 } },
      {
        get aborted() {
          return controller.signal.aborted;
        },
        onCancel(fn: () => void) {
          controller.signal.addEventListener('abort', fn);
          return () => controller.signal.removeEventListener('abort', fn);
        },
      },
    ),
  ).rejects.toThrow(/cancelled/);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});
