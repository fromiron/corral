import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport } from '@corral/client';
import { emptyProjection, type StoredRun } from '@corral/core';
import { openDatabase, SqliteCorralRepository, SqliteRunStore } from '@corral/storage-sqlite';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';

const TOKEN = 'test-bootstrap-token-0123456789abcdef';
const servers: CorralServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'corral-run-stats-'));
  dirs.push(dir);
  return dir;
}

function finishedRun(runId: string, corralId: string, mode: 'mock' | 'live'): StoredRun {
  const projection = emptyProjection(runId);
  projection.corralId = corralId;
  projection.status = 'succeeded';
  projection.startedAt = '2026-11-08T00:00:00.000Z';
  projection.endedAt = '2026-11-08T00:05:00.000Z';
  projection.executions.exec_1 = {
    executionId: 'exec_1',
    nodeId: 'writer',
    taskId: 'task_1',
    attemptNo: 1,
    parentExecutionId: null,
    previousExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'local',
    configRevision: 0,
    criteriaVersionId: null,
    status: 'failed',
    activity: null,
    waitingOn: null,
    modelCallIds: [],
    error: 'model error with private details',
  };
  projection.executionOrder.push('exec_1');
  projection.nodeExecutions.writer = ['exec_1'];
  return {
    runId,
    snapshot: {
      definition: { ...linearCorral(['writer']), id: corralId },
      definitionHash: 'hash',
      source: { corralId, definitionRevision: 1 },
      criteriaVersionId: 'criteria',
      mode,
      models: {},
      startedAt: '2026-11-08T00:00:00.000Z',
    },
    projection,
  };
}

/** A workspace that already holds one saved team and one live and one mock run of it. */
async function seededWorkspace() {
  const workspace = tempDir();
  mkdirSync(join(workspace, '.corral'), { recursive: true });
  const db = openDatabase(join(workspace, '.corral', 'corral.db'));
  const saved = await new SqliteCorralRepository(db, {
    clock: { nowIso: () => '2026-11-08T00:00:00.000Z', monotonicMs: () => 0 },
    newCorralId: () => 'corral_stats',
  }).save({ definition: linearCorral(['writer']), expectedDefinitionRevision: null });
  if (!saved.ok) throw new Error(saved.message);
  const runs = new SqliteRunStore(db);
  runs.insertRun(finishedRun('run_live', 'corral_stats', 'live'));
  runs.insertRun(finishedRun('run_mock', 'corral_stats', 'mock'));
  db.close();
  return workspace;
}

async function signedIn(server: CorralServer) {
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token: TOKEN }),
  });
  expect(login.status).toBe(204);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call: typeof fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    headers.set('origin', server.url);
    return fetch(input, { ...init, headers });
  };
  return call;
}

describe('run stats API', () => {
  it('serves the finished live runs of a saved revision without bodies', async () => {
    const server = await startCorralServer({
      workspace: await seededWorkspace(),
      port: 0,
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      bootstrapToken: TOKEN,
      worktreeRoot: join(tempDir(), 'worktrees'),
    });
    servers.push(server);
    const call = await signedIn(server);

    const response = await call(`${server.url}/api/v1/corrals/corral_stats/revisions/1/stats`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('private details');
    expect(JSON.parse(text)).toEqual({
      corralId: 'corral_stats',
      definitionRevision: 1,
      runs: [
        {
          runId: 'run_live',
          status: 'succeeded',
          startedAt: '2026-11-08T00:00:00.000Z',
          endedAt: '2026-11-08T00:05:00.000Z',
        },
      ],
      totalOutputTokens: 0,
      nodes: {
        writer: {
          perRun: [
            {
              runId: 'run_live',
              executions: 1,
              failures: 1,
              retries: 0,
              outputTokens: 0,
              rounds: 0,
              capReached: false,
              branches: {},
            },
          ],
        },
      },
    });

    for (const missing of ['corral_missing/revisions/1', 'corral_stats/revisions/99']) {
      const refused = await call(`${server.url}/api/v1/corrals/${missing}/stats`);
      expect(refused.status).toBe(404);
    }
    expect(
      (await fetch(`${server.url}/api/v1/corrals/corral_stats/revisions/1/stats`)).status,
    ).toBe(401);

    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    expect((await transport.getRunStats('corral_stats', 1)).runs).toHaveLength(1);
  });
});
