import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator, InProcessTransport, waitForProjection } from '@corral/core';
import { openDatabase, openReadOnlyDatabase, SqliteRunStore } from '@corral/storage-sqlite';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { runCli } from '../src/index.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('inspects and exports schema 13 history without upgrading or modifying the database', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'corral-cli-history-13-'));
  directories.push(cwd);
  mkdirSync(join(cwd, '.corral'));
  const file = join(cwd, '.corral', 'corral.db');
  const writable = openDatabase(file);
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    store: new SqliteRunStore(writable),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_legacy_history',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  if (!started.runId) throw new Error('expected a completed history fixture');
  await waitForProjection(
    new InProcessTransport(coordinator),
    started.runId,
    (p) => p.status === 'succeeded',
  );
  // Schema 13 has no original auto request hash column; readonly queries must not add it.
  writable.exec('ALTER TABLE commands DROP COLUMN original_request_hash');
  writable.pragma('user_version = 13');
  writable.close();
  const before = readFileSync(file);
  const output: string[] = [];
  const io = {
    cwd,
    write: (line: string) => output.push(line),
    signal: new AbortController().signal,
  };
  expect(await runCli(['inspect', started.runId], io), output.join('\n')).toBe(0);
  expect(JSON.parse(output.at(-1) ?? '{}').status).toBe('succeeded');
  expect(await runCli(['export', started.runId, '--private'], io)).toBe(0);
  expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
    visibility: 'private',
    runId: started.runId,
  });
  expect(await runCli(['export', started.runId], io)).toBe(0);
  expect(JSON.parse(output.at(-1) ?? '{}').visibility).toBe('public');
  const reader = openReadOnlyDatabase(file);
  expect(reader.pragma('user_version', { simple: true })).toBe(13);
  expect(
    (reader.pragma('table_info(commands)') as { name: string }[]).map((column) => column.name),
  ).not.toContain('original_request_hash');
  expect(
    new SqliteRunStore(reader).getCommand('*', 'cmd_legacy_history')?.originalRequestHash,
  ).toBeUndefined();
  reader.close();
  expect(readFileSync(file)).toEqual(before);
});
