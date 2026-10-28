import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository, TerminalsApi } from '@corral/client';
import type { TerminalInput } from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import { FakeClock, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { type CorralServer, startCorralServer } from '../src/index.ts';
import { PtyRuntime } from '../src/processes/pty.ts';

let server: CorralServer | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (server) await server.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('keeps session, Origin and CSRF checks while isolating interactive frames from ordinary writes', async () => {
  const inputCall = vi
    .spyOn(PtyRuntime.prototype, 'input')
    .mockImplementation((_session, _id, frame) => ({
      generation: frame.generation,
      controllerGeneration: frame.controllerGeneration,
      acceptedSequence: frame.sequence,
    }));
  directory = mkdtempSync(join(tmpdir(), 'corral-terminal-auth-'));
  const clock = new FakeClock();
  const token = 'terminal-auth-fixture-0123456789abcdef';
  server = await startCorralServer({
    workspace: join(directory, 'workspace'),
    worktreeRoot: join(directory, 'copies'),
    bootstrapToken: token,
    clock,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    port: 0,
  });
  const origin = server.url;
  const login = await fetch(`${origin}/api/v1/session`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  expect(login.status).toBe(204);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const csrf = login.headers.get('x-corral-csrf') ?? '';
  const browserFetch: typeof fetch = (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('origin', origin);
    headers.set('cookie', cookie);
    return fetch(url, { ...init, headers });
  };
  const repository = new RestCorralRepository({ baseUrl: origin, fetch: browserFetch });
  const created = await repository.createSession({
    projectId: 'default',
    title: 'Terminal transport',
  });
  if (!created.ok) throw new Error(created.message);
  const sessionId = created.session.sessionId;
  const input: TerminalInput = {
    target: {
      hostId: 'host',
      projectId: 'default',
      bindingId: 'binding',
      sessionId,
      copyGeneration: 1,
    },
    generation: 'generation',
    attachmentId: 'attachment',
    controllerGeneration: 1,
    sequence: 1,
    data: 'x',
  };
  const path = `${origin}/api/v1/sessions/${sessionId}/terminals/terminal/input`;
  const call = (headers: Record<string, string>, suffix = '') =>
    fetch(path + suffix, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(input),
    });
  expect((await call({ origin })).status).toBe(401);
  expect((await call({ origin, cookie })).status).toBe(403);
  expect(
    (await call({ origin: 'https://other.example', cookie, 'x-corral-csrf': csrf })).status,
  ).toBe(403);
  expect(
    (await call({ origin, cookie, 'x-corral-csrf': csrf }, '?token=not-a-credential')).status,
  ).toBe(400);
  expect(inputCall).not.toHaveBeenCalled();
  const api = new TerminalsApi({ baseUrl: origin, fetch: browserFetch });
  for (let i = 0; i < 130; i++) {
    if (i === 65) clock.advance(1000);
    await expect(
      api.input(sessionId, 'terminal', { ...input, sequence: i + 1 }),
    ).resolves.toMatchObject({ acceptedSequence: i + 1 });
  }
  expect(inputCall).toHaveBeenCalledTimes(130);
  const imported = await browserFetch(`${origin}/api/v1/documents/import`, {
    method: 'POST',
    headers: { 'x-corral-csrf': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Fixture',
      mimeType: 'text/plain',
      text: 'ordinary mutation still available',
    }),
  });
  expect(imported.status).toBe(201);
});

it.each(['active', 'uncertain'] as const)(
  'keeps %s terminal owner in HTTP start receipts and reopened session records',
  async (state) => {
    directory = mkdtempSync(join(tmpdir(), 'corral-terminal-owner-'));
    const token = 'terminal-owner-fixture-0123456789abcdef';
    server = await startCorralServer({
      workspace: join(directory, 'workspace'),
      worktreeRoot: join(directory, 'copies'),
      bootstrapToken: token,
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      port: 0,
    });
    const origin = server.url;
    const login = await fetch(`${origin}/api/v1/session`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(login.status).toBe(204);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const browserFetch: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('origin', origin);
      headers.set('cookie', cookie);
      return fetch(url, { ...init, headers });
    };
    const options = { baseUrl: origin, fetch: browserFetch };
    const repository = new RestCorralRepository(options);
    const created = await repository.createSession({
      projectId: 'default',
      title: 'Owner diagnostics',
    });
    if (!created.ok) throw new Error(created.message);
    const sessionId = created.session.sessionId;
    const owner = { kind: 'terminal' as const, id: 'diagnostic_owner', sessionId, state };
    const message =
      state === 'uncertain' ? 'Termination has not been attested' : 'A terminal holds the copy';
    vi.spyOn(WorkspaceService.prototype, 'acquireRun').mockImplementation(() => {
      throw new ToolRefusal('RUN_ALREADY_ACTIVE', message, owner);
    });
    const stop = vi.spyOn(PtyRuntime.prototype, 'stop');
    const transport = new HttpSseTransport(options);
    const result = await transport.startAuto({
      commandId: 'owner_refusal',
      sessionId,
      brief: 'Keep this draft',
      choice: { modelProfile: 'model-a' },
      team: 'none',
      mode: 'mock',
    });
    expect(result.runId).toBeNull();
    expect(result.receipt.error).toEqual({ code: 'RUN_ALREADY_ACTIVE', message, owner });
    const saved = await repository.addSessionEntry(sessionId, {
      intent: 'next',
      text: 'Keep this draft',
      state: 'refused',
      commandId: 'owner_refusal',
      detail: message,
      refusal: result.receipt.error,
    });
    expect(saved.ok).toBe(true);
    const reopened = await new RestCorralRepository(options).getSession(sessionId);
    expect(reopened?.entries[0]).toMatchObject({
      state: 'refused',
      text: 'Keep this draft',
      refusal: { code: 'RUN_ALREADY_ACTIVE', message, owner },
    });
    await expect(
      repository.addSessionEntry(sessionId, {
        intent: 'next',
        text: 'diagnostic size guard',
        state: 'refused',
        refusal: { code: 'RUN_ALREADY_ACTIVE', message: 'x'.repeat(2001), owner },
      }),
    ).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(stop).not.toHaveBeenCalled();
    expect(server.coordinator.listRuns()).toHaveLength(0);
  },
);
