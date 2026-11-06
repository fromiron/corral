// A local labeling page. It binds to loopback, rejects other hosts and origins, and sends the page
// only the text to judge, so a label cannot be swayed by a split, a source or a retest link.
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { EFFORT_LEVELS } from '../../../packages/contracts/src/index.ts';
import type { GoldItem } from './sample.ts';
import { assertPrivateDirectory } from './store.ts';

type Label = string | { participantIds: string[] } | null;
interface Entry {
  id: string;
  label: Label;
  at: string;
}

const PAGE = new URL('./label-page.html', import.meta.url);
const POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

export function itemText(item: GoldItem) {
  if (item.kind === 'effort') {
    const { kind: stage, request, prevRequest, prev, plan, calls } = item.input;
    return { id: item.id, kind: item.kind, stage, request, prevRequest, prev, plan, calls };
  }
  const { message, participants, history } = item.input;
  return {
    id: item.id,
    kind: item.kind,
    message,
    participants: participants.map((p) => ({
      participantId: p.participantId,
      name: item.names[p.participantId] ?? p.participantId,
      prompt: p.prompt,
    })),
    history: history.map((h) => ({
      speaker: h.participantId === null ? '사람' : (item.names[h.participantId] ?? h.participantId),
      human: h.participantId === null,
      text: h.text,
    })),
  };
}

function validLabel(item: GoldItem, label: unknown): label is Label {
  if (item.kind === 'effort')
    return label === 'unsure' || (EFFORT_LEVELS as readonly unknown[]).includes(label);
  if (label === 'ambiguous') return true;
  const ids = (label as { participantIds?: unknown })?.participantIds;
  const known = item.input.participants.map((p) => p.participantId);
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    new Set(ids).size === ids.length &&
    ids.every((id) => known.includes(id))
  );
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 64_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function labelServer(
  dir: string,
  now: () => string = () => new Date().toISOString(),
): Server {
  const items = readFileSync(join(dir, 'items.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GoldItem)
    .filter((item) => item.kind === 'effort' || !item.chosen);
  const byId = new Map(items.map((item) => [item.id, item]));
  const path = join(dir, 'labels.jsonl');
  const log: Entry[] = existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Entry)
    : [];
  const latest = () => new Map(log.map((entry) => [entry.id, entry.label]));
  const write = (entry: Entry) => {
    log.push(entry);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    const { port } = server.address() as { port: number };
    const local = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = req.headers.origin;
    const sameOrigin = local.some((host) => origin === `http://${host}`);
    if (!local.includes(req.headers.host ?? '') || (req.method !== 'GET' && !sameOrigin)) {
      reply(res, 403, { error: 'local only' });
      return;
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': POLICY,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(readFileSync(PAGE));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/next') {
      const labels = latest();
      const open = items.filter((item) => !labels.get(item.id));
      const first = open[0];
      reply(res, 200, {
        item: first ? itemText(first) : null,
        done: items.length - open.length,
        total: items.length,
      });
      return;
    }
    if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) {
      reply(res, 404, { error: 'not found' });
      return;
    }
    if (req.url === '/api/undo') {
      const labels = latest();
      const last = log.findLast((entry) => entry.label && labels.get(entry.id));
      if (last) write({ id: last.id, label: null, at: now() });
      reply(res, 200, { id: last?.id ?? null });
      return;
    }
    if (req.url !== '/api/label') {
      reply(res, 404, { error: 'not found' });
      return;
    }
    try {
      const { id, label } = JSON.parse(await readBody(req)) as { id?: string; label?: unknown };
      const item = id ? byId.get(id) : undefined;
      if (!id || !item || !validLabel(item, label) || label === null) {
        reply(res, 400, { error: 'invalid label' });
        return;
      }
      write({ id, label, at: now() });
      reply(res, 200, { ok: true });
    } catch {
      reply(res, 400, { error: 'invalid request' });
    }
  });
  return server;
}

if (import.meta.main) {
  const [dir, port] = process.argv.slice(2);
  if (!dir) throw new Error('usage: label.ts <gold-dir> [port]');
  const server = labelServer(assertPrivateDirectory(dir));
  server.listen(Number(port ?? 4179), '127.0.0.1', () => {
    const { port: bound } = server.address() as { port: number };
    console.log(`http://127.0.0.1:${bound}/`);
  });
}
