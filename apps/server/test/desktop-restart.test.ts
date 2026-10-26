import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import { waitForProjection } from '@corral/core';
import { openReadOnlyDatabase } from '@corral/storage-sqlite';
import { Gate, linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';

const directories: string[] = [];
const servers: CorralServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) {
    if (!relative(resolve(tmpdir()), resolve(directory)).startsWith('corral-restart-'))
      throw new Error('Unexpected cleanup target');
    rmSync(directory, { recursive: true, force: true });
  }
});

async function start(gate?: Gate) {
  const workspace = mkdtempSync(join(tmpdir(), 'corral-restart-'));
  directories.push(workspace);
  const token = 'desktop-restart-verification-token';
  const server = await startCorralServer({
    workspace,
    port: 0,
    bootstrapToken: token,
    worktreeRoot: join(workspace, 'worktrees'),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      ...(gate ? { beforeReply: () => gate.wait() } : {}),
    }),
  });
  servers.push(server);
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const headers = {
    origin: server.url,
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    'content-type': 'application/json',
  };
  const call: typeof fetch = (url, init = {}) =>
    fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  return { server, headers, call, workspace };
}

it('update restart refuses active work, then closes only after its normal completion', async () => {
  const gate = new Gate();
  const { server, call } = await start(gate);
  try {
    const repository = new RestCorralRepository({ baseUrl: server.url, fetch: call });
    const saved = await repository.save({
      definition: linearCorral(['writer']),
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      expectedDefinitionRevision: null,
    });
    if (!saved.ok) throw new Error(saved.message);
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const started = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_restart_test',
      corralId: saved.record.corralId,
      definitionRevision: 1,
      mode: 'mock',
    });
    if (!started.runId) throw new Error('Run did not start');
    expect(await server.closeIfIdle()).toBe(false);
    expect((await call(`${server.url}/api/v1/health`)).status).toBe(200);
    gate.open();
    await waitForProjection(transport, started.runId, (value) => value.status === 'succeeded');
    expect(await server.closeIfIdle()).toBe(true);
    await expect(call(`${server.url}/api/v1/health`)).rejects.toThrow();
  } finally {
    gate.open();
  }
});

it('a pending HTTP mutation blocks restart before the route can start a Run', async () => {
  const { server, headers, call, workspace } = await start();
  const body = JSON.stringify({ name: 'Still accepting work', description: '' });
  const url = new URL(`${server.url}/api/v1/projects`);
  const pending = request(url, {
    method: 'POST',
    headers: { ...headers, expect: '100-continue', 'content-length': Buffer.byteLength(body) },
  });
  const continued = once(pending, 'continue');
  const response = new Promise<number>((done, reject) => {
    pending.once('response', (reply) => {
      reply.resume();
      reply.once('end', () => done(reply.statusCode ?? 0));
    });
    pending.once('error', reject);
  });
  pending.flushHeaders();
  await continued;
  expect(await server.closeIfIdle()).toBe(false);
  pending.end(body);
  expect(await response).toBe(201);
  expect((await call(`${server.url}/api/v1/projects`)).status).toBe(200);
  const storageVersion = server.desktopStorageVersion();
  expect(await server.closeIfIdle(true)).toBe(true);
  const backups = join(workspace, '.corral', 'update-backups');
  const names = readdirSync(backups);
  expect(names).toHaveLength(1);
  const snapshot = join(backups, names[0] ?? '');
  expect(JSON.parse(readFileSync(join(snapshot, 'snapshot.json'), 'utf8')).storageVersion).toBe(
    storageVersion,
  );
  const database = openReadOnlyDatabase(join(snapshot, 'corral.db'));
  try {
    expect(
      database.prepare('SELECT name FROM projects WHERE name=?').get('Still accepting work'),
    ).toEqual({ name: 'Still accepting work' });
  } finally {
    database.close();
  }
});

it('a failed pre-update backup restores server admission and permits a later clean restart', async () => {
  const { server, call, workspace } = await start();
  const blocked = join(workspace, '.corral', 'update-backups');
  writeFileSync(blocked, 'A file prevents creating the backup directory.');
  await expect(server.closeIfIdle(true)).rejects.toThrow();
  const created = await call(`${server.url}/api/v1/projects`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Work after deferred update', description: '' }),
  });
  expect(created.status).toBe(201);
  expect(await (await call(`${server.url}/api/v1/projects`)).json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'Work after deferred update' })]),
  );
  rmSync(blocked);
  expect(await server.closeIfIdle(true)).toBe(true);
});
