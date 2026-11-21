import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository, WorkspacesApi } from '@corral/client';
import type { CorralDefinition, ScheduledOccurrence } from '@corral/contracts';
import { Gate, linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

// A local host shares the Paddock with people's work, but an agent run that writes files is one
// at a time per copy (workbench.md 공유 개발 모드): every way a run starts meets the same copy
// admission, and the refusal names the run that is writing (api-contract.md 오류, `owner`).
vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-shared-runs-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  writeFileSync(join(original, 'a.txt'), 'one\n');
  writeFileSync(join(original, 'package.json'), JSON.stringify({ scripts: {} }));
  execFileSync('git', ['add', '.'], { cwd: original });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'first'], {
    cwd: original,
  });
  const gate = new Gate();
  const token = 'shared-copy-runs-fixture-0123456789abcd';
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1, beforeReply: () => gate.wait() }),
    port: 0,
    allowSharedDevelopment: true,
  });
  cleanups.push(async () => {
    gate.open();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', server.url);
    headers.set('cookie', cookie);
    headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return fetch(url, { ...init, headers });
  };
  const options = { baseUrl: server.url, fetch: call };
  const repository = new RestCorralRepository(options);
  const transport = new HttpSseTransport(options);
  const workspaces = new WorkspacesApi(options);
  await workspaces.bind('default', original);
  await workspaces.configure('default', { trusted: true });
  const created = await repository.createSession({ projectId: 'default', title: 'Writers' });
  assert(created.ok);
  const sessionId = created.session.sessionId;
  await workspaces.createWorktree(sessionId);
  const team = async (id: string, tools: CorralDefinition['roles'][number]['allowedWorkTools']) => {
    const definition = linearCorral(['agent'], id);
    const [role] = definition.roles;
    assert(role);
    role.allowedWorkTools = tools;
    const saved = await repository.save({ definition, expectedDefinitionRevision: null });
    assert(saved.ok);
    return saved.record;
  };
  const writer = await team('copy_writer', [
    'write_artifact',
    'list_files',
    'read_file',
    'write_file',
  ]);
  const reader = await team('copy_reader', ['write_artifact', 'list_files', 'read_file']);
  const launch = (commandId: string, record: typeof writer) =>
    transport.startRun({
      schemaVersion: '0.1',
      commandId,
      sessionId,
      corralId: record.corralId,
      definitionRevision: record.definitionRevision,
      mode: 'mock',
    });
  const json = async (path: string, body?: unknown) => {
    const response = await call(`${server.url}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  return { server, repository, sessionId, writer, reader, launch, json };
}

it('refuses a second writing run on the copy, naming the run that writes, and admits a reader beside it', async () => {
  const s = await setup();
  const first = await s.launch('writer_a', s.writer);
  expect(first.receipt.status).toBe('applied');
  const second = await s.launch('writer_b', s.writer);
  expect(second.runId).toBeNull();
  expect(second.receipt.error).toMatchObject({
    code: 'RUN_ALREADY_ACTIVE',
    owner: { kind: 'run', id: first.runId, sessionId: s.sessionId, state: 'active' },
  });
  const reading = await s.launch('reader', s.reader);
  expect(reading.receipt.status).toBe('applied');
});

it('a schedule firing into a session whose run writes is refused and recorded as refused', async () => {
  const s = await setupWithWriter();
  const schedule = await s.json('/schedules', {
    title: 'Review',
    hostId: 'local',
    projectId: 'default',
    sessionId: s.sessionId,
    timezone: 'Asia/Tokyo',
    rule: { kind: 'daily', time: '09:00' },
    enabled: false,
    request: {
      brief: 'Tidy the copy.',
      choice: { modelProfile: 'simulated' },
      mode: 'mock',
      permissionMode: 'ask',
      configRevision: 1,
    },
  });
  const ran: { occurrences: ScheduledOccurrence[] } = await s.json(
    `/schedules/${schedule.id}/run`,
    { commandId: 'scheduled_tidy', expectedRevision: 1 },
  );
  expect(ran.occurrences[0]).toMatchObject({ status: 'refused', runId: null });
  expect(ran.occurrences[0]?.detail).toMatch(/writing/);
  const session = await s.repository.getSession(s.sessionId);
  expect(session?.entries.at(-1)).toMatchObject({ text: 'Tidy the copy.', state: 'refused' });
  expect(s.server.coordinator.listRuns().filter((run) => run.status === 'running')).toHaveLength(1);
});

it("a queued start that races in past the session's open run is refused, and its entry keeps the owner", async () => {
  const s = await setupWithWriter();
  // The queue looks for an open run before it starts; one starting in between is not seen.
  const listRuns = s.server.coordinator.listRuns.bind(s.server.coordinator);
  vi.spyOn(s.server.coordinator, 'listRuns').mockImplementation(() =>
    listRuns().filter((run) => run.runId !== s.writing),
  );
  const added = await s.repository.addSessionEntry(s.sessionId, {
    intent: 'queue',
    text: 'After the writer.',
    state: 'queued',
    start: { choice: { modelProfile: 'model-a' }, mode: 'mock', team: 'none' },
  });
  assert(added.ok);
  const entryId = added.session.entries.at(-1)?.entryId;
  await vi.waitFor(
    async () =>
      expect(
        (await s.repository.getSession(s.sessionId))?.entries.find(
          (entry) => entry.entryId === entryId,
        ),
      ).toMatchObject({
        state: 'refused',
        runId: null,
        refusal: {
          code: 'RUN_ALREADY_ACTIVE',
          owner: { kind: 'run', id: s.writing, sessionId: s.sessionId, state: 'active' },
        },
      }),
    { timeout: 10_000 },
  );
});

it.each(['resume', 'fork'] as const)('keeps the writing run named by a blocked %s', async (way) => {
  const s = await setupWithWriter();
  const coordinator = s.server.coordinator;
  const commandId = `blocked_${way}`;
  const sourceRunId = s.writing;
  const hash = '0'.repeat(64);
  // The restore gate answers before looking up the checkpoint or preparing a branch.
  const result =
    way === 'resume'
      ? await coordinator.resumeRuntime({
          commandId,
          sourceRunId,
          checkpointId: 'checkpoint',
          expectedSourceSeq: 1,
          manifestHash: hash,
        })
      : await coordinator.branchRun(
          { commandId, sourceRunId, requestStart: true, expectedHash: hash },
          () => Promise.reject(new Error('A blocked fork cannot prepare a session')),
        );
  expect(result).toMatchObject({
    runId: null,
    receipt: {
      error: {
        code: 'RUN_ALREADY_ACTIVE',
        owner: { kind: 'run', id: s.writing, sessionId: s.sessionId, state: 'active' },
      },
    },
  });
});

/** The fixture with one writing run holding the copy. */
async function setupWithWriter() {
  const s = await setup();
  const first = await s.launch('writer_a', s.writer);
  expect(first.receipt.status).toBe('applied');
  assert(first.runId);
  return { ...s, writing: first.runId };
}
