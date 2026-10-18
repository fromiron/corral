import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport } from '@corral/client';
import { waitForProjection } from '@corral/core';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { expect, it } from 'vitest';
import { startCorralServer } from '../src/index.ts';
import { FAKE_PROFILES, fakeOpenAI, fauxAssistantMessage, fauxToolCall } from '../src/testing.ts';

it('[TC-AUTO-003-N] pins the run file baseline after choosing, once for concurrent resends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-auto-baseline-'));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.corral'), { recursive: true });
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({ schemaVersion: '0.1', modelProfiles: FAKE_PROFILES }),
  );
  const fake = fakeOpenAI({ configDir: join(root, 'config'), codexLogin: {} });
  const token = 'test-bootstrap-token-0123456789abcdef';
  const server = await startCorralServer({
    workspace,
    port: 0,
    bootstrapToken: token,
    worktreeRoot: join(root, 'worktrees'),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    live: fake.live,
  });
  let release = () => {};
  try {
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const call: typeof fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('cookie', cookie);
      headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
      headers.set('origin', server.url);
      if (init.body) headers.set('content-type', 'application/json');
      return fetch(input, { ...init, headers });
    };
    const json = async (path: string, body?: unknown, method = 'POST') => {
      const response = await call(`${server.url}/api/v1${path}`, {
        method: body === undefined ? 'GET' : method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const original = join(root, 'original');
    mkdirSync(original);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
        cwd: original,
      });
    git('init', '-q');
    writeFileSync(join(original, 'a.txt'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    await json('/projects/default/workspace', { path: original }, 'PUT');
    await json('/projects/default/workspace', { trusted: true }, 'PATCH');
    const { session } = await json('/sessions', { projectId: 'default', title: 'Baseline' });
    await json(`/sessions/${session.sessionId}/worktree`, {});
    const worktreeRoot = join(root, 'worktrees');
    const workspaceId = readdirSync(worktreeRoot)[0];
    if (!workspaceId) throw new Error('the test working copy was not created');
    const copy = join(worktreeRoot, workspaceId, session.sessionId);
    let enter = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.setResponses([
      async () => {
        enter();
        await released;
        return fauxAssistantMessage('{"template":"single","reason":"Direct answer."}');
      },
      fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'No file edits.' })], {
        stopReason: 'toolUse',
      }),
      (context) =>
        fauxAssistantMessage(
          [
            fauxToolCall('submit_result', {
              artifactVersionIds: [
                JSON.stringify(context.messages)
                  .match(/artv_[a-f0-9]{32}/g)
                  ?.at(-1) ?? 'missing_artifact',
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
    ]);
    const request = {
      schemaVersion: '0.1',
      commandId: 'cmd_baseline',
      sessionId: session.sessionId,
      brief: 'Explain the file without changing it.',
      choice: { modelProfile: 'model-a' },
      mode: 'live',
    };
    const pending = json('/runs/auto', request);
    await entered;
    expect(server.coordinator.listRuns()).toHaveLength(0);
    const resend = json('/runs/auto', request);
    writeFileSync(join(copy, 'a.txt'), 'Human edit before the run.\n');
    release();
    const [started, repeated] = await Promise.all([pending, resend]);
    expect(repeated.runId).toBe(started.runId);
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const done = await waitForProjection(transport, started.runId, (p) => p.status === 'succeeded');
    expect(done.status).toBe('succeeded');
    const changes = await json(
      `/sessions/${session.sessionId}/changes?scope=run&runId=${started.runId}`,
    );
    expect(changes.files).toEqual([]);
    expect(fake.seen.hostRequests).toHaveLength(1);
    expect(server.coordinator.listRuns()).toHaveLength(1);
  } finally {
    release();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
