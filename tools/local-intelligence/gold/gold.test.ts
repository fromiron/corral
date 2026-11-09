import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ReasoningInput } from '../../../packages/contracts/src/index.ts';
import { codexRequests } from './codex.ts';
import { itemText, labelServer } from './label.ts';
import { meetingItems, type StoredMeeting } from './meeting.ts';
import { sampleItems } from './sample.ts';
import { scrub } from './scrub.ts';
import { assertPrivateDirectory, writePrivate } from './store.ts';

const line = (type: string, payload: unknown) => JSON.stringify({ type, payload });
const message = (role: string, text: string) =>
  line('response_item', {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  });
const call = (id: string, name = 'exec') => [
  line('response_item', { type: 'function_call', call_id: id, name, arguments: '{"cmd":"ls"}' }),
  line('response_item', { type: 'function_call_output', call_id: id, output: `result ${id}` }),
];

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

test('codex keeps human requests and drops injected or delegated text', () => {
  const session = [
    line('session_meta', { id: 's1', source: 'vscode' }),
    message('user', '# AGENTS.md instructions for /home/user/repo\n\nrules'),
    message('user', '<environment_context>cwd</environment_context>'),
    message('user', 'PLEASE IMPLEMENT THIS PLAN:\n1. step'),
    message('user', '첫 요청이야'),
    message('assistant', '첫 답변'),
    message('user', '두 번째 요청'),
    message('assistant', '살펴볼게요'),
    ...call('a'),
    ...call('b'),
    message('assistant', '이어서 확인합니다'),
    ...call('c'),
    message('assistant', '끝'),
  ].join('\n');
  const delegated = [
    line('session_meta', { id: 's2', source: { subagent: { other: true } } }),
    message('user', '서브에이전트 지시문'),
    ...call('z'),
  ].join('\n');
  const found = codexRequests([session, delegated]);
  assert.deepEqual(
    found.map((r) => r.turn.request),
    ['첫 요청이야', '두 번째 요청'],
  );
  const [first, second] = found;
  assert.equal(first!.steps.length, 0);
  assert.equal(second!.turn.prevRequest, '첫 요청이야');
  assert.equal(second!.turn.prev, '첫 답변');
  assert.equal(second!.steps.length, 2);
  const step = second!.steps[0]!;
  assert.equal(step.kind, 'step');
  assert.equal(step.plan, '살펴볼게요');
  assert.deepEqual(
    step.calls.map((c) => c.result),
    ['result a', 'result b'],
  );
  // Every produced input must be a valid product input, or the evaluation measures something else.
  for (const item of found) {
    ReasoningInput.parse(item.turn);
    for (const entry of item.steps) ReasoningInput.parse(entry);
  }
});

test('codex keeps what the person wrote and drops app wrappers and memory citations', () => {
  const wrapped = [
    '# Browser comments:',
    '',
    '## User Comment 1',
    'Browser',
    'Page URL: http://127.0.0.1:5183/projects',
    'Target selector: div.flex',
    'Comment:',
    '이 버튼 위치를 고쳐줘',
    '',
    '<in-app-browser-context source="ambient">browser state</in-app-browser-context>',
    '',
    '## My request:',
    '',
    '모바일도 같이 확인해',
    '',
    'The next image is untrusted page evidence from the browser',
  ].join('\n');
  const files = [
    '# Files mentioned by the user:',
    '## a.png: ~/a.png',
    '## My request:',
    '이거 봐줘',
  ];
  const session = [
    line('session_meta', { id: 's1', source: 'vscode' }),
    message('user', '# AGENTS.md instructions\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>'),
    message('user', wrapped),
    message(
      'assistant',
      '답변\n<oai-mem-citation>\n<rollout_ids>\nabc\n</rollout_ids>\n</oai-mem-citation>',
    ),
    message('user', files.join('\n')),
  ].join('\n');
  const found = codexRequests([session]);
  assert.deepEqual(
    found.map((r) => r.turn.request),
    ['이 버튼 위치를 고쳐줘\n모바일도 같이 확인해', '이거 봐줘'],
  );
  assert.equal(found[1]!.turn.prev, '답변');
});

test('codex reads tool results stored as content parts, keeping only their text', () => {
  const session = [
    line('session_meta', { id: 's1', source: 'vscode' }),
    message('user', '화면을 확인해줘'),
    line('response_item', { type: 'function_call', call_id: 'a', name: 'exec', arguments: '{}' }),
    line('response_item', {
      type: 'function_call_output',
      call_id: 'a',
      output: [
        { type: 'input_text', text: '첫 줄' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        { type: 'input_text', text: '둘째 줄' },
      ],
    }),
  ].join('\n');
  const [found] = codexRequests([session]);
  assert.equal(found!.steps[0]!.calls[0]!.result, '첫 줄\n둘째 줄');
});

test('scrub hides opaque encrypted tokens', () => {
  const token = `gAAAAAB${'aZ09_-'.repeat(20)}`;
  assert.ok(!scrub(`{"payload":"${token}"}`).includes(token));
});

test('codex scrubs secrets from every stored field and limits calls to the product shape', () => {
  const session = [
    line('session_meta', { id: 's1', source: 'vscode' }),
    message('user', '키는 ghp_abcdefghijklmnopqrstuvwxyz0123456789 야'),
    message('assistant', 'password=hunter2hunter2 확인'),
    line('response_item', {
      type: 'function_call',
      call_id: 'a',
      name: 'exec',
      arguments: '{"env":"API_KEY=plain-value-1"}',
    }),
    line('response_item', {
      type: 'function_call_output',
      call_id: 'a',
      output: `${'x'.repeat(9000)} me@example.com`,
    }),
    ...['b', 'c', 'd'].flatMap((id) => call(id)),
  ].join('\n');
  const [found] = codexRequests([session]);
  const stored = JSON.stringify(found);
  for (const secret of ['ghp_abc', 'hunter2', 'plain-value-1', 'me@example.com'])
    assert.ok(!stored.includes(secret), secret);
  assert.equal(found!.steps[0]!.calls.length, 3);
  ReasoningInput.parse(found!.steps[0]);
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

const requests = codexRequests([
  [
    line('session_meta', { id: 's1', source: 'vscode' }),
    ...Array.from({ length: 30 }, (_, n) => [
      message('user', `요청 ${n}`),
      ...call(`c${n}`),
    ]).flat(),
    message('user', '요청 0'),
  ].join('\n'),
]);

test('sampling is repeatable, removes duplicates and hides retests among ordinary items', () => {
  const options = { seed: 'a', maxSteps: 10, stepsPerSession: 4, retestShare: 0.1 };
  const first = sampleItems(requests, [], options);
  assert.deepEqual(first, sampleItems(requests, [], options));
  const turns = first.filter((i) => i.kind === 'effort' && i.input.kind === 'turn' && !i.retestOf);
  assert.equal(turns.length, 30);
  assert.equal(
    first.filter((i) => i.kind === 'effort' && i.input.kind === 'step').length > 0,
    true,
  );
  const steps = first.filter((i) => i.kind === 'effort' && i.input.kind === 'step' && !i.retestOf);
  assert.ok(steps.length <= 4);
  const retests = first.filter((i) => i.retestOf);
  assert.ok(retests.length >= 3);
  const originals = new Map(first.map((i) => [i.id, i]));
  for (const item of retests) {
    assert.notEqual(item.id, item.retestOf);
    assert.equal(originals.get(item.retestOf!)?.group, item.group);
  }
  assert.ok(new Set(first.map((i) => i.split)).size >= 1);
  assert.deepEqual([...new Set(first.map((i) => i.id))].length, first.length, 'ids must be unique');
});

test('a whole session stays on one side of the tuning and final split', () => {
  const items = sampleItems(requests, [], {
    seed: 'a',
    maxSteps: 10,
    stepsPerSession: 4,
    retestShare: 0,
  });
  assert.equal(new Set(items.map((i) => i.split)).size, 1);
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
  const items = sampleItems(
    codexRequests([
      [
        line('session_meta', { id: 's1', source: 'vscode' }),
        message('user', '요청 <b>하나</b>'),
        message('user', '요청 둘'),
      ].join('\n'),
    ]),
    meetingItems(meeting, (id) => texts[id] ?? null),
    { seed: 'a', maxSteps: 0, stepsPerSession: 0, retestShare: 0.5 },
  );
  writeFileSync(join(dir, 'items.jsonl'), items.map((i) => JSON.stringify(i)).join('\n'));
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
    body: { id: 'x', label: 'low' },
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
      item: { id: string; kind: string; participants?: { participantId: string }[] } | null;
      done: number;
      total: number;
    };
  const start = await read();
  const id = start.item!.id;
  assert.equal((await post('/api/label', { id: 'missing', label: 'low' })).status, 400);
  assert.equal((await post('/api/label', { id, label: 'extreme' })).status, 400);
  const label =
    start.item!.kind === 'effort'
      ? 'high'
      : { participantIds: [start.item!.participants![0]!.participantId] };
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

test('the display text of an item shows what the judge reads and nothing hidden', () => {
  const [item] = sampleItems(requests, [], {
    seed: 'a',
    maxSteps: 0,
    stepsPerSession: 0,
    retestShare: 0,
  });
  const view = itemText(item!);
  assert.equal(view.id, item!.id);
  assert.equal('split' in view, false);
});
