import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    if (!headers.has('origin')) headers.set('origin', server.url);
    return fetch(input, { ...init, headers });
  };
  return { call, cookie, login };
}

/** A request with headers fetch() would not send as given (Host). */
function rawStatus(base: string, path: string, headers: Record<string, string>) {
  const url = new URL(path, base);
  return new Promise<number>((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path: url.pathname, headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
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
    const final = await waitForProjection(transport, runId ?? '', (p) => p.status === 'succeeded');
    return { server, call, runId: runId ?? '', final };
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

  it('serves artifact bodies and snapshots of finished runs', async () => {
    const { server, call, runId, final } = await finishedRun();
    const versionId = final.output?.artifactVersionIds[0] ?? '';
    const text = await call(`${server.url}/api/v1/runs/${runId}/artifact-versions/${versionId}`);
    expect((await text.json()).text).toContain('writer (writer) turn 1');
    const snapshot = await (await call(`${server.url}/api/v1/runs/${runId}/snapshot`)).json();
    expect(snapshot.seq).toBe(final.lastSeq);
    expect(snapshot.projection).toEqual(final);
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
