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
import { createTextAttachment, type SessionEntryStart, textAttachmentSource } from '@corral/core';
import { ScriptedAgentAdapter } from '@corral/testkit';
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
  return { send, repository, transport, sessionId: created.session.sessionId };
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

it('a started request takes its page note among its references, and the run reads it as attached source data, body and provenance unchanged', async () => {
  const s = await boot();
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
