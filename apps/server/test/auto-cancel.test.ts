import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';
import { FAKE_PROFILES, fakeOpenAI, fauxAssistantMessage } from '../src/testing.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-auto-cancel-'));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.corral'), { recursive: true });
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({ schemaVersion: '0.1', modelProfiles: FAKE_PROFILES }),
  );
  const fake = fakeOpenAI({ configDir: join(root, 'config'), codexLogin: {} });
  let releaseWorker = () => {};
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  fake.live.agents = () => new ScriptedAgentAdapter({ turns: 1, beforeReply: () => workerGate });
  const token = 'test-bootstrap-token-0123456789abcdef';
  const open = () =>
    startCorralServer({
      workspace,
      port: 0,
      bootstrapToken: token,
      worktreeRoot: join(root, 'worktrees'),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      live: fake.live,
    });
  let server: CorralServer = await open();
  let releaseChoice = () => {};
  cleanup.push(async () => {
    releaseChoice();
    releaseWorker();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const authenticate = () =>
    fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token }),
    });
  let login = await authenticate();
  const json = async (path: string, body: unknown) => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
        origin: server.url,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const created = await json('/sessions', { projectId: 'default', title: 'Cancel selection' });
  const sessionId = created.body.session.sessionId as string;
  const request = (commandId: string) => ({
    schemaVersion: '0.1',
    commandId,
    sessionId,
    brief: 'Answer the short question.',
    choice: { modelProfile: 'model-a' },
    mode: 'live',
  });
  const holdChoice = () => {
    let enter = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const choiceGate = new Promise<void>((resolve) => {
      releaseChoice = resolve;
    });
    let signal: AbortSignal | undefined;
    fake.setResponses([
      async (_context, options) => {
        signal = options?.signal;
        enter();
        await choiceGate;
        return fauxAssistantMessage('{"template":"single","reason":"Short."}');
      },
    ]);
    return { entered, signal: () => signal, release: () => releaseChoice() };
  };
  const cancel = (commandId: string, targetSession = sessionId, cancelCommandId = 'cmd_cancel') =>
    json(`/runs/auto/${commandId}/cancel`, { sessionId: targetSession, cancelCommandId });
  return {
    get server() {
      return server;
    },
    fake,
    json,
    request,
    sessionId,
    cancel,
    holdChoice,
    releaseWorker,
    async restart() {
      await server.close();
      server = await open();
      login = await authenticate();
    },
  };
}

it('[TC-AUTO-003-N] cancels the actual pending chooser and starts no run', async () => {
  const s = await setup();
  const choice = s.holdChoice();
  const start = s.json('/runs/auto', s.request('cmd_pending'));
  await choice.entered;
  const cancelled = await s.cancel('cmd_pending');
  expect(cancelled.status).toBe(200);
  expect(cancelled.body).toEqual({ start: null, cancellation: null });
  expect(choice.signal()?.aborted).toBe(true);
  choice.release();
  expect((await start).body.receipt.status).toBe('cancelled');
  expect(s.server.coordinator.listRuns()).toHaveLength(0);
});

it('[TC-AUTO-003-N] returns the committed start and cancels its live run through Reins', async () => {
  const s = await setup();
  s.fake.setResponses([fauxAssistantMessage('{"template":"single","reason":"Short."}')]);
  const started = await s.json('/runs/auto', s.request('cmd_committed'));
  expect(started.status).toBe(201);
  const cancelled = await s.cancel('cmd_committed');
  expect(cancelled.status).toBe(200);
  expect(cancelled.body.start).toEqual(started.body);
  expect(cancelled.body.cancellation.runId).toBe(started.body.runId);
  expect(cancelled.body.cancellation.error).toBeUndefined();
  s.releaseWorker();
  await expect.poll(() => s.server.coordinator.listRuns()[0]?.status).toBe('cancelled');
  const again = await s.cancel('cmd_committed');
  expect(again.body.start).toEqual(cancelled.body.start);
  expect(again.body.cancellation.commandId).toBe(cancelled.body.cancellation.commandId);
  expect(again.body.cancellation.error).toBeUndefined();
  expect(s.server.coordinator.listRuns()).toHaveLength(1);
});

it('[TC-AUTO-003-N] a concurrent resend cannot replace the actual chooser controller', async () => {
  const s = await setup();
  const choice = s.holdChoice();
  const request = s.request('cmd_shared');
  const first = s.json('/runs/auto', request);
  await choice.entered;
  const second = s.json('/runs/auto', request);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cancelled = await s.cancel('cmd_shared');
  expect(cancelled.status).toBe(200);
  expect(choice.signal()?.aborted).toBe(true);
  choice.release();
  const results = await Promise.all([first, second]);
  expect(results.map((r) => r.body.receipt.status)).toEqual(['cancelled', 'cancelled']);
  expect(s.fake.seen.hostRequests).toHaveLength(1);
  expect(s.server.coordinator.listRuns()).toHaveLength(0);
});

it('[TC-AUTO-003-N] a different session cannot cancel another session pending choice', async () => {
  const s = await setup();
  const other = await s.json('/sessions', { projectId: 'default', title: 'Other' });
  const choice = s.holdChoice();
  const start = s.json('/runs/auto', s.request('cmd_scoped'));
  await choice.entered;
  expect((await s.cancel('cmd_scoped', other.body.session.sessionId)).status).toBe(404);
  expect(choice.signal()?.aborted).toBe(false);
  choice.release();
  expect((await start).body.runId).toBeTruthy();
});

it('[TC-AUTO-003-N] a cancellation arriving before its POST fences that late request', async () => {
  const s = await setup();
  expect((await s.cancel('cmd_late')).body).toEqual({ start: null, cancellation: null });
  const late = await s.json('/runs/auto', s.request('cmd_late'));
  expect(late.status).toBe(200);
  expect(late.body.receipt.status).toBe('cancelled');
  expect(s.fake.seen.hostRequests).toHaveLength(0);
  expect(s.server.coordinator.listRuns()).toHaveLength(0);
});

it('[TC-AUTO-003-N] a different session cannot cancel a committed auto run', async () => {
  const s = await setup();
  s.fake.setResponses([fauxAssistantMessage('{"template":"single","reason":"Short."}')]);
  const started = await s.json('/runs/auto', s.request('cmd_committed_scope'));
  const other = await s.json('/sessions', { projectId: 'default', title: 'Other' });
  expect((await s.cancel('cmd_committed_scope', other.body.session.sessionId)).status).toBe(404);
  expect(s.server.coordinator.listRuns()[0]?.runId).toBe(started.body.runId);
  expect(s.server.coordinator.listRuns()[0]?.status).toBe('running');
});

it('[TC-AUTO-003-N] an already finished run still returns its original start without a new cancellation', async () => {
  const s = await setup();
  s.fake.setResponses([fauxAssistantMessage('{"template":"single","reason":"Short."}')]);
  s.releaseWorker();
  const started = await s.json('/runs/auto', s.request('cmd_finished'));
  await expect.poll(() => s.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
  expect((await s.cancel('cmd_finished')).body).toEqual({
    start: started.body,
    cancellation: null,
  });
});

it('[TC-AUTO-003-N] a start receipt cannot masquerade as its cancellation receipt', async () => {
  const s = await setup();
  s.fake.setResponses([fauxAssistantMessage('{"template":"single","reason":"Short."}')]);
  await s.json('/runs/auto', s.request('cmd_distinct'));
  expect((await s.cancel('cmd_distinct', s.sessionId, 'cmd_distinct')).status).toBe(400);
  expect(s.server.coordinator.listRuns()[0]?.status).toBe('running');
});

it('[TC-AUTO-003-N] a reused control ID cannot return a pause receipt as cancellation', async () => {
  const s = await setup();
  s.fake.setResponses([fauxAssistantMessage('{"template":"single","reason":"Short."}')]);
  const started = await s.json('/runs/auto', s.request('cmd_control_collision'));
  s.server.coordinator.submit({
    schemaVersion: '0.1',
    runId: started.body.runId,
    commandId: 'cmd_control_taken',
    type: 'pause',
    payload: { scope: 'run' },
  });
  const cancelled = await s.cancel('cmd_control_collision', s.sessionId, 'cmd_control_taken');
  expect(cancelled.body.cancellation.error.code).toBe('IDEMPOTENCY_CONFLICT');
  expect(s.server.coordinator.listRuns()[0]?.status).not.toBe('cancelling');
});

it('[TC-AUTO-003-N] a pre-start cancellation survives the routing timeout', async () => {
  const s = await setup();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let status: number | undefined;
    const cancelled = s.cancel('cmd_expired').then((response) => {
      status = response.status;
    });
    await vi.waitFor(() => expect(status).toBe(200));
    await cancelled;
    vi.advanceTimersByTime(30_001);
  } finally {
    vi.useRealTimers();
  }
  const late = await s.json('/runs/auto', s.request('cmd_expired'));
  expect(late.body.receipt.status).toBe('cancelled');
  expect(late.body.runId).toBeNull();
  expect(s.fake.seen.hostRequests).toHaveLength(0);
  expect(s.server.coordinator.listRuns()).toHaveLength(0);
});

it('[TC-AUTO-003-N] a pre-start cancellation survives restart and remains session scoped', async () => {
  const s = await setup();
  expect((await s.cancel('cmd_restart')).status).toBe(200);
  await s.restart();
  const late = await s.json('/runs/auto', s.request('cmd_restart'));
  expect(late.body.receipt.status).toBe('cancelled');
  expect(late.body.runId).toBeNull();
  expect(s.fake.seen.hostRequests).toHaveLength(0);
  expect(s.server.coordinator.listRuns()).toHaveLength(0);
  const other = await s.json('/sessions', { projectId: 'default', title: 'Other' });
  expect((await s.cancel('cmd_restart', other.body.session.sessionId)).status).toBe(404);
});

it('[TC-TEAM-001-F] cancels a committed conversation start like any auto start', async () => {
  const s = await setup();
  const started = await s.json('/runs/auto', { ...s.request('cmd_team'), team: 'none' });
  expect(started.status).toBe(201);
  expect(started.body.autoRoute).toBeNull();
  expect(s.fake.seen.hostRequests).toHaveLength(0);
  const cancelled = await s.cancel('cmd_team');
  expect(cancelled.status).toBe(200);
  expect(cancelled.body.start.runId).toBe(started.body.runId);
  expect(cancelled.body.cancellation.error).toBeUndefined();
  s.releaseWorker();
  await expect.poll(() => s.server.coordinator.listRuns()[0]?.status).toBe('cancelled');
});
