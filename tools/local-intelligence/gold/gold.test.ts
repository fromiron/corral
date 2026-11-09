import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { itemText, labelServer } from './label.ts';
import { meetingItems, type StoredMeeting } from './meeting.ts';
import { sampleItems } from './sample.ts';
import { scrub } from './scrub.ts';
import { assertPrivateDirectory, writePrivate } from './store.ts';

test('scrub removes credentials, contact details and home paths', () => {
  const samples = [
    'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz',
    'AIzaSyabcdefghijklmnopqrstuvwxyz0123456',
    'xoxb-123456789012-abcdefghijkl',
    'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123_-',
  ];
  for (const secret of samples) assert.ok(!scrub(`key ${secret} end`).includes(secret), secret);
  assert.ok(!scrub('Authorization: Bearer abc.def-123456').includes('abc.def-123456'));
  assert.ok(!scrub('API_KEY=plain-value-1').includes('plain-value-1'));
  assert.ok(!scrub('"password": "hunter2hunter2"').includes('hunter2hunter2'));
  assert.ok(!scrub('open http://127.0.0.1:3080/?token=abc123def456 now').includes('abc123def456'));
  assert.ok(!scrub('write to me@example.com').includes('me@example.com'));
  assert.ok(!scrub('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----').includes('abc'));
  assert.equal(scrub('see /home/user/repo/a.ts'), 'see ~/repo/a.ts');
  assert.equal(scrub('see /Users/user/a.ts'), 'see ~/a.ts');
  assert.equal(scrub('C:\\Users\\user\\a.ts'), '~\\a.ts');
  // Ordinary development text stays readable for the person labeling it.
  const plain = 'token 수를 줄여줘. password 입력 필드의 라벨을 고쳐줘. pnpm test 실행.';
  assert.equal(scrub(plain), plain);
});

test('scrub hides opaque encrypted tokens', () => {
  const token = `gAAAAAB${'aZ09_-'.repeat(20)}`;
  assert.ok(!scrub(`{"payload":"${token}"}`).includes(token));
});

const meeting: StoredMeeting = {
  config: {
    participants: [
      { participantId: 'a', name: 'GPT', prompt: '' },
      { participantId: 'b', name: 'Claude', prompt: '보안 담당' },
    ],
  },
  rounds: [
    {
      kind: 'all',
      message: '첫 질문',
      participantIds: ['a', 'b'],
      answers: [
        { participantId: 'a', runId: 'r1', state: 'started', order: 2 },
        { participantId: 'b', runId: 'r2', state: 'started', order: 1 },
      ],
    },
    {
      kind: 'mention',
      message: '보안만 답해줘',
      participantIds: ['b'],
      answers: [{ participantId: 'b', runId: 'r3', state: 'started' }],
    },
    {
      kind: 'mention',
      message: '@Claude 답해줘',
      participantIds: ['b'],
      answers: [{ participantId: 'b', runId: 'r4', state: 'started' }],
    },
    {
      kind: 'mention',
      message: '에이전트 호출',
      participantIds: ['a'],
      replyTo: { roundId: 'x', participantId: 'b' },
      answers: [],
    },
    {
      kind: 'all',
      message: '다음 질문',
      participantIds: ['a', 'b'],
      answers: [{ participantId: 'a', runId: 'r5', state: 'refused' }],
    },
    { kind: 'secretary', message: '정리해줘', participantIds: [], answers: [] },
  ],
};
const texts: Record<string, string> = {
  r1: '답 일',
  r2: '답 이',
  r3: '답 삼',
  r4: '답 사',
  r5: '거절',
};

test('meeting items use only what the selector could have seen', () => {
  const items = meetingItems(meeting, (id) => texts[id] ?? null);
  assert.deepEqual(
    items.map((i) => i.input.message),
    ['첫 질문', '보안만 답해줘', '다음 질문'],
  );
  const [first, second, third] = items;
  assert.deepEqual(first!.input.history, []);
  // No future round leaks into an earlier decision, and order follows recorded answer order.
  assert.deepEqual(second!.input.history, [
    { participantId: null, text: '첫 질문' },
    { participantId: 'b', text: '답 이' },
    { participantId: 'a', text: '답 일' },
  ]);
  assert.ok(!JSON.stringify(third!.input.history).includes('거절'));
  // A person's own recipient choice is a label; rounds that never reach the selector are skipped.
  assert.equal(first!.chosen, undefined);
  assert.deepEqual(second!.chosen, ['b']);
  assert.deepEqual(first!.input.participants, [
    { participantId: 'a', prompt: '' },
    { participantId: 'b', prompt: '보안 담당' },
  ]);
  assert.deepEqual(first!.names, { a: 'GPT', b: 'Claude' });
});

const items = () => meetingItems(meeting, (id) => texts[id] ?? null);

test('sampling is repeatable and hides retests among ordinary items', () => {
  const options = { seed: 'a', retestShare: 0.5 };
  const first = sampleItems(items(), options);
  assert.deepEqual(first, sampleItems(items(), options));
  const retests = first.filter((i) => i.retestOf);
  assert.equal(retests.length, 1);
  const originals = new Map(first.map((i) => [i.id, i]));
  for (const item of retests) {
    assert.notEqual(item.id, item.retestOf);
    assert.equal(originals.get(item.retestOf!)?.group, item.group);
    // A person's own recipient choice is already a label and is never repeated.
    assert.equal(originals.get(item.retestOf!)?.chosen, undefined);
  }
  assert.deepEqual([...new Set(first.map((i) => i.id))].length, first.length, 'ids must be unique');
});

test('a whole session stays on one side of the tuning and final split', () => {
  const sampled = sampleItems(items(), { seed: 'a', retestShare: 0 });
  assert.equal(new Set(sampled.map((i) => i.split)).size, 1);
});

test('private storage refuses a repository and keeps files owner-only', () => {
  assert.throws(() => assertPrivateDirectory(join(process.cwd(), 'tools/gold-out')), /repository/);
  const root = mkdtempSync(join(tmpdir(), 'gold-store-'));
  try {
    const dir = join(root, 'gold');
    assertPrivateDirectory(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    writePrivate(join(dir, 'items.jsonl'), 'x');
    assert.equal(statSync(join(dir, 'items.jsonl')).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

let server: Server;
let port: number;
let dir: string;
const send = (
  path: string,
  options: { method?: string; body?: unknown; headers?: IncomingHttpHeaders } = {},
) =>
  new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
const post = (path: string, body: unknown) =>
  send(path, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
    },
  });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gold-label-'));
  const sampled = sampleItems(items(), { seed: 'a', retestShare: 0.5 });
  writeFileSync(join(dir, 'items.jsonl'), sampled.map((i) => JSON.stringify(i)).join('\n'));
  server = labelServer(dir, () => '2026-10-31T00:00:00.000Z');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the label page is local-only and renders item text as text', async () => {
  const foreign = await send('/api/next', { headers: { host: 'evil.example' } });
  assert.equal(foreign.status, 403);
  const page = await send('/', { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
  assert.match(String(page.headers['content-security-policy']), /connect-src 'self'/);
  assert.ok(!page.body.includes('innerHTML'));
  const crossSite = await send('/api/label', {
    method: 'POST',
    body: { id: 'x', label: 'ambiguous' },
    headers: {
      'content-type': 'application/json',
      host: `127.0.0.1:${port}`,
      origin: 'http://evil.example',
    },
  });
  assert.equal(crossSite.status, 403);
});

test('labeling is blind: the page never learns splits, sources or retest links', async () => {
  const next = await send('/api/next', { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(next.status, 200);
  const body = JSON.parse(next.body) as { item: Record<string, unknown> };
  for (const hidden of ['split', 'source', 'group', 'retestOf', 'chosen'])
    assert.equal(hidden in body.item, false, hidden);
});

test('labels are validated, the latest answer wins and undo reopens an item', async () => {
  const read = async () =>
    JSON.parse((await send('/api/next', { headers: { host: `127.0.0.1:${port}` } })).body) as {
      item: { id: string; participants: { participantId: string }[] } | null;
      done: number;
      total: number;
    };
  const start = await read();
  const id = start.item!.id;
  assert.equal((await post('/api/label', { id: 'missing', label: 'ambiguous' })).status, 400);
  assert.equal((await post('/api/label', { id, label: 'high' })).status, 400);
  assert.equal(
    (await post('/api/label', { id, label: { participantIds: ['nobody'] } })).status,
    400,
  );
  const label = { participantIds: [start.item!.participants[0]!.participantId] };
  assert.equal((await post('/api/label', { id, label })).status, 200);
  assert.equal((await read()).done, start.done + 1);
  assert.equal((await post('/api/undo', {})).status, 200);
  const reopened = await read();
  assert.equal(reopened.done, start.done);
  assert.equal(reopened.item!.id, id);
  const log = readFileSync(join(dir, 'labels.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 2);
  assert.equal(statSync(join(dir, 'labels.jsonl')).mode & 0o777, 0o600);
});

test('the display text of an item shows what the selector reads and nothing hidden', () => {
  const [item] = sampleItems(items(), { seed: 'a', retestShare: 0 });
  const view = itemText(item!);
  assert.equal(view.id, item!.id);
  assert.equal('split' in view, false);
});
