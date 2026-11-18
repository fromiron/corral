import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import {
  canonicalJson,
  PAGE_ANNOTATION_WARNING,
  type PageAnnotation,
  SCHEMA_VERSION,
  type TextAttachment,
} from '@corral/contracts';
import {
  createTextAttachment,
  type SessionEntryStart,
  textAttachmentSource,
  waitForProjection,
} from '@corral/core';
import { Gate, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { startCorralServer } from '../src/index.ts';

// A browser annotation reaches the conversation as an ordinary text attachment
// (features/browser-annotate.md 계약: 첨부): the note body is `annotation.json`, and an ordinary
// page's note carries `page` provenance. The routes that take a request's attachments accept it
// and keep it as it was; a page provenance that carries a query, a fragment or credentials is
// refused.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const TOKEN = 'test-page-annotation-0123456789abcdef';
const START: SessionEntryStart = {
  choice: { modelProfile: 'model-a' },
  mode: 'mock',
  team: 'none',
};

async function boot() {
  // A run waits before its reply until the test opens this, so a steer finds it running.
  const hold = new Gate();
  cleanup.push(() => hold.open());
  const root = mkdtempSync(join(tmpdir(), 'corral-page-annotation-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: TOKEN,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      beforeReply: () => hold.wait(),
      reply: () => 'Done.',
    }),
  });
  cleanup.push(() => server.close());
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token: TOKEN }),
  });
  const headers = {
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    origin: server.url,
  };
  const call: typeof fetch = (input, init = {}) => {
    const merged = new Headers(init.headers);
    for (const [key, value] of Object.entries(headers)) merged.set(key, value);
    if (init.body && !merged.has('content-type')) merged.set('content-type', 'application/json');
    return fetch(input, { ...init, headers: merged });
  };
  const send = async (method: string, path: string, body: unknown) => {
    const response = await call(`${server.url}/api/v1${path}`, {
      method,
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const repository = new RestCorralRepository({ baseUrl: server.url, fetch: call });
  const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
  const created = await repository.createSession({ projectId: 'default', title: 'Notes' });
  if (!created.ok) throw new Error(created.message);
  return { send, repository, transport, hold, sessionId: created.session.sessionId };
}

const body: PageAnnotation = {
  warning: PAGE_ANNOTATION_WARNING,
  page: { kind: 'page', origin: 'https://shop.example', path: '/cart' },
  pickedAt: '2026-11-18T12:00:00.000Z',
  generation: 3,
  note: 'Make the button larger',
  element: {
    tag: 'button',
    role: null,
    selector: 'body > main:nth-of-type(1) > button:nth-of-type(2)',
    text: 'Pay',
    bounds: { x: 10, y: 20, width: 120, height: 32 },
    styles: { 'font-size': '16px' },
  },
  styles: [{ property: 'font-size', before: '16px', after: 'var(--size-lg)' }],
};
const note = (provenance: Record<string, unknown> = {}): TextAttachment =>
  createTextAttachment('annotation.json', 'application/json', JSON.stringify(body, null, 2), {
    kind: 'page',
    origin: 'https://shop.example',
    path: '/cart',
    pickedAt: '2026-11-18T12:00:00.000Z',
    generation: 3,
    screenshotHash: 'c'.repeat(64),
    ...provenance,
  } as TextAttachment['provenance'] & object);
// Built past the factory, which would refuse it: what a client could still send.
const forged = (provenance: Record<string, unknown>): TextAttachment => ({
  ...note(),
  provenance: { ...note().provenance, ...provenance } as TextAttachment['provenance'],
});
const BAD = [
  { path: '/cart?token=abc' },
  { path: '/cart#pay' },
  { origin: 'https://user:secret@shop.example' },
];

it('a recorded request keeps its page note and that note reads back unchanged', async () => {
  const s = await boot();
  const attachment = note();
  const added = await s.send('POST', `/sessions/${s.sessionId}/entries`, {
    intent: 'queue',
    text: 'Make the button larger',
    state: 'queued',
    attachments: [attachment],
  });
  expect(added.status).toBe(201);
  const session = await s.repository.getSession(s.sessionId);
  expect(session?.entries.at(-1)?.attachments).toEqual([attachment]);
});

it('a recorded request whose page note carries a query, a fragment or credentials is refused (반례)', async () => {
  const s = await boot();
  for (const provenance of BAD) {
    const added = await s.send('POST', `/sessions/${s.sessionId}/entries`, {
      intent: 'queue',
      text: 'Make the button larger',
      state: 'queued',
      attachments: [forged(provenance)],
    });
    expect(added.status).toBe(400);
  }
  expect((await s.repository.getSession(s.sessionId))?.entries).toEqual([]);
});

/** A running request in the conversation and its execution, for a steer to reach. */
async function running(s: Awaited<ReturnType<typeof boot>>) {
  const started = await s.transport.startAuto({
    ...START,
    commandId: 'cmd_running',
    sessionId: s.sessionId,
    brief: 'First request.',
  });
  const runId = started.runId ?? '';
  const projection = await waitForProjection(
    s.transport,
    runId,
    (p) => Object.keys(p.modelCalls).length > 0,
  );
  const steer = (commandId: string, delivery: string, attachment: TextAttachment) =>
    s.send('POST', `/runs/${runId}/commands`, {
      schemaVersion: SCHEMA_VERSION,
      commandId,
      runId,
      type: 'steer',
      payload: {
        targetExecutionId: projection.executionOrder[0] ?? '',
        text: 'Make the button larger',
        delivery,
        attachments: [attachment],
      },
    });
  return { runId, steer };
}

it('a join or an interrupt carries its page note to the running request', async () => {
  const s = await boot();
  const run = await running(s);
  for (const [index, delivery] of ['next_request', 'interrupt'].entries()) {
    const sent = await run.steer(`steer_note_${index}`, delivery, note());
    expect(sent.status).toBeLessThan(300);
    expect(sent.body.error ?? null).toBeNull();
  }
});

it('a join or an interrupt whose page note carries a query, a fragment or credentials is refused (반례)', async () => {
  const s = await boot();
  const run = await running(s);
  for (const delivery of ['next_request', 'interrupt'])
    for (const [index, provenance] of BAD.entries()) {
      const sent = await run.steer(`steer_bad_${delivery}_${index}`, delivery, forged(provenance));
      expect(sent.status).toBe(400);
    }
  // The same steer with a clean page note is taken: the refusals are the provenance's.
  const clean = await run.steer('steer_clean', 'next_request', note());
  expect(clean.status).toBeLessThan(300);
});

it('a started request takes its page note among its references, and the run reads it as attached source data, body and provenance unchanged', async () => {
  const s = await boot();
  s.hold.open();
  const attachment = note();
  const started = await s.transport.startAuto({
    ...START,
    commandId: 'cmd_note',
    sessionId: s.sessionId,
    brief: 'Make the button larger',
    references: [attachment],
  });
  expect(started.receipt.error ?? null).toBeNull();
  const brief = (await s.transport.getRunDefinition(started.runId ?? ''))?.input.brief ?? '';
  const { listing, body: attached } = textAttachmentSource(attachment);
  for (const part of [...listing, attached]) expect(brief).toContain(part);
  expect(brief).toContain(canonicalJson(attachment.provenance));
});

it('a started request whose page note carries a query, a fragment or credentials is refused (반례)', async () => {
  const s = await boot();
  for (const [index, provenance] of BAD.entries()) {
    const started = await s.send('POST', '/runs/auto', {
      schemaVersion: SCHEMA_VERSION,
      ...START,
      commandId: `cmd_bad_${index}`,
      sessionId: s.sessionId,
      brief: 'Make the button larger',
      references: [forged(provenance)],
    });
    expect(started.status).toBe(400);
  }
  // The same request with a clean page note goes through: the refusals are the provenance's.
  const clean = await s.send('POST', '/runs/auto', {
    schemaVersion: SCHEMA_VERSION,
    ...START,
    commandId: 'cmd_clean',
    sessionId: s.sessionId,
    brief: 'Make the button larger',
    references: [note()],
  });
  expect(clean.status).toBeLessThan(300);
});
