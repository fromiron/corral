import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import {
  type AgentAdapter,
  type CorralDefinition,
  DEFAULT_LIMITS,
  type RunEvent,
} from '@corral/contracts';
import { SPEC_HARD_CAPS, waitForProjection } from '@corral/core';
import { describeTransportContract } from '@corral/core/testing';
import { Gate, linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { type CorralServer, startCorralServer } from '../src/index.ts';

const TOKEN = 'test-bootstrap-token-0123456789abcdef';
const servers: CorralServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'corral-server-'));
  dirs.push(dir);
  return dir;
}

async function start(
  options: { agents?: AgentAdapter; workspace?: string; staticDir?: string } = {},
) {
  const server = await startCorralServer({
    workspace: options.workspace ?? tempWorkspace(),
    port: 0,
    agents: options.agents ?? new ScriptedAgentAdapter({ turns: 1 }),
    bootstrapToken: TOKEN,
    worktreeRoot: join(tempWorkspace(), 'worktrees'),
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
  });
  servers.push(server);
  return server;
}

/** A browser on the Studio origin: sends Origin and the session cookie like a real tab. */
async function browser(server: CorralServer) {
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
    headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
    if (!headers.has('origin')) headers.set('origin', server.url);
    return fetch(input, { ...init, headers });
  };
  return { call, cookie, login };
}

/** A request with headers fetch() would not send as given (Host). */
function rawStatus(
  base: string,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: object,
) {
  const url = new URL(base);
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, headers, method }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function saved(server: CorralServer, definition: CorralDefinition, call: typeof fetch) {
  const repo = new RestCorralRepository({ baseUrl: server.url, fetch: call });
  const result = await repo.save({
    definition,
    layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    expectedDefinitionRevision: null,
  });
  if (!result.ok) throw new Error(result.message);
  return result.record;
}

describeTransportContract('HTTP + SSE against the local server', async (agents) => {
  const server = await start({ agents });
  const { call } = await browser(server);
  return {
    transport: new HttpSseTransport({ baseUrl: server.url, fetch: call }),
    startRequest: async (definition, commandId) => {
      const record = await saved(server, definition, call);
      return {
        schemaVersion: '0.1',
        commandId,
        corralId: record.corralId,
        definitionRevision: record.definitionRevision,
        mode: 'mock',
      };
    },
  };
});

describe('local security boundary (C-055)', () => {
  it('refuses to listen anywhere but the loopback interface', async () => {
    await expect(
      startCorralServer({
        workspace: tempWorkspace(),
        host: '0.0.0.0',
        port: 0,
        agents: new ScriptedAgentAdapter({ turns: 1 }),
      }),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });

  it('[TC-SEC-002-H] trades a one-time bootstrap token for an HttpOnly, SameSite=Strict session', async () => {
    const server = await start();
    expect(server.bootstrapUrl).toBe(`${server.url}/#bootstrap=${TOKEN}`);
    const anonymous = await fetch(`${server.url}/api/v1/corrals`);
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe('SESSION_INVALID');

    const { call, login } = await browser(server);
    const cookie = login.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect((await call(`${server.url}/api/v1/corrals`)).status).toBe(200);

    const reused = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(reused.status).toBe(401);
  });

  it('[TC-SEC-002-N] rejects other origins and hosts before doing anything', async () => {
    const server = await start();
    const { call, cookie } = await browser(server);
    const create = (origin: string) =>
      call(`${server.url}/api/v1/corrals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          definition: linearCorral(['w']),
          layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
        }),
      });
    const evil = await create('https://evil.example');
    expect(evil.status).toBe(403);
    expect((await evil.json()).error.code).toBe('ORIGIN_REJECTED');
    const listed = await (await call(`${server.url}/api/v1/corrals`)).json();
    expect(listed).toEqual([]);

    // DNS rebinding: the right socket, a foreign Host name.
    const port = new URL(server.url).port;
    expect(await rawStatus(server.url, '/api/v1/health', { host: `evil.example:${port}` })).toBe(
      403,
    );
    expect(await rawStatus(server.url, '/api/v1/health', { host: `localhost:${port}` })).toBe(200);

    // No state change without an Origin header, even with a valid session.
    const noOrigin = await fetch(`${server.url}/api/v1/corrals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    expect(noOrigin.status).toBe(403);
  });

  it('[TC-SEC-002-N] requires the session CSRF token and rejects query secrets without echo', async () => {
    const server = await start();
    const { cookie } = await browser(server);
    const headers = { cookie, origin: server.url, 'content-type': 'application/json' };
    const missing = await fetch(`${server.url}/api/v1/corrals/validate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ definition: linearCorral(['writer']) }),
    });
    expect(missing.status).toBe(403);
    const session = await fetch(`${server.url}/api/v1/session`, { headers });
    const { csrfToken } = await session.json();
    expect(csrfToken).toEqual(expect.any(String));
    const good = await fetch(`${server.url}/api/v1/corrals/validate`, {
      method: 'POST',
      headers: { ...headers, 'x-corral-csrf': csrfToken },
      body: JSON.stringify({ definition: linearCorral(['writer']) }),
    });
    expect(good.status).toBe(200);
    const leaked = await fetch(`${server.url}/api/v1/health?api_key=private-sentinel`);
    expect(leaked.status).toBe(400);
    expect(await leaked.text()).not.toContain('private-sentinel');
  });

  it('[TC-SEC-002-N] protects encoded and absolute-form API routes with the same session and CSRF checks', async () => {
    const server = await start();
    const { cookie, login } = await browser(server);
    const headers = { origin: server.url, 'content-type': 'application/json' };
    const signed = {
      ...headers,
      cookie,
      'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    };
    const body = { title: 'Input', mimeType: 'text/plain', text: 'Registered once.' };
    for (const prefix of ['/%61pi/v1', '/%61%70%69/%76%31', `${server.url}/api/v1`]) {
      expect(await rawStatus(server.url, `${prefix}/corrals`, {})).toBe(401);
      expect(await rawStatus(server.url, `${prefix}/corrals`, {}, 'HEAD')).toBe(401);
      expect(await rawStatus(server.url, `${prefix}/corrals`, signed)).toBe(200);
      expect(await rawStatus(server.url, `${prefix}/health`, {})).toBe(200);
      expect(await rawStatus(server.url, `${prefix}/health?api_key=private-sentinel`, {})).toBe(
        400,
      );
      expect(await rawStatus(server.url, `${prefix}/health#api_key=private-sentinel`, {})).toBe(
        400,
      );
      const path = `${prefix}/documents/import`;
      expect(await rawStatus(server.url, path, headers, 'POST', body)).toBe(401);
      expect(await rawStatus(server.url, path, { ...headers, cookie }, 'POST', body)).toBe(403);
      expect(
        await rawStatus(server.url, path, { ...signed, 'x-corral-csrf': 'wrong' }, 'POST', body),
      ).toBe(403);
      expect(await rawStatus(server.url, path, signed, 'POST', body)).toBe(201);
    }
  });

  it('[TC-SEC-002-N] shares the mutation rate limit across canonical, encoded and absolute-form routes', async () => {
    const server = await start();
    const { cookie, login } = await browser(server);
    const headers = {
      cookie,
      origin: server.url,
      'content-type': 'application/json',
      'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    };
    const prefixes = ['/api/v1', '/%61pi/v1', `${server.url}/api/v1`];
    for (let i = 0; i < 120; i++) {
      const status = await rawStatus(
        server.url,
        `${prefixes[i % prefixes.length]}/documents/import`,
        headers,
        'POST',
        { title: 'Input', mimeType: 'text/plain', text: 'Registered once.' },
      );
      expect(status).toBe(i < 119 ? 201 : 429);
    }
  });

  it('[TC-SEC-002-N] bounds mutation rate and body size, without reflecting malformed body values', async () => {
    const server = await start();
    const { call } = await browser(server);
    const oversized = await call(`${server.url}/api/v1/documents/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Large',
        mimeType: 'text/plain',
        text: 'x'.repeat(2 * 1024 * 1024),
      }),
    });
    expect(oversized.status).toBe(413);
    const malformed = await call(`${server.url}/api/v1/documents/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'private-body-sentinel': 'secret' }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain('private-body-sentinel');
    let last: Response | undefined;
    for (let i = 0; i < 120; i++) {
      last = await call(`${server.url}/api/v1/corrals/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: linearCorral(['writer']) }),
      });
      await last.text();
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBe('60');
  });

  it('sends no CORS headers and a strict CSP on every response', async () => {
    const server = await start();
    const preflight = await fetch(`${server.url}/api/v1/corrals`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    const health = await fetch(`${server.url}/api/v1/health`);
    expect(health.headers.get('access-control-allow-origin')).toBeNull();
    const csp = health.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp.split('; ').find((value) => value.startsWith('script-src'))).toBe(
      "script-src 'self'",
    );
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await health.json();
    expect(body).toMatchObject({ ok: true, schemaVersion: '0.1' });
    expect(JSON.stringify(body)).not.toMatch(/token|key|secret/i);
  });

  it('serves Studio with the same CSP and falls back to index.html for app routes', async () => {
    const staticDir = join(tempWorkspace(), 'dist');
    await mkdir(staticDir);
    writeFileSync(
      join(staticDir, 'index.html'),
      '<!doctype html><html><head><title>Studio</title></head></html>',
    );
    const server = await start({ staticDir });
    const page = await fetch(`${server.url}/corrals/corral_x/edit`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<title>Studio</title>');
    expect(html).toContain('<meta name="corral-runtime" content="server">');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await fetch(`${server.url}/api/v1/nope`)).status).toBe(401);
  });
});

describe('REST: Corrals and runs (C-015, C-057)', () => {
  it('saves Corrals with separate revisions and refuses a stale save', async () => {
    const server = await start();
    const { call } = await browser(server);
    const repo = new RestCorralRepository({ baseUrl: server.url, fetch: call });
    const record = await saved(server, linearCorral(['writer']), call);
    expect(record).toMatchObject({ definitionRevision: 1, layoutRevision: 1 });
    const moved = await repo.save({
      definition: record.definition,
      layout: { nodes: { writer: { x: 10, y: 10 } }, viewport: { x: 0, y: 0, zoom: 1 } },
      expectedDefinitionRevision: 1,
    });
    expect(moved.ok && [moved.record.definitionRevision, moved.record.layoutRevision]).toEqual([
      1, 2,
    ]);
    const renamed = { ...record.definition, name: 'Renamed' };
    await repo.save({
      definition: renamed,
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      expectedDefinitionRevision: 1,
    });
    const stale = await repo.save({
      definition: record.definition,
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      expectedDefinitionRevision: 1,
    });
    expect(stale).toMatchObject({ ok: false, error: 'revision_conflict' });
    expect((await repo.list()).map((c) => c.name)).toEqual(['Renamed']);
    expect(await repo.get('corral_missing')).toBeNull();

    // The revision travels as If-Match (API-Contract §1); without it nothing is saved.
    const noPrecondition = await call(`${server.url}/api/v1/corrals/${record.corralId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definition: renamed,
        layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      }),
    });
    expect(noPrecondition.status).toBe(400);
  });

  it('runs the same scripted Corral to the same event order in a fresh workspace', async () => {
    const order = async () => {
      const server = await start();
      const { call } = await browser(server);
      const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
      const record = await saved(server, linearCorral(['research', 'writer']), call);
      const { runId } = await transport.startRun({
        schemaVersion: '0.1',
        commandId: 'cmd_same',
        corralId: record.corralId,
        definitionRevision: 1,
        mode: 'mock',
      });
      const events: RunEvent[] = [];
      transport.subscribe(runId ?? '', 0, { onEvent: (e) => events.push(e) });
      const final = await waitForProjection(
        transport,
        runId ?? '',
        (p) => p.status === 'succeeded',
      );
      while (events.length < final.lastSeq) await new Promise((r) => setTimeout(r, 10));
      return events.map((e) => e.type);
    };
    expect(await order()).toEqual(await order());
  });

  it('[TC-DEV-001-H] starts a run from a saved revision once per commandId; one run at a time', async () => {
    const gate = new Gate();
    const server = await start({
      agents: new ScriptedAgentAdapter({ turns: 1, beforeReply: () => gate.wait() }),
    });
    const { call } = await browser(server);
    const record = await saved(server, linearCorral(['writer']), call);
    const body = {
      schemaVersion: '0.1',
      commandId: 'cmd_run_1',
      corralId: record.corralId,
      definitionRevision: 1,
      mode: 'mock',
    };
    const post = (value: object) =>
      call(`${server.url}/api/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    const first = await post(body);
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created.receipt.status).toBe('applied');
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(created);
    const conflict = await post({ ...body, mode: 'live' });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).receipt.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const second = await post({ ...body, commandId: 'cmd_run_2' });
    expect(second.status).toBe(409);
    expect((await second.json()).receipt.error.code).toBe('RUN_ALREADY_ACTIVE');
    const missing = await post({ ...body, commandId: 'cmd_run_3', definitionRevision: 7 });
    expect(missing.status).toBe(404);
    const inline = await post({ ...body, commandId: 'cmd_run_4', definition: linearCorral(['w']) });
    expect(inline.status).toBe(400);
    gate.open();

    const history = await (await call(`${server.url}/api/v1/runs`)).json();
    expect(history.map((r: { runId: string }) => r.runId)).toEqual([created.runId]);
  });

  it('[TC-RACE-08] reports a queued steer as HTTP 202, not as applied', async () => {
    const gates = [new Gate(), new Gate()];
    let reply = 0;
    const server = await start({
      agents: new ScriptedAgentAdapter({
        turns: 2,
        beforeReply: () => gates[reply++]?.wait() ?? Promise.resolve(),
      }),
    });
    const { call } = await browser(server);
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const record = await saved(server, linearCorral(['writer']), call);
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_start',
      corralId: record.corralId,
      definitionRevision: 1,
      mode: 'mock',
    });
    const id = runId ?? '';
    const inFlight = await waitForProjection(
      transport,
      id,
      (p) => Object.values(p.modelCalls).length === 1,
    );
    const steer = {
      schemaVersion: '0.1',
      commandId: 'cmd_steer',
      runId: id,
      type: 'steer',
      payload: {
        targetExecutionId: inFlight.executionOrder[0],
        text: 'Primary sources only.',
        delivery: 'next_request',
      },
    };
    const sent = await call(`${server.url}/api/v1/runs/${id}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(steer),
    });
    expect(sent.status).toBe(202);
    expect((await sent.json()).status).toBe('queued');
    const unsupported = await call(`${server.url}/api/v1/runs/${id}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: '0.1',
        commandId: 'cmd_pause',
        runId: id,
        type: 'pause',
        payload: { scope: { kind: 'run' }, expectedControlRevision: 0 },
      }),
    });
    expect([501, 400]).toContain(unsupported.status);
    for (const gate of gates) gate.open();
    await waitForProjection(transport, id, (p) => p.status === 'succeeded');
    const receipt = await call(`${server.url}/api/v1/runs/${id}/commands/cmd_steer`);
    expect((await receipt.json()).status).toBe('applied');
  });
});

describe('SSE event stream (C-015)', () => {
  async function finishedRun() {
    const server = await start();
    const { call, cookie } = await browser(server);
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const record = await saved(server, linearCorral(['writer']), call);
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_start',
      corralId: record.corralId,
      definitionRevision: 1,
      mode: 'mock',
    });
    const final = await waitForProjection(transport, runId ?? '', (p) => p.status === 'succeeded');
    return { server, call, cookie, runId: runId ?? '', final };
  }

  /** Reads `count` SSE frames from a response body. */
  async function frames(response: Response, count: number) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();
    let text = '';
    const out: { id: string; event: string; data: RunEvent }[] = [];
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      let end = text.indexOf('\n\n');
      while (end >= 0) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        const fields = Object.fromEntries(
          block
            .split('\n')
            .filter((line) => line && !line.startsWith(':'))
            .map((line) => [
              line.slice(0, line.indexOf(':')),
              line.slice(line.indexOf(':') + 1).trim(),
            ]),
        );
        if (fields.data)
          out.push({
            id: fields.id ?? '',
            event: fields.event ?? '',
            data: JSON.parse(fields.data),
          });
        end = text.indexOf('\n\n');
      }
    }
    await reader.cancel();
    return out;
  }

  it('[TC-OBS-002-H] streams committed events after the cursor with id = runSeq', async () => {
    const { server, call, runId, final } = await finishedRun();
    const response = await call(`${server.url}/api/v1/runs/${runId}/events?after=3`);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const received = await frames(response, final.lastSeq - 3);
    expect(received.map((f) => Number(f.id))).toEqual(
      Array.from({ length: final.lastSeq - 3 }, (_, i) => i + 4),
    );
    expect(received.every((f) => f.event === 'domain' && f.data.runSeq === Number(f.id))).toBe(
      true,
    );
  });

  it('prefers a valid Last-Event-ID over ?after and rejects cursors out of range', async () => {
    const { server, call, runId, final } = await finishedRun();
    const resumed = await call(`${server.url}/api/v1/runs/${runId}/events?after=1`, {
      headers: { 'last-event-id': String(final.lastSeq - 1) },
    });
    const [only] = await frames(resumed, 1);
    expect(Number(only?.id)).toBe(final.lastSeq);
    for (const after of ['-1', 'abc', String(final.lastSeq + 1)]) {
      const bad = await call(`${server.url}/api/v1/runs/${runId}/events?after=${after}`);
      expect(bad.status).toBe(400);
    }
    expect((await call(`${server.url}/api/v1/runs/run_missing/events`)).status).toBe(404);
  });

  it('streams text frames to a live subscriber, without ids and without storing them', async () => {
    const gate = new Gate();
    const server = await start({
      agents: new ScriptedAgentAdapter({ turns: 1, beforeReply: () => gate.wait() }),
    });
    const { call } = await browser(server);
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const record = await saved(server, linearCorral(['writer']), call);
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_stream',
      corralId: record.corralId,
      definitionRevision: 1,
      mode: 'mock',
    });
    const frames: string[] = [];
    const subscribed = new Gate();
    const unsubscribe = transport.subscribe(runId ?? '', 0, {
      onEvent: (event) => {
        if (event.type === 'model.request_prepared') subscribed.open();
      },
      onFrame: (f) => frames.push(f.text),
    });
    // A separate snapshot can arrive before this HTTP stream is attached.
    await subscribed.wait();
    gate.open();
    const final = await waitForProjection(transport, runId ?? '', (p) => p.status === 'succeeded');
    const output = await transport.getArtifactText(
      runId ?? '',
      final.output?.artifactVersionIds[0] ?? '',
    );
    await expect.poll(() => frames.join('')).toBe(output);
    unsubscribe();
    const replay = await call(`${server.url}/api/v1/runs/${runId}/events?after=0`);
    const text = await (async () => {
      const reader = replay.body?.getReader();
      if (!reader) return '';
      const { value } = await reader.read();
      await reader.cancel();
      return new TextDecoder().decode(value);
    })();
    expect(text).not.toContain('event: stream');
  });

  it('[TC-OBS-002-N] flushes a bounded replay prefix so reconnect advances beyond 1 MiB', async () => {
    const gate = new Gate();
    const server = await start({
      agents: new ScriptedAgentAdapter({ turns: 1, beforeReply: () => gate.wait() }),
    });
    const { call } = await browser(server);
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const created = server.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_large_replay',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    const runId = created.runId ?? '';
    const active = await waitForProjection(
      transport,
      runId,
      (p) => Object.keys(p.modelCalls).length === 1,
    );
    for (let i = 0; i < 400; i++)
      server.coordinator.submit({
        schemaVersion: '0.1',
        commandId: `cmd_large_steer_${i}`,
        runId,
        type: 'steer',
        payload: {
          targetExecutionId: active.executionOrder[0] as string,
          text: 'x'.repeat(3000),
          delivery: 'next_request',
        },
      });
    const end = server.coordinator.findSnapshot(runId)?.seq ?? 0;
    let cursor = 0;
    for (let attempt = 0; cursor < end && attempt < 5; attempt++) {
      const response = await call(`${server.url}/api/v1/runs/${runId}/events?after=${cursor}`, {
        signal: AbortSignal.timeout(3000),
      });
      const received = await frames(response, end - cursor);
      expect(received.length).toBeGreaterThan(0);
      expect(Number(received[0]?.id)).toBe(cursor + 1);
      cursor = Number(received.at(-1)?.id);
    }
    expect(cursor).toBe(end);
    gate.open();
    await waitForProjection(transport, runId, (p) => p.status === 'succeeded');
  }, 30_000); // Over 1 MiB of events through SSE: room for a loaded CI runner (#25); assertions unchanged.

  it('[TC-OBS-002-N] replays an accepted cancellation larger than the outgoing buffer', async () => {
    const gate = new Gate();
    const server = await start({
      agents: new ScriptedAgentAdapter({ turns: 1, beforeReply: () => gate.wait() }),
    });
    const { call } = await browser(server);
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const created = server.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_oversized_cancel_run',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    const runId = created.runId ?? '';
    await waitForProjection(transport, runId, (p) => Object.keys(p.modelCalls).length === 1);
    const reason = 'x'.repeat(1_100_000);
    const accepted = await call(`${server.url}/api/v1/runs/${runId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: '0.1',
        commandId: 'cmd_oversized_cancel',
        runId,
        type: 'cancel',
        payload: { scope: { kind: 'run' }, reason },
      }),
    });
    expect(accepted.status).toBe(202);
    gate.open();
    const end = server.coordinator.findSnapshot(runId)?.seq ?? 0;
    const received: RunEvent[] = [];
    let cursor = 0;
    for (let attempt = 0; cursor < end && attempt < 5; attempt++) {
      const response = await call(`${server.url}/api/v1/runs/${runId}/events?after=${cursor}`, {
        signal: AbortSignal.timeout(3000),
      });
      const batch = await frames(response, end - cursor);
      expect(batch.length).toBeGreaterThan(0);
      expect(Number(batch[0]?.id)).toBe(cursor + 1);
      received.push(...batch.map((frame) => frame.data));
      cursor = Number(batch.at(-1)?.id);
    }
    expect(cursor).toBeGreaterThanOrEqual(end);
    expect(received.find((event) => event.type === 'cancel.requested')?.payload.reason).toBe(
      reason,
    );
  });

  it('[TC-OBS-002-N] reconnects through a stored patch larger than the request and client frame limits', async () => {
    const gate = new Gate();
    const server = await start({
      agents: new ScriptedAgentAdapter({ turns: 1, beforeReply: () => gate.wait() }),
    });
    const { call } = await browser(server);
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const created = server.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_oversized_patch_run',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    const runId = created.runId ?? '';
    await waitForProjection(transport, runId, (p) => Object.keys(p.modelCalls).length === 1);
    const prompts = ['x'.repeat(2_000_000), '나'.repeat(666_600)];
    for (const [index, prompt] of prompts.entries()) {
      const response = await call(`${server.url}/api/v1/runs/${runId}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '0.1',
          commandId: `cmd_oversized_patch_${index}`,
          runId,
          expectedControlRevision: server.coordinator.getSnapshot(runId).projection.controlRevision,
          type: 'patch',
          payload: { kind: 'node_future', nodeId: 'writer', prompt },
        }),
      });
      expect(response.ok).toBe(true);
    }
    const end = server.coordinator.getSnapshot(runId).seq;
    const received: RunEvent[] = [];
    const cursors: string[] = [];
    const replay = new HttpSseTransport({
      baseUrl: server.url,
      fetch: (input, init) => {
        cursors.push(new Headers(init?.headers).get('last-event-id') ?? '');
        return call(input, init);
      },
    });
    const stop = replay.subscribe(runId, 0, { onEvent: (event) => received.push(event) });
    try {
      await expect.poll(() => received.at(-1)?.runSeq).toBe(end);
      const patches = received.filter((event) => event.type === 'patch.committed');
      expect(patches).toHaveLength(2);
      expect(patches[1]?.payload.before.prompt).toBe(prompts[0]);
      expect(patches[1]?.payload.after.prompt).toBe(prompts[1]);
      expect(Buffer.byteLength(JSON.stringify(patches[1]))).toBeGreaterThan(3_900_000);
      expect(cursors.length).toBeGreaterThan(1);
      expect(received.map((event) => event.runSeq)).toEqual(
        Array.from({ length: end }, (_, index) => index + 1),
      );
    } finally {
      stop();
      gate.open();
    }
  });

  it('keeps every criteria patch version readable after a later revision', async () => {
    const gate = new Gate();
    const server = await start({
      agents: new ScriptedAgentAdapter({
        turns: 1,
        collaborate: false,
        beforeReply: async (_turn, input) => {
          if (input.round !== null) await gate.wait();
        },
      }),
    });
    const { call } = await browser(server);
    const created = server.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_criteria_history',
      definition: structuredClone(researchTeam) as CorralDefinition,
      mode: 'mock',
    });
    const runId = created.runId ?? '';
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const active = await waitForProjection(
      transport,
      runId,
      (p) => Object.keys(p.iterations).length > 0,
    );
    let versionId = active.currentCriteriaVersionId ?? '';
    const versions: { id: string; text: string }[] = [];
    for (let revision = 0; revision < 2; revision++) {
      const text = `Criteria revision ${revision + 1}`;
      const receipt = server.coordinator.submit({
        schemaVersion: '0.1',
        commandId: `cmd_criteria_patch_${revision}`,
        runId,
        type: 'patch',
        expectedControlRevision: revision,
        payload: { kind: 'criteria', baseCriteriaVersionId: versionId, criteria: [text] },
      });
      expect(receipt.status).toBe('applied');
      versionId = server.coordinator.findSnapshot(runId)?.projection.currentCriteriaVersionId ?? '';
      versions.push({ id: versionId, text });
    }
    for (const version of versions) {
      const response = await call(
        `${server.url}/api/v1/runs/${runId}/artifact-versions/${version.id}`,
      );
      expect(response.status).toBe(200);
      expect((await response.json()).text).toBe(version.text);
    }
    server.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cmd_criteria_cancel',
      runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'test complete' },
    });
    gate.open();
    await waitForProjection(transport, runId, (p) => p.status === 'cancelled');
  });

  it('[WBTST-034] serves an HTML result as an isolated preview (CR-009)', async () => {
    const page =
      '<!doctype html><html><body><h1>Page</h1><img src="https://tracker.example/p.png"><script>alert(1)</script></body></html>';
    const server = await start({
      agents: new ScriptedAgentAdapter({ turns: 1, appendNotes: false, reply: () => page }),
    });
    const { call, cookie } = await browser(server);
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const record = await saved(server, linearCorral(['writer']), call);
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_preview',
      corralId: record.corralId,
      definitionRevision: 1,
      mode: 'mock',
    });
    const final = await waitForProjection(transport, runId ?? '', (p) => p.status === 'succeeded');
    const versionId = final.output?.artifactVersionIds[0] ?? '';
    const url = `${server.url}/api/v1/runs/${runId}/artifact-versions/${versionId}/preview`;
    // An iframe load: same-site GET with the cookie and no Origin header.
    const preview = await fetch(url, { headers: { cookie } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toContain('text/html');
    expect(await preview.text()).toBe(page);
    const csp = preview.headers.get('content-security-policy') ?? '';
    expect(csp.split(';').map((d) => d.trim())).toEqual(
      expect.arrayContaining(['sandbox', "default-src 'none'", "frame-ancestors 'self'"]),
    );
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('allow-');
    expect(preview.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
    // Studio itself may frame its own origin, nothing else.
    const studioCsp = (await call(`${server.url}/api/v1/health`)).headers.get(
      'content-security-policy',
    );
    expect(studioCsp).toContain("frame-src 'self'");
    expect(studioCsp).toContain("frame-ancestors 'none'");
    // No session, no preview; unknown versions and non-HTML bodies are not previews.
    expect((await fetch(url)).status).toBe(401);
    expect(
      (
        await fetch(`${server.url}/api/v1/runs/${runId}/artifact-versions/nope/preview`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(404);
    const responseRef = Object.values(final.modelCalls)[0]?.responseRef ?? '';
    expect(
      (
        await fetch(`${server.url}/api/v1/runs/${runId}/artifact-versions/${responseRef}/preview`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(404);
  });

  it('[WBTST-034] does not preview a result that is not an HTML document', async () => {
    const { server, runId, final, cookie } = await finishedRun();
    const versionId = final.output?.artifactVersionIds[0] ?? '';
    const response = await fetch(
      `${server.url}/api/v1/runs/${runId}/artifact-versions/${versionId}/preview`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(404);
  });

  it('serves artifact bodies and snapshots of finished runs', async () => {
    const { server, call, runId, final } = await finishedRun();
    const versionId = final.output?.artifactVersionIds[0] ?? '';
    const text = await call(`${server.url}/api/v1/runs/${runId}/artifact-versions/${versionId}`);
    expect((await text.json()).text).toContain('writer (writer) turn 1');
    const modelCall = Object.values(final.modelCalls)[0];
    const responseText = await call(
      `${server.url}/api/v1/runs/${runId}/artifact-versions/${modelCall?.responseRef}`,
    );
    expect(responseText.status).toBe(200);
    expect((await responseText.json()).text).toContain('writer (writer) turn 1');
    const snapshot = await (await call(`${server.url}/api/v1/runs/${runId}/snapshot`)).json();
    expect(snapshot.seq).toBe(final.lastSeq);
    expect(snapshot.projection).toEqual(final);
  });
});

describe('registered input API and tool integration (C-043, C-044)', () => {
  it('imports text, searches and reads by ID through authorized Coordinator tools', async () => {
    let documentId = '';
    const seen: unknown[] = [];
    const server = await start({
      agents: new ScriptedAgentAdapter({
        turns: 1,
        script: async (_input, host) => {
          seen.push(await host.invokeTool({ name: 'search', args: { query: 'primary' } }));
          seen.push(await host.invokeTool({ name: 'read_document', args: { documentId } }));
          seen.push(
            await host.invokeTool({ name: 'read_document', args: { path: '/etc/passwd' } }),
          );
          return null;
        },
      }),
    });
    const { call } = await browser(server);
    const response = await call(`${server.url}/api/v1/documents/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Evidence',
        mimeType: 'text/markdown',
        text: 'A primary source.',
      }),
    });
    expect(response.status).toBe(201);
    documentId = (await response.json()).documentId;
    const listed = await (await call(`${server.url}/api/v1/documents`)).json();
    expect(listed).toMatchObject([{ id: documentId, kind: 'document', bytes: 17 }]);
    const definition = linearCorral(['writer']);
    definition.roles[0]?.allowedWorkTools.push('search', 'read_document');
    const created = server.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_inputs',
      definition,
      mode: 'mock',
    });
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const completed = await waitForProjection(
      transport,
      created.runId ?? '',
      (p) => p.status === 'succeeded',
    );
    const readCall = Object.values(completed.toolCalls).find(
      (tool) => tool.name === 'read_document' && tool.resultRef,
    );
    const readback = await call(
      `${server.url}/api/v1/runs/${created.runId}/artifact-versions/${readCall?.resultRef}`,
    );
    expect(readback.status).toBe(200);
    expect(JSON.parse((await readback.json()).text)).toMatchObject({
      documentId,
      text: 'A primary source.',
    });
    expect(
      (await call(`${server.url}/api/v1/runs/run_other/artifact-versions/${readCall?.resultRef}`))
        .status,
    ).toBe(404);
    expect(seen[0]).toMatchObject({
      ok: true,
      result: { provider: 'corpus', results: [{ documentId }] },
    });
    expect(seen[1]).toMatchObject({ ok: true, result: { documentId, text: 'A primary source.' } });
    expect(seen[2]).toMatchObject({ ok: false });
    const events: RunEvent[] = [];
    const stop = server.coordinator.subscribe(
      created.runId ?? '',
      0,
      (event) => events.push(event),
      () => {},
    );
    stop();
    expect(JSON.stringify(events)).not.toContain('/etc/passwd');
    const exported = await call(`${server.url}/api/v1/runs/${created.runId}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(exported.status).toBe(200);
    const bundle = await exported.text();
    expect(bundle).not.toContain('A primary source.');
    expect(bundle).not.toContain('/etc/passwd');
  });
});

describe('workspace configuration (C-062)', () => {
  it('starts with the Spec §9 defaults when there is no config file', async () => {
    const server = await start();
    expect(server.policy).toEqual(SPEC_HARD_CAPS);
  });

  it('refuses to start with an invalid config, naming the field', async () => {
    const workspace = tempWorkspace();
    await mkdir(join(workspace, '.corral'));
    writeFileSync(
      join(workspace, '.corral', 'config.json'),
      JSON.stringify({ schemaVersion: '0.1', hardCaps: { maxModelCalls: 500 } }),
    );
    await expect(start({ workspace })).rejects.toThrow(/hardCaps\.maxModelCalls/);
  });

  it('matches the Spec §9 table: defaults and hard caps', () => {
    const spec = readFileSync(join(import.meta.dirname, '../../../Corral-Spec-v0.1.md'), 'utf-8');
    const section = spec.slice(spec.indexOf('## 9.'), spec.indexOf('## 10.'));
    const row = (label: string) => {
      const line = section.split('\n').find((l) => l.startsWith(`| ${label}`));
      if (!line) throw new Error(`Spec §9 has no row ${label}`);
      return line.split('|').map((cell) => cell.trim());
    };
    const number = (text: string) => Number((text.match(/[\d,]+/)?.[0] ?? '').replaceAll(',', ''));
    expect(number(row('실행당 동적 생성')[2] ?? '')).toBe(DEFAULT_LIMITS.maxSpawns);
    expect(number(row('실행당 동적 생성')[3] ?? '')).toBe(SPEC_HARD_CAPS.maxSpawns);
    expect(number(row('실행당 모델 요청')[2] ?? '')).toBe(DEFAULT_LIMITS.maxModelCalls);
    expect(number(row('실행당 모델 요청')[3] ?? '')).toBe(SPEC_HARD_CAPS.maxModelCalls);
    expect(number(row('총 출력 토큰 예산')[2] ?? '')).toBe(DEFAULT_LIMITS.maxOutputTokens);
    expect(number(row('총 출력 토큰 예산')[3] ?? '')).toBe(SPEC_HARD_CAPS.maxOutputTokens);
    expect(number(row('요청별 출력 토큰 상한')[2] ?? '')).toBe(
      DEFAULT_LIMITS.maxOutputTokensPerCall,
    );
    expect(number(row('동시 모델 요청')[2] ?? '')).toBe(DEFAULT_LIMITS.maxModelConcurrency);
    expect(number(row('실행당 질문')[2] ?? '')).toBe(DEFAULT_LIMITS.maxQuestions);
    expect(number(row('질문 대기')[2] ?? '') * 1000).toBe(DEFAULT_LIMITS.questionTimeoutMs);
    expect(number(row('모델/문서 도구 timeout')[2] ?? '') * 1000).toBe(
      DEFAULT_LIMITS.modelTimeoutMs,
    );
    expect(number(row('전체 wall deadline')[2] ?? '') * 60_000).toBe(DEFAULT_LIMITS.runDeadlineMs);
    expect(number(row('Loop 자동 회차')[3] ?? '')).toBe(SPEC_HARD_CAPS.maxLoopIterations);
    expect(number(row('동적 위임 깊이')[2] ?? '')).toBe(DEFAULT_LIMITS.maxDelegationDepth);
  });
});

describe('REST: projects (CR-010)', () => {
  it('[WBTST-001] creates, renames and archives projects; Corrals and runs carry theirs', async () => {
    const server = await start();
    const { call } = await browser(server);
    const repo = new RestCorralRepository({ baseUrl: server.url, fetch: call });
    expect((await repo.listProjects()).map((p) => p.projectId)).toEqual(['default']);

    const created = await repo.createProject({ name: 'Docs', description: 'Writing' });
    if (!created.ok) throw new Error(created.message);
    const projectId = created.project.projectId;
    const corral = await repo.save({
      definition: linearCorral(['writer']),
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      expectedDefinitionRevision: null,
      projectId,
    });
    if (!corral.ok) throw new Error(corral.message);
    expect(corral.record.projectId).toBe(projectId);
    expect((await repo.list())[0]?.projectId).toBe(projectId);

    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_project_run',
      corralId: corral.record.corralId,
      definitionRevision: 1,
      mode: 'mock',
    });
    await waitForProjection(transport, runId ?? '', (p) => p.status === 'succeeded');
    expect((await transport.listRuns())[0]).toMatchObject({ runId, projectId });

    // Moved: the Corral goes, the finished run stays where it started.
    const moved = await repo.moveCorral(corral.record.corralId, 'default');
    expect(moved.ok && moved.record.projectId).toBe('default');
    expect((await transport.listRuns())[0]?.projectId).toBe(projectId);

    expect(
      await repo.updateProject(projectId, { name: 'Docs 2', expectedRevision: 1 }),
    ).toMatchObject({ ok: true, project: { name: 'Docs 2', revision: 2 } });
    expect(await repo.updateProject(projectId, { name: 'x', expectedRevision: 1 })).toMatchObject({
      ok: false,
      error: 'revision_conflict',
    });
    expect(
      await repo.updateProject('default', { archived: true, expectedRevision: 1 }),
    ).toMatchObject({ ok: false, error: 'invalid' });
    expect(await repo.createProject({ name: ' ' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await repo.moveCorral(corral.record.corralId, 'project_missing')).toMatchObject({
      ok: false,
      error: 'not_found',
    });
  });

  it('refuses project changes without a session or from another origin', async () => {
    const server = await start();
    const { call } = await browser(server);
    expect((await fetch(`${server.url}/api/v1/projects`)).status).toBe(401);
    const foreign = await call(`${server.url}/api/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(foreign.status).toBe(403);
    const extra = await call(`${server.url}/api/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', path: '/home/someone' }),
    });
    expect(extra.status).toBe(400);
  });
});

describe('REST: work sessions (CR-011)', () => {
  it('[WBTST-004] a follow-up and a question join the session; another project’s session is refused', async () => {
    const server = await start();
    const { call } = await browser(server);
    const repo = new RestCorralRepository({ baseUrl: server.url, fetch: call });
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const project = await repo.createProject({ name: 'P' });
    if (!project.ok) throw new Error(project.message);
    const projectId = project.project.projectId;
    const corral = await repo.save({
      definition: linearCorral(['writer']),
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      expectedDefinitionRevision: null,
      projectId,
    });
    if (!corral.ok) throw new Error(corral.message);
    const session = await repo.createSession({
      projectId,
      title: '',
      objective: 'Compare two databases',
      corralId: corral.record.corralId,
    });
    if (!session.ok) throw new Error(session.message);
    const sessionId = session.session.sessionId;

    const first = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_s1',
      corralId: corral.record.corralId,
      definitionRevision: 1,
      input: { brief: 'Compare SQLite and Postgres', criteria: ['Cite sources.'] },
      mode: 'mock',
      sessionId,
    });
    const done = await waitForProjection(
      transport,
      first.runId ?? '',
      (p) => p.status === 'succeeded',
    );
    const resultId = done.output?.artifactVersionIds[0] ?? '';
    const asked = await transport.startExplain({
      commandId: 'cmd_q1',
      sessionId,
      question: 'Which one for one writer?',
      modelProfile: 'model-a',
      mode: 'mock',
      startFrom: { runId: first.runId ?? '', artifactVersionId: resultId },
    });
    expect(asked.receipt.status).toBe('applied');
    await waitForProjection(transport, asked.runId ?? '', (p) => p.status === 'succeeded');
    const runs = await transport.listRuns();
    expect(runs.filter((r) => r.sessionId === sessionId).map((r) => r.projectId)).toEqual([
      projectId,
      projectId,
    ]);

    const entry = await repo.addSessionEntry(sessionId, {
      intent: 'next',
      text: 'Compare SQLite and Postgres',
      state: 'started',
      runId: first.runId,
    });
    expect(entry.ok && entry.session.entries).toHaveLength(1);

    // A session from another project cannot take this Corral's run.
    const other = await repo.createSession({ projectId: 'default', title: 'Elsewhere' });
    if (!other.ok) throw new Error(other.message);
    const refused = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_s2',
      corralId: corral.record.corralId,
      definitionRevision: 1,
      mode: 'mock',
      sessionId: other.session.sessionId,
    });
    expect(refused.runId).toBeNull();
    expect(refused.receipt.error?.code).toBe('TARGET_NOT_FOUND');
  });
});

describe('work folders and file changes (CR-012)', () => {
  function repo() {
    const dir = tempWorkspace();
    const run = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: dir,
      });
    run('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), 'hello\n');
    run('add', '.');
    run('commit', '-q', '-m', 'first');
    // Uncommitted work in the original stays out of the copy.
    writeFileSync(join(dir, 'draft.txt'), 'not committed\n');
    return dir;
  }

  it('[WBTST-016] links, copies, lets a run write through the broker, and compares', async () => {
    const original = repo();
    let replies = 0;
    const server = await start({
      agents: new ScriptedAgentAdapter({
        turns: 1,
        reply: (turn, input) =>
          `${input.role.name} (${input.nodeId}) turn ${turn}, reply ${++replies}`,
      }),
    });
    const { call } = await browser(server);
    const rest = new RestCorralRepository({ baseUrl: server.url, fetch: call });
    const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
    const json = async (path: string, method = 'GET', body?: unknown) => {
      const response = await call(`${server.url}/api/v1${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    };
    const linked = await json('/projects/default/workspace', 'PUT', { path: original });
    expect(linked.status).toBe(201);
    expect(linked.body.binding).toMatchObject({ isGit: true, trusted: false });
    expect(linked.body.binding.status.changed).toBe(1);

    const session = await rest.createSession({ projectId: 'default', title: 'Files' });
    if (!session.ok) throw new Error(session.message);
    const sessionId = session.session.sessionId;
    // No copy before the person trusts the repository.
    expect((await json(`/sessions/${sessionId}/worktree`, 'POST')).status).toBe(403);
    await json('/projects/default/workspace', 'PATCH', { trusted: true });
    const copy = await json(`/sessions/${sessionId}/worktree`, 'POST');
    expect(copy.status).toBe(201);

    const definition = linearCorral(['writer']);
    (definition.roles[0] as { allowedWorkTools: string[] }).allowedWorkTools = [
      'write_artifact',
      'list_files',
      'read_file',
      'write_file',
    ];
    const corral = await rest.save({
      definition,
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      expectedDefinitionRevision: null,
    });
    if (!corral.ok) throw new Error(corral.message);
    const startOne = async (commandId: string, brief: string) => {
      const started = await transport.startRun({
        schemaVersion: '0.1',
        commandId,
        corralId: corral.record.corralId,
        definitionRevision: 1,
        input: { brief, criteria: ['Cite sources.'] },
        mode: 'mock',
        sessionId,
      });
      await waitForProjection(transport, started.runId ?? '', (p) => p.status === 'succeeded');
      return started.runId ?? '';
    };
    const first = await startOne('cmd_files_1', 'Compare two options.');
    const changes = await json(`/sessions/${sessionId}/changes?scope=session`);
    expect(changes.body.files).toEqual([
      expect.objectContaining({
        path: 'notes/writer.md',
        status: 'added',
        provenance: 'managed_agent',
      }),
    ]);
    // The original folder is untouched.
    expect(existsSync(join(original, 'notes'))).toBe(false);

    // A second run reads the file before changing it; its own changes are its run's scope.
    const second = await startOne('cmd_files_2', 'Now for one writer only.');
    const runScope = await json(`/sessions/${sessionId}/changes?scope=run&runId=${second}`);
    expect(
      runScope.body.files.map((f: { path: string; status: string }) => [f.path, f.status]),
    ).toEqual([['notes/writer.md', 'modified']]);
    const versions = await json(
      `/sessions/${sessionId}/changes/file?from=${runScope.body.from}&to=${runScope.body.to}&path=notes/writer.md`,
    );
    expect(versions.body.before.kind).toBe('text');
    expect(versions.body.after.text).toContain('writer (writer) turn 1');
    const ops = await json(`/sessions/${sessionId}/file-operations`);
    expect(ops.body.map((o: { run_id: string; state: string }) => [o.run_id, o.state])).toEqual([
      [second, 'applied'],
      [first, 'applied'],
    ]);

    // Since the last review: nothing until something changes.
    expect((await json(`/sessions/${sessionId}/reviewed`, 'POST')).status).toBe(204);
    expect((await json(`/sessions/${sessionId}/changes?scope=review`)).body.files).toEqual([]);

    // An agreed check runs in the copy, without a shell, and records its result.
    await json('/projects/default/workspace', 'PATCH', {
      verifyCommands: [
        {
          id: 'ok',
          name: 'Exists',
          argv: ['node', '-e', "require('fs').statSync('notes/writer.md')"],
          timeoutMs: 20_000,
        },
        { id: 'bad', name: 'Fails', argv: ['node', '-e', 'process.exit(3)'], timeoutMs: 20_000 },
      ],
    });
    await json(`/sessions/${sessionId}/verifications`, 'POST', { commandId: 'ok' });
    await json(`/sessions/${sessionId}/verifications`, 'POST', { commandId: 'bad' });
    let checks: { commandId: string; state: string; exitCode: number | null; stale: boolean }[] =
      [];
    for (let i = 0; i < 100; i++) {
      checks = (await json(`/sessions/${sessionId}/verifications`)).body;
      if (checks.every((c) => c.state !== 'running')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(
      Object.fromEntries(checks.map((c) => [c.commandId, [c.state, c.exitCode, c.stale]])),
    ).toEqual({
      ok: ['passed', 0, false],
      bad: ['failed', 3, false],
    });
    const reports = (await json(`/sessions/${sessionId}/verifications`)).body;
    expect(reports.find((r: { commandId: string }) => r.commandId === 'ok').report).toMatchObject({
      state: 'completed',
      verdict: 'pass',
      owner: { kind: 'manual', sessionId },
    });
    await json('/projects/default/workspace', 'PATCH', {
      verifyCommands: [
        {
          id: 'wait',
          name: 'Wait',
          argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
          timeoutMs: 10000,
        },
      ],
    });
    const waiting = await json(`/sessions/${sessionId}/verifications`, 'POST', {
      commandId: 'wait',
    });
    expect(
      (
        await json(
          `/sessions/${sessionId}/verifications/${waiting.body.verificationId}/cancel`,
          'POST',
          {},
        )
      ).status,
    ).toBe(204);
    for (let i = 0; i < 100; i++) {
      const report = (await json(`/sessions/${sessionId}/verifications`)).body.find(
        (r: { verificationId: string }) => r.verificationId === waiting.body.verificationId,
      )?.report;
      if (report?.endedAt) {
        expect(report).toMatchObject({ state: 'cancelled', verdict: 'not_evaluated' });
        break;
      }
      if (i === 99) throw new Error('cancelled check did not finish');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
});
