import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@corral/contracts';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';
import { FAKE_PROFILES, fakeOpenAI } from '../src/testing.ts';

const assistant = '/team-assistant';
const draft = '/team-drafts';
const token = 'assistant-test-bootstrap-0123456789';
const roots: string[] = [];
const servers: CorralServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(
  options: { live?: boolean; signedIn?: boolean; tokensPerSecond?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'corral-team-assistant-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const state = join(workspace, '.corral');
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, 'config.json'),
    JSON.stringify({ schemaVersion: '0.1', modelProfiles: FAKE_PROFILES }),
  );
  const fake = fakeOpenAI({
    configDir: join(root, 'config'),
    env: options.signedIn === false ? {} : { OPENAI_API_KEY: 'local-fake-key' },
    tokensPerSecond: options.tokensPerSecond,
  });
  const server = await startCorralServer({
    workspace,
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    ...(options.live === false ? {} : { live: fake.live }),
  });
  servers.push(server);
  const headers = new Headers({ origin: server.url, 'content-type': 'application/json' });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token }),
  });
  headers.set('cookie', (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '');
  headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
  const call = async (path: string, body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { fake, call, dbPath: join(state, 'corral.db') };
}

const create = (operationId: string, content: string) => ({
  operationId,
  mode: 'create',
  messages: [{ role: 'user', content }],
});
const edit = (operationId: string) => ({
  ...create(operationId, 'Review the notice before publishing.'),
  mode: 'edit',
  team: {
    roles: [{ nodeId: 'writer', name: 'Writer' }],
    outputs: [{ outputId: 'out', results: [{ index: 2, name: 'Notice', producerName: 'Writer' }] }],
    hasSharedOutrider: false,
    brief: 'Write the notice.',
  },
});
const plan = {
  pattern: 'single',
  name: 'Notice writer',
  brief: 'Write a notice.',
  criteria: ['Clear notice.'],
  roles: [{ slot: 'worker', name: 'Writer', duty: 'Write and submit the notice.' }],
  finalApproval: false,
};
const proposal = { kind: 'plan', plan, reason: 'Only a writer is needed.' };
const question = { kind: 'question', id: 'material', choices: ['person', 'team'] };
const required = { kind: 'require_review', outputId: 'out', index: 2 };
const failedAnswer = { status: 502, body: { error: { code: 'MODEL_UNAVAILABLE' } } };

it('returns a plan immediately for a sufficient goal and records one body-free managed attempt', async () => {
  const { fake, call } = await setup();
  const request = create('notice', 'Write this notice with one writer.');
  fake.replyText(JSON.stringify(proposal));
  expect(await call(assistant, request)).toEqual({
    status: 200,
    body: { model: 'Test A', reply: proposal },
  });
  expect(fake.seen.hostRequests).toHaveLength(1);
  expect(fake.seen.hostRequests[0]?.text).toContain(request.messages[0]?.content);
  const history = await call('/model-attempts?ownerId=notice');
  expect(history.status).toBe(200);
  const recorded = JSON.stringify(history.body);
  expect(history.body).toMatchObject({
    items: [{ intent: { requestId: 'notice', purpose: 'draft' } }],
  });
  expect(recorded).not.toContain('Write this notice');
  expect(recorded).not.toContain(proposal.reason);
});

it('allows one material question with fixed choices, but not a third question', async () => {
  const { fake, call } = await setup();
  const request = create('materials', 'Prepare a comparison.');
  fake.replyText(JSON.stringify(question));
  expect(await call(assistant, request)).toEqual({
    status: 200,
    body: { reply: question, model: 'Test A' },
  });
  fake.replyText(JSON.stringify(question));
  const third = await call(assistant, {
    ...request,
    operationId: 'third',
    messages: [
      ...request.messages,
      { role: 'assistant', questionId: 'material', content: 'Who supplies the material?' },
      { role: 'user', content: 'Recommend a choice.' },
      { role: 'assistant', questionId: 'review_policy', content: 'Require review?' },
      { role: 'user', content: 'Recommend a choice.' },
    ],
  });
  expect(third).toMatchObject(failedAnswer);
  expect(fake.seen.hostRequests).toHaveLength(2);
});

it('accepts a typed policy answer and does not send the person through the same question again', async () => {
  const { fake, call } = await setup();
  const base = edit('typed');
  const messages = [
    { role: 'user', content: 'Get a review before publishing.' },
    { role: 'assistant', questionId: 'review_policy', content: 'Choose one.' },
    { role: 'user', content: 'Just get a second opinion.' },
  ];
  const advice = {
    kind: 'edits',
    edits: [{ kind: 'add_shared_advice' }],
    reason: 'Advice is optional.',
  };
  const repeated = { kind: 'question', id: 'review_policy', choices: ['opinion_only', 'required'] };
  for (const [operationId, input, answer, expected] of [
    ['typed-edit', base, advice, advice],
    ['typed-create', create('', ''), proposal, proposal],
    ['unresolved-edit', base, repeated, { kind: 'unsupported' }],
    ['unresolved-create', create('', ''), repeated, null],
    [
      'typed-decision',
      { ...base, decisions: { reviewPolicy: 'opinion_only' } },
      { ...advice, edits: [required] },
      { kind: 'edits', edits: [{ kind: 'add_shared_advice' }] },
    ],
  ] as const) {
    fake.replyText(JSON.stringify(answer));
    const response = await call(assistant, { ...input, operationId, messages });
    expect(response).toMatchObject(
      expected ? { status: 200, body: { reply: expected } } : failedAnswer,
    );
  }
  expect(fake.seen.hostRequests).toHaveLength(5);
});

it('rejects whole invalid replies, unknown targets and mode mismatches without retry or raw text', async () => {
  const { fake, call } = await setup();
  const edits = [{ kind: 'add_shared_advice' }, { ...required, index: 0 }];
  const cases = [
    [create('extra', 'Write it.'), { ...proposal, extra: 'private-raw-answer' }],
    [edit('target'), { kind: 'edits', edits, reason: 'Add review.' }],
    [edit('plan'), proposal],
    [create('describe', 'Who submits?'), { kind: 'describe', topic: 'submitter' }],
  ] as const;
  for (const [request, reply] of cases) {
    fake.replyText(JSON.stringify(reply));
    const result = await call(assistant, request);
    expect(result).toMatchObject(failedAnswer);
    expect(JSON.stringify(result.body)).not.toContain('private-raw-answer');
  }
  expect(fake.seen.hostRequests).toHaveLength(cases.length);
});

it('respects the structured opinion-only decision even when the model requests a valid review gate', async () => {
  const { fake, call } = await setup();
  const request = edit('opinion');
  const reply = { kind: 'edits', edits: [required], reason: 'Gate submission.' };
  fake.replyText(JSON.stringify(reply));
  expect(await call(assistant, { ...request, decisions: { reviewPolicy: 'required' } })).toEqual({
    status: 200,
    body: { reply, model: 'Test A' },
  });
  fake.replyText(JSON.stringify(reply));
  const opinion = await call(assistant, {
    ...request,
    operationId: 'opinion-only',
    decisions: { reviewPolicy: 'opinion_only' },
  });
  expect(opinion).toMatchObject({
    status: 200,
    body: { reply: { kind: 'edits', edits: [{ kind: 'add_shared_advice' }] } },
  });
  expect(fake.seen.hostRequests).toHaveLength(2);
  const requestText = fake.seen.hostRequests[1]?.text;
  if (!requestText) throw new Error('Missing second request');
  const sent = JSON.parse(requestText) as { role: string; content: unknown }[];
  const payload = sent.find(({ role }) => role === 'user')?.content;
  expect(JSON.stringify(payload)).toContain('opinion_only');
});

it('coalesces identical sends and replays persisted outcomes, but refuses changed messages', async () => {
  const { fake, call, dbPath } = await setup();
  const request = create('repeat', 'Write a notice.');
  fake.replyText(JSON.stringify(proposal));
  const expected = { status: 200, body: { reply: proposal, model: 'Test A' } };
  const pair = await Promise.all([call(assistant, request), call(assistant, request)]);
  expect(pair).toEqual([expected, expected]);
  const reordered = {
    messages: request.messages,
    mode: request.mode,
    operationId: request.operationId,
  };
  expect(await call(assistant, reordered)).toEqual(expected);
  expect(await call(assistant, create('repeat', 'Translate a notice.'))).toMatchObject({
    status: 409,
    body: { error: { code: 'REVISION_CONFLICT' } },
  });
  // Simulate an interrupted prior process: admission is durable but its outcome is not.
  const db = new DatabaseSync(dbPath);
  try {
    const reset = db.prepare('UPDATE model_operations SET result_json=NULL WHERE operation_id=?');
    expect(reset.run(request.operationId).changes).toBe(1);
  } finally {
    db.close();
  }
  expect(await call(assistant, request)).toMatchObject({
    status: 409,
    body: { error: { code: 'REQUEST_OUTCOME_UNKNOWN' } },
  });
  expect(fake.seen.hostRequests).toHaveLength(1);
});

it('preserves legacy draft results, even for a draft goal spelling the JSON of an assistant request', async () => {
  const { fake, call, dbPath } = await setup();
  const request = create('legacy', 'Write a notice.');
  const { operationId } = request;
  const goal = canonicalJson(request);
  const model = { provider: 'openai', modelId: 'gpt-test-a' };
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      'INSERT INTO model_operations(operation_id, fingerprint, result_json) VALUES (?, ?, ?)',
    ).run(
      operationId,
      createHash('sha256').update(goal).digest('hex'),
      JSON.stringify({ ok: true, plan, model }),
    );
  } finally {
    db.close();
  }
  expect(await call(draft, { operationId, goal })).toEqual({ status: 200, body: { plan, model } });
  expect(await call(assistant, request)).toMatchObject({
    status: 409,
    body: { error: { code: 'REVISION_CONFLICT' } },
  });
  expect(fake.seen.hostRequests).toHaveLength(0);
});

it('aborts the actual model stream on disconnect and does not resend on replay', async () => {
  const { fake, call } = await setup({ tokensPerSecond: 1 });
  const request = create('closed', 'Write a notice.');
  fake.replyText(JSON.stringify(proposal));
  const stream = vi.spyOn(fake.live.models, 'streamSimple');
  const controller = new AbortController();
  const pending = call(assistant, request, controller.signal).catch(() => null);
  try {
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    const signal = stream.mock.calls[0]?.[2]?.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(await call(assistant, request)).toMatchObject({
      status: 409,
      body: { error: { code: 'REQUEST_OUTCOME_UNKNOWN' } },
    });
    expect(stream).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    stream.mockRestore();
  }
});

it.each([
  { live: false, status: 501 },
  { signedIn: false, status: 403 },
])('has the draft route’s no-model error ($status)', async (options) => {
  const { fake, call } = await setup(options);
  const expected = await call(draft, { goal: 'Write a notice.' });
  expect(expected.status).toBe(options.status);
  expect(await call(assistant, create('offline', 'Write a notice.'))).toEqual(expected);
  expect(fake.seen.hostRequests).toHaveLength(0);
});

it('refuses an invalid edit summary before contacting the model', async () => {
  const { fake, call } = await setup();
  const request = edit('private');
  const result = await call(assistant, {
    ...request,
    team: { ...request.team, roleInstructions: 'private-role-instructions' },
  });
  expect(result).toMatchObject({ status: 400, body: { error: { code: 'SCHEMA_INVALID' } } });
  expect(JSON.stringify(result.body)).not.toContain('private-role-instructions');
  expect(fake.seen.hostRequests).toHaveLength(0);
});
