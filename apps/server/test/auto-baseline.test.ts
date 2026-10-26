import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport } from '@corral/client';
import { waitForProjection } from '@corral/core';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { expect, it } from 'vitest';
import { startCorralServer } from '../src/index.ts';
import { FAKE_PROFILES, fakeOpenAI, fauxAssistantMessage, fauxToolCall } from '../src/testing.ts';

it.each(['edit', 'create', 'remove'] as const)(
  'pins the file baseline and tools after %s while choosing, once for resends',
  async (change) => {
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
        return response.status === 204 ? null : response.json();
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
      if (change === 'create')
        await json(
          '/harness/profiles/auto_commands',
          {
            expectedRevision: 0,
            profile: {
              name: 'Explicit Auto commands',
              policy: 'trusted-native',
              allowedTools: [
                'run_command',
                'preview_file',
                'preview_app',
                'preview_action',
                'list_files',
                'read',
                'read_file',
                'write',
                'edit',
                'write_file',
                'write_artifact',
                'submit_result',
                'ask_user',
                'update_plan',
              ],
              resources: [],
              startupCommands: [],
            },
          },
          'PUT',
        );
      if (change !== 'create') await json(`/sessions/${session.sessionId}/worktree`, {});
      const worktreeRoot = join(root, 'worktrees');
      const workspaceId = change === 'create' ? null : readdirSync(worktreeRoot)[0];
      if (change !== 'create' && !workspaceId)
        throw new Error('the test working copy was not created');
      const copy = workspaceId ? join(worktreeRoot, workspaceId, session.sessionId) : '';
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
        ...(change === 'create'
          ? [
              fauxAssistantMessage(
                [
                  fauxToolCall('run_command', {
                    command:
                      process.platform === 'win32'
                        ? "Set-Content -LiteralPath 'command-proof.txt' -Value 'Auto command reached worktree'"
                        : "printf 'Auto command reached worktree\\n' > command-proof.txt",
                  }),
                ],
                { stopReason: 'toolUse' },
              ),
            ]
          : []),
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
        brief:
          change === 'create'
            ? 'Create command-proof.txt with the requested proof text using the shell.'
            : 'Explain the file without changing it.',
        choice: { modelProfile: 'model-a' },
        mode: 'live',
        ...(change === 'create'
          ? {
              permissionMode: 'auto' as const,
              harness: { profileId: 'auto_commands', revision: 1 },
            }
          : {}),
      };
      const pending = json('/runs/auto', request);
      await entered;
      expect(server.coordinator.listRuns()).toHaveLength(0);
      const resend = json('/runs/auto', request);
      if (change === 'edit') writeFileSync(join(copy, 'a.txt'), 'Human edit before the run.\n');
      else
        await json(
          `/sessions/${session.sessionId}/worktree`,
          {},
          change === 'create' ? 'POST' : 'DELETE',
        );
      release();
      const [started, repeated] = await Promise.all([pending, resend]);
      expect(repeated.runId).toBe(started.runId);
      const tools =
        server.coordinator.getRunSnapshot(started.runId)?.definition.roles[0]?.allowedWorkTools ??
        [];
      expect(tools.includes('read_file')).toBe(change !== 'remove');
      for (const tool of ['run_command', 'preview_file', 'preview_app', 'preview_action'] as const)
        expect(tools.includes(tool)).toBe(change === 'create');
      expect(tools.includes('write_file')).toBe(change !== 'remove');
      if (change === 'create')
        expect(
          server.coordinator.getRunSnapshot(started.runId)?.definition.roles[0]?.harness,
        ).toEqual({ profileId: 'auto_commands', revision: 1 });
      const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
      const done = await waitForProjection(transport, started.runId, (p) =>
        ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.status),
      );
      expect(done.status).toBe('succeeded');
      if (change !== 'remove') {
        const changes = await json(
          `/sessions/${session.sessionId}/changes?scope=run&runId=${started.runId}`,
        );
        if (change === 'create') {
          expect(changes.files).toEqual(
            expect.arrayContaining([expect.objectContaining({ path: 'command-proof.txt' })]),
          );
          const binding = readdirSync(worktreeRoot)[0];
          if (!binding) throw new Error('working copy unavailable');
          expect(
            readFileSync(
              join(worktreeRoot, binding, session.sessionId, 'command-proof.txt'),
              'utf8',
            ).trim(),
          ).toBe('Auto command reached worktree');
        } else expect(changes.files).toEqual([]);
      }
      expect(fake.seen.hostRequests).toHaveLength(1);
      expect(server.coordinator.listRuns()).toHaveLength(1);
    } finally {
      release();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
