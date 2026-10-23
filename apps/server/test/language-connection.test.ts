import type { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { BoundedLspFrames, LanguageConnection } from '../src/files/language-connection.ts';
import { spawnOwnedProcess } from '../src/processes/owned-process.ts';
import type { PtySessionIdentity } from '../src/processes/pty-session.ts';
import { systemTimers } from '../src/runtime.ts';

vi.setConfig({ testTimeout: 45000 });
const directories: string[] = [];
const connections: LanguageConnection[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function fixture(mode = 'full', onSpawn?: (identity: PtySessionIdentity) => void) {
  const cwd = mkdtempSync(join(tmpdir(), 'corral-language-'));
  directories.push(cwd);
  const received: { uri: string; version: number | undefined; diagnostics: unknown[] }[] = [];
  const failures: Error[] = [];
  const started: number[] = [];
  const identities: number[] = [];
  const deadlines = new FakeClock();
  let waiting = () => {};
  const connection = await LanguageConnection.start({
    cwd,
    argv: [
      process.execPath,
      fileURLToPath(new URL('./fixtures/language-server.mjs', import.meta.url)),
      mode,
    ],
    timeoutMs: 5000,
    owner: 'language-transport-test',
    clock: deadlines,
    timers: {
      after: (ms, fn) => (ms === 5000 ? deadlines.after(ms, fn) : systemTimers.after(ms, fn)),
    },
    onDiagnostics: (uri, version, diagnostics) => received.push({ uri, version, diagnostics }),
    onFailure: (error) => failures.push(error),
    onSpawn: (identity) => {
      identities.push(identity.pid);
      onSpawn?.(identity);
    },
    spawn: (...args: Parameters<typeof spawn>) => {
      const child = (spawnOwnedProcess as typeof spawn)(...args);
      if (child.pid) started.push(child.pid);
      child.stderr?.on('data', () => waiting());
      return child;
    },
  });
  connections.push(connection);
  const document = {
    uri: pathToFileURL(join(cwd, '한글.ts')).href,
    languageId: 'typescript',
    version: 1,
    text: '😀가\r\n끝',
  };
  return {
    connection,
    document,
    received,
    failures,
    started,
    identities,
    deadlines,
    onWaiting: (fn: () => void) => {
      waiting = fn;
    },
  };
}

it.skipIf(process.platform !== 'linux').each(['full', 'incremental'])(
  '[TC-WBD-018-H] keeps one %s-sync server for dirty documents and read-only queries',
  async (mode) => {
    const { connection, document, received, started, identities } = await fixture(mode);
    expect(connection.capabilities).toMatchObject({
      completion: true,
      definition: true,
      references: true,
      diagnosticPull: false,
      triggerCharacters: ['.'],
    });
    await connection.sync(document);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.diagnostics).toMatchObject([
      { message: expect.stringContaining('edit=true') },
    ]);
    await connection.sync({ ...document, version: 2, text: '😀나\r\n새 끝' });
    await vi.waitFor(() => expect(received.at(-1)?.version).toBe(2));
    expect(
      await connection.query('completion', document.uri, { line: 0, character: 2 }),
    ).toMatchObject([{ label: '😀나\r\n새 끝' }]);
    expect(
      await connection.query('definition', document.uri, { line: 0, character: 2 }),
    ).toMatchObject({ uri: document.uri, range: { start: { line: 0, character: 2 } } });
    expect(
      await connection.query('references', document.uri, { line: 0, character: 2 }),
    ).toMatchObject([{ uri: document.uri }]);
    await connection.closeDocument(document.uri);
    await connection.sync({ ...document, version: 3 });
    expect(started).toHaveLength(1);
    expect(identities).toEqual(started);
    await connection.close();
    expect(() => process.kill(started[0] as number, 0)).toThrow();
  },
);

it.skipIf(process.platform !== 'linux')(
  '[TC-WBD-018-N] exposes pull capabilities and rejects unsupported requests without a restart',
  async () => {
    const pull = await fixture('pull');
    await pull.connection.sync(pull.document);
    expect(pull.connection.capabilities.diagnosticPull).toBe(true);
    expect(await pull.connection.query('diagnostics', pull.document.uri)).toMatchObject({
      kind: 'full',
      items: [{ message: expect.stringContaining('😀가') }],
    });
    const unsupported = await fixture('unsupported');
    await unsupported.connection.sync(unsupported.document);
    await expect(
      unsupported.connection.query('references', unsupported.document.uri, {
        line: 0,
        character: 2,
      }),
    ).rejects.toThrow(/support/);
    expect(unsupported.started).toHaveLength(1);
    let unrecorded = 0;
    await expect(
      fixture('full', (identity) => {
        unrecorded = identity.pid;
        throw new Error('private storage failure');
      }),
    ).rejects.toThrow('language server could not start');
    expect(unrecorded).toBeGreaterThan(0);
    expect(() => process.kill(unrecorded, 0)).toThrow();
  },
);

it.skipIf(process.platform !== 'linux')(
  '[TC-WBD-018-F] settles cancellation, timeout, close and crash without restarting or changing documents',
  async () => {
    const fixtureResult = await fixture();
    const { connection, document, onWaiting } = fixtureResult;
    await connection.sync(document);
    const abort = new AbortController();
    onWaiting(() => abort.abort());
    await expect(
      connection.query(
        'completion',
        document.uri,
        { line: 0, character: 99 },
        {
          get aborted() {
            return abort.signal.aborted;
          },
          onCancel(fn) {
            abort.signal.addEventListener('abort', fn);
            return () => abort.signal.removeEventListener('abort', fn);
          },
        },
      ),
    ).rejects.toThrow(/cancelled/);
    expect(
      await connection.query('completion', document.uri, { line: 0, character: 2 }),
    ).toMatchObject([{ label: document.text }]);
    onWaiting(() => fixtureResult.deadlines.advance(5000));
    await expect(
      connection.query('completion', document.uri, { line: 0, character: 99 }),
    ).rejects.toThrow(/timeout/);
    onWaiting(() => {
      void connection.close();
    });
    await expect(
      connection.query('completion', document.uri, { line: 0, character: 99 }),
    ).rejects.toThrow(/closed/);
    await connection.close();
    const crashed = await fixture('crash');
    await crashed.connection.sync(crashed.document);
    await expect(
      crashed.connection.query('references', crashed.document.uri, { line: 0, character: 2 }),
    ).rejects.toThrow(/closed/);
    await crashed.connection.close();
    expect(crashed.failures).toHaveLength(1);
    expect(crashed.started).toHaveLength(1);
  },
);

it('[TC-WBD-018-N] bounds each protocol frame while allowing split headers and many valid frames', async () => {
  const stream = new BoundedLspFrames();
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  const body = Buffer.alloc(1024 * 1024, 'a');
  for (let index = 0; index < 9; index++) {
    stream.write('Content-Len');
    stream.write(`gth: ${body.length}\r\n\r`);
    stream.write('\n');
    stream.write(body);
  }
  stream.end();
  expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
  for (const header of ['Content-Length: 8388609\r\n\r\n', 'x'.repeat(8193)]) {
    const oversized = new BoundedLspFrames();
    const error = new Promise<Error>((resolve) => oversized.once('error', resolve));
    oversized.end(header);
    await expect(error).resolves.toMatchObject({ message: expect.stringMatching(/limit/) });
  }
});
