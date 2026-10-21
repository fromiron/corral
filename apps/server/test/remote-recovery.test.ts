import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createStartRecovery, HttpSseTransport, RestCorralRepository } from '@corral/client';
import { waitForProjection } from '@corral/core';
import { Gate, linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { expect, it } from 'vitest';
import { createRunRecovery } from '../../../packages/react/src/run/recovery.ts';
import { createRunSession } from '../../../packages/react/src/run/session.ts';
import { startCorralServer } from '../src/index.ts';

it('[TC-ABS-014-H] real HTTP receipt lookup and persisted SSE prefix recover lost responses without another mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-remote-recovery-'));
  const gate = new Gate();
  const token = 'remote-recovery-test-bootstrap';
  const server = await startCorralServer({
    workspace: root,
    worktreeRoot: join(root, 'worktrees'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1, beforeReply: () => gate.wait() }),
  });
  const opened: ReturnType<typeof createRunSession>[] = [];
  try {
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const cookies = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const writes: string[] = [];
    const cursors: string[] = [];
    const lose = new Set(['/api/v1/runs', '/commands']);
    const call: typeof fetch = async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      const headers = new Headers(init.headers);
      headers.set('origin', server.url);
      headers.set('cookie', cookies);
      if (path.endsWith('/events')) cursors.push(headers.get('last-event-id') ?? '');
      const response = await fetch(input, { ...init, headers });
      if (init.method === 'POST' && (path === '/api/v1/runs' || path.endsWith('/commands'))) {
        writes.push(path);
        const key = path === '/api/v1/runs' ? path : '/commands';
        if (lose.delete(key)) {
          await response.text(); // The real server committed; only its response is lost.
          throw new TypeError('response lost');
        }
      }
      return response;
    };
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    const make = () => {
      const journal = createRunRecovery(storage, 'host_remote');
      const transport = new HttpSseTransport(
        { baseUrl: server.url, fetch: call },
        {
          commands: journal,
          starts: createStartRecovery(storage, 'host_remote'),
        },
      );
      return { journal, transport };
    };
    const repository = new RestCorralRepository({ baseUrl: server.url, fetch: call });
    const saved = await repository.save({
      definition: linearCorral(['writer']),
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      expectedDefinitionRevision: null,
    });
    if (!saved.ok) throw new Error(saved.message);
    const request = {
      schemaVersion: '0.1' as const,
      commandId: 'cmd_start_remote',
      corralId: saved.record.corralId,
      definitionRevision: 1,
      mode: 'mock' as const,
    };
    await expect(make().transport.startRun(request)).rejects.toThrow('response lost');
    const second = make();
    const recovered = await second.transport.startRun(request);
    expect(recovered.runId).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect(await second.transport.listRuns()).toHaveLength(1);
    const runId = recovered.runId as string;
    const first = createRunSession(second.transport, undefined, second.journal);
    opened.push(first);
    await first.getState().open(runId);
    await expect.poll(() => first.getState().events.length).toBeGreaterThan(0);
    await expect(
      first.getState().sendCommand({ type: 'pause', payload: { scope: 'run' } }),
    ).rejects.toThrow('response lost');
    const pendingId = Object.keys(first.getState().unconfirmedCommands)[0] as string;
    const seq = first.getState().events.at(-1)?.runSeq ?? 0;
    first.getState().dispose();
    const third = make();
    const restored = createRunSession(third.transport, undefined, third.journal);
    opened.push(restored);
    await restored.getState().open(runId);
    expect(restored.getState().receipts[pendingId]?.commandId).toBe(pendingId);
    expect(restored.getState().unconfirmedCommands).toEqual({});
    await expect.poll(() => cursors.length).toBeGreaterThanOrEqual(2);
    expect(Number(cursors.at(-1))).toBeGreaterThanOrEqual(seq);
    expect(writes).toHaveLength(2);
    expect(restored.getState().events[0]?.runSeq).toBe(1);
  } finally {
    for (const store of opened) store.getState().dispose();
    gate.open();
    await server.close();
    const within = relative(resolve(tmpdir()), resolve(root));
    assert(within.startsWith('corral-remote-recovery-'), 'Unexpected cleanup target');
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

it('[TC-ABS-014-H] Editor start after remount recovers a completed lost start without creating another Run', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'corral-remote-editor-'));
  const token = 'remote-editor-test-bootstrap';
  const server = await startCorralServer({
    workspace,
    port: 0,
    bootstrapToken: token,
    worktreeRoot: join(workspace, 'worktrees'),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  const views: ReturnType<typeof createRunSession>[] = [];
  try {
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    let startPosts = 0;
    const call: typeof fetch = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('cookie', cookie);
      headers.set('origin', server.url);
      const result = await fetch(input, { ...init, headers });
      if (new URL(String(input)).pathname === '/api/v1/runs' && init.method === 'POST') {
        startPosts++;
        if (startPosts === 1) {
          await result.text();
          throw new TypeError('Editor start response lost');
        }
      }
      return result;
    };
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
    const transport = () =>
      new HttpSseTransport(
        { baseUrl: server.url, fetch: call },
        {
          commands: createRunRecovery(storage, 'host_editor'),
          starts: createStartRecovery(storage, 'host_editor'),
        },
      );
    const repository = new RestCorralRepository({ baseUrl: server.url, fetch: call });
    const definition = linearCorral(['writer']);
    const saved = await repository.save({
      definition,
      expectedDefinitionRevision: null,
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    });
    if (!saved.ok) throw new Error(saved.message);
    const revision = { corralId: saved.record.corralId, definitionRevision: 1 };
    // Exactly EditorPage's construction: no composer ID memory or additional store journal.
    const original = createRunSession(transport(), () => 'cmd_editor_original');
    views.push(original);
    await original.getState().start(definition, revision, 'mock');
    expect(original.getState().streamError).toContain('Editor start response lost');
    original.getState().dispose();
    const restoredTransport = transport();
    const firstRun = (await restoredTransport.listRuns())[0];
    if (!firstRun) throw new Error('Original Run missing');
    await waitForProjection(
      restoredTransport,
      firstRun.runId,
      (state) => state.status === 'succeeded',
    );
    const remounted = createRunSession(restoredTransport, () => 'cmd_editor_remounted');
    views.push(remounted);
    await remounted.getState().start(definition, revision, 'mock');
    expect(remounted.getState().runId).toBe(firstRun.runId);
    expect(startPosts).toBe(1);
    expect(await restoredTransport.listRuns()).toHaveLength(1);
  } finally {
    for (const view of views) view.getState().dispose();
    await server.close();
    assert(relative(resolve(tmpdir()), resolve(workspace)).startsWith('corral-remote-editor-'));
    rmSync(workspace, { recursive: true, force: true });
  }
}, 30000);
