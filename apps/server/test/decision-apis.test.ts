import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DecisionCancellation,
  EffortLevel,
  ModelAttempt,
  RouterRequest,
  RoutingEngine,
  RoutingLease,
} from '@corral/contracts';
import { effortQuestion } from '@corral/core';
import { D1Engine, LINUX_X64_CPU } from '@corral/local-intelligence';
import { afterEach, describe, expect, it } from 'vitest';
import { DecisionApis, decisionApiConsent } from '../src/decision-apis.ts';
import { FileCredentialStore } from '../src/models/credential-store.ts';
import { routingEngines } from '../src/routing-engines.ts';

// features/decision-apis.md: a decision API as the Manual effort routing engine.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEY = 'decision-secret-key-0123456789';
const MODEL_KEY = 'model-secret-key-9876543210';
const state = '## request\nDesign a distributed task queue';
const owner = { runId: 'run_1', executionId: 'exec_1', effectId: 'effect_1', attemptNo: 1 };
const ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

const cancellation = () => {
  const listeners = new Set<() => void>();
  let aborted = false;
  const signal: DecisionCancellation = {
    get aborted() {
      return aborted;
    },
    onCancel: (fn) => {
      listeners.add(fn);
      if (aborted) fn();
      return () => listeners.delete(fn);
    },
  };
  return {
    signal,
    abort() {
      aborted = true;
      for (const fn of [...listeners]) fn();
    },
  };
};

const jevAnswer = (choice: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: 'jev-2026-09-15',
    answers: {
      effort: {
        type: 'choice',
        choice,
        confidence: 0.7,
        probabilities: { low: 0.05, medium: 0.1, high: 0.15, xhigh: 0.7 },
      },
    },
    usage: { input_tokens: 120, output_tokens: 3 },
    ...extra,
  });
const openaiAnswer = (answer: Record<string, unknown>) =>
  JSON.stringify({
    model: 'gpt-6-luna',
    answers: [answer],
    usage: {
      input_tokens: 140,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 142,
    },
  });

async function apisWith(respond: (init: RequestInit) => Promise<Response> | Response) {
  const dir = mkdtempSync(join(tmpdir(), 'corral-decision-apis-'));
  dirs.push(dir);
  const credentials = new FileCredentialStore(dir);
  // A model sign-in key that judge calls must never use.
  await credentials.modify('openai', async () => ({ type: 'api_key', key: MODEL_KEY }));
  const sent: { url: string; init: RequestInit }[] = [];
  const attempts = new Map<string, ModelAttempt>();
  let now = 1000;
  const apis = await DecisionApis.open({
    credentials,
    attempts: {
      put: (attempt) => void attempts.set(attempt.attemptId, structuredClone(attempt)),
      get: (id) => attempts.get(id) ?? null,
      list: () => [...attempts.values()],
    },
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return respond(init ?? {});
    }) as typeof fetch,
    now: () => '2026-10-30T00:00:00.000Z',
    monotonicMs: () => (now += 10),
  });
  return { apis, sent, attempts, dir };
}

const engineOf = (
  id: 'jev' | 'openai-decisions',
  consentRevision = decisionApiConsent(id),
): Extract<RoutingEngine, { kind: 'api' }> => ({
  kind: 'api',
  id,
  callerTimeoutMs: 3000,
  consentRevision,
});

function leaseOf(apis: DecisionApis, id: 'jev' | 'openai-decisions'): RoutingLease {
  const backend = apis.backend(engineOf(id));
  const admitted = backend?.admit();
  if (!admitted?.ok) throw new Error(`no ${id} lease: ${JSON.stringify(admitted)}`);
  return admitted.lease;
}

const request = (
  overrides: Partial<RouterRequest> = {},
  candidates: EffortLevel[] = ALL,
): RouterRequest => ({
  routeId: 'route_1',
  state,
  question: effortQuestion(candidates),
  candidates,
  remainingMs: 2500,
  inputUnits: 0,
  signal: cancellation().signal,
  owner,
  ...overrides,
});

describe('decision API keys', () => {
  it('lists the supported APIs with their models and whether a key is stored, never the key', async () => {
    const t = await apisWith(() => new Response(jevAnswer('low')));
    expect(t.apis.list()).toEqual([
      { id: 'jev', provider: 'TypeSafe', model: 'jev-latest', keyConfigured: false },
      { id: 'openai-decisions', provider: 'OpenAI', model: 'gpt-6-luna', keyConfigured: false },
    ]);
    // A model provider's OpenAI key does not connect OpenAI Decisions.
    expect(t.apis.backend(engineOf('openai-decisions'))?.admit()).toEqual({
      ok: false,
      reason: 'unavailable',
    });

    await t.apis.setKey('openai-decisions', KEY);
    expect(t.apis.list()[1]).toMatchObject({ keyConfigured: true });
    expect(JSON.stringify(t.apis.list())).not.toContain(KEY);
    const stored = JSON.parse(readFileSync(join(t.dir, 'credentials.json'), 'utf8')) as {
      credentials: Record<string, { key?: string }>;
    };
    expect(stored.credentials['decision-api:openai-decisions']?.key).toBe(KEY);
    expect(stored.credentials.openai?.key).toBe(MODEL_KEY);

    const reopened = await DecisionApis.open({ credentials: new FileCredentialStore(t.dir) });
    expect(reopened.list()[1]).toMatchObject({ keyConfigured: true });
    await reopened.deleteKey('openai-decisions');
    expect(reopened.backend(engineOf('openai-decisions'))?.admit()).toMatchObject({ ok: false });
    expect(
      (await DecisionApis.open({ credentials: new FileCredentialStore(t.dir) })).list()[1],
    ).toMatchObject({ keyConfigured: false });
  });
});

describe('a decision API as the routing engine', () => {
  it('asks Jev the fixed question with the candidate criteria only, and records the attempt', async () => {
    const t = await apisWith(() => new Response(jevAnswer('high'), { status: 200 }));
    await t.apis.setKey('jev', KEY);
    const lease = leaseOf(t.apis, 'jev');
    const candidates: EffortLevel[] = ['low', 'medium', 'high'];
    const question = effortQuestion(candidates);
    expect(lease).toMatchObject({ frame: 'api-bounded', device: null, identity: 'jev/jev-latest' });
    const never = cancellation().signal;
    expect(await lease.countState(state, never)).toBe(Buffer.byteLength(state));
    const inputUnits = await lease.countInput(state, question, never);
    const flight = lease.start(request({ question, candidates, inputUnits }, candidates));
    const answer = await flight.result;
    // Jev reported a level outside the candidates in its distribution; the arbiter decides.
    expect(answer).toEqual({
      choice: 'high',
      probabilities: { low: 0.05, medium: 0.1, high: 0.15, xhigh: 0.7 },
      inputTokens: 120,
      billableUnits: null,
    });
    expect(await flight.settled).toMatchObject({ basis: 'remote-transport-closed' });

    const [{ url, init } = { url: '', init: {} }] = t.sent;
    expect(t.sent).toHaveLength(1);
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    // The counted input is exactly the request that went out.
    expect(Buffer.byteLength(String(init.body))).toBe(inputUnits);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: 'jev-latest',
      state,
      questions: {
        effort: {
          type: 'choice',
          instructions: question.instructions,
          criteria: question.criteria,
        },
      },
    });
    expect(Object.keys(body.questions.effort.criteria)).toEqual(candidates);
    expect(JSON.stringify(body)).not.toContain('run_1');

    expect(t.attempts.get('judge_run_1_effect_1')).toMatchObject({
      status: 'completed',
      provider: 'jev',
      modelId: 'jev-latest',
      intent: {
        requestId: 'effect_1',
        purpose: 'reasoning_effort',
        owner: { kind: 'judge', id: 'effect_1', runId: 'run_1', executionId: 'exec_1' },
      },
      usage: { inputTokens: 120, outputTokens: 3, source: 'reported', costStatus: 'unknown' },
    });
    expect(JSON.stringify([...t.attempts.values()])).not.toContain(KEY);
  });

  it('asks OpenAI Decisions one choice question with its own key, and records its usage', async () => {
    const t = await apisWith(
      () =>
        new Response(
          openaiAnswer({
            type: 'choice',
            name: 'effort',
            choice: 'high',
            confidence: 0.61,
            probabilities: [
              { value: 'low', probability: 0.04 },
              { value: 'medium', probability: 0.2 },
              { value: 'high', probability: 0.61 },
              { value: 'xhigh', probability: 0.15 },
            ],
          }),
        ),
    );
    await t.apis.setKey('openai-decisions', KEY);
    const lease = leaseOf(t.apis, 'openai-decisions');
    expect(lease.identity).toBe('openai-decisions/gpt-6-luna');
    const answer = await lease.start(request()).result;
    expect(answer).toEqual({
      choice: 'high',
      probabilities: { low: 0.04, medium: 0.2, high: 0.61, xhigh: 0.15 },
      inputTokens: 140,
      billableUnits: null,
    });

    const [{ url, init } = { url: '', init: {} }] = t.sent;
    expect(url).toBe('https://api.openai.com/v1/decisions');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body)).toEqual(['model', 'input', 'questions']);
    expect(body).toMatchObject({ model: 'gpt-6-luna', input: state });
    expect(body.questions).toEqual([
      {
        type: 'choice',
        name: 'effort',
        instructions: effortQuestion(ALL).instructions,
        choices: ALL.map((value) => ({
          value,
          description: effortQuestion(ALL).criteria[value],
        })),
      },
    ]);

    expect(t.attempts.get('judge_run_1_effect_1')).toMatchObject({
      status: 'completed',
      provider: 'openai-decisions',
      modelId: 'gpt-6-luna',
      usage: {
        inputTokens: 140,
        outputTokens: 2,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        source: 'reported',
        costStatus: 'unknown',
      },
    });
  });

  it('passes on an answer without probabilities as none, never as one-hot', async () => {
    const t = await apisWith(
      () =>
        new Response(
          openaiAnswer({ type: 'choice', name: 'effort', choice: 'low', confidence: 0.9 }),
        ),
    );
    await t.apis.setKey('openai-decisions', KEY);
    const answer = await leaseOf(t.apis, 'openai-decisions').start(request()).result;
    expect(answer.choice).toBe('low');
    expect(answer.probabilities).toBeUndefined();
  });

  it('reports HTTP errors, refusals and answers it cannot use without the key or the body', async () => {
    const cases = [
      {
        id: 'jev' as const,
        response: () => new Response(`{"detail":"bad key ${KEY} for ${state}"}`, { status: 401 }),
        reason: 'transport-error',
        status: 401,
      },
      {
        id: 'openai-decisions' as const,
        response: () =>
          new Response(
            `{"error":{"message":"Incorrect API key provided: ${KEY}","type":"invalid_request_error"}}`,
            { status: 401 },
          ),
        reason: 'transport-error',
        status: 401,
      },
      {
        id: 'jev' as const,
        response: () => new Response(jevAnswer('max')),
        reason: 'invalid-response',
        status: 200,
      },
      {
        id: 'openai-decisions' as const,
        response: () => new Response(openaiAnswer({ type: 'refusal', name: 'effort' })),
        reason: 'invalid-response',
        status: 200,
      },
      {
        id: 'openai-decisions' as const,
        response: () =>
          new Response(
            openaiAnswer({ type: 'choice', name: 'effort', choice: 'max', confidence: 1 }),
          ),
        reason: 'invalid-response',
        status: 200,
      },
      {
        id: 'jev' as const,
        response: () => new Response('not json'),
        reason: 'invalid-response',
        status: 200,
      },
      {
        id: 'jev' as const,
        response: () => new Response(jevAnswer('high', { padding: 'x'.repeat(70_000) })),
        reason: 'invalid-response',
        status: 200,
      },
    ];
    for (const c of cases) {
      const t = await apisWith(c.response);
      await t.apis.setKey(c.id, KEY);
      const flight = leaseOf(t.apis, c.id).start(request());
      const failure = await flight.result.then(
        () => null,
        (error: Error & { reason?: string }) => error,
      );
      expect(failure?.reason).toBe(c.reason);
      expect(failure?.message).not.toContain(KEY);
      expect(failure?.message).not.toContain('distributed task queue');
      expect(await flight.settled).toMatchObject({ basis: 'remote-transport-closed' });
      const attempt = t.attempts.get('judge_run_1_effect_1');
      expect(attempt).toMatchObject({ status: 'failed', failure: { status: c.status } });
      expect(JSON.stringify(attempt)).not.toContain(KEY);
      expect(JSON.stringify(attempt)).not.toContain('distributed task queue');
    }
  });

  it('records a request that failed before any response as unknown', async () => {
    const t = await apisWith(() => Promise.reject(new TypeError('fetch failed')));
    await t.apis.setKey('jev', KEY);
    const flight = leaseOf(t.apis, 'jev').start(request());
    await expect(flight.result).rejects.toMatchObject({ reason: 'transport-error' });
    expect(t.attempts.get('judge_run_1_effect_1')?.status).toBe('unknown');
  });

  it('closes the connection when the host stops waiting, and records it as cancelled', async () => {
    const t = await apisWith(
      (init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    await t.apis.setKey('openai-decisions', KEY);
    const stop = cancellation();
    const flight = leaseOf(t.apis, 'openai-decisions').start(request({ signal: stop.signal }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(t.sent[0]?.init.signal?.aborted).toBe(false);
    stop.abort();
    expect(t.sent[0]?.init.signal?.aborted).toBe(true);
    await expect(flight.result).rejects.toBeInstanceOf(Error);
    expect(await flight.settled).toMatchObject({ basis: 'remote-transport-closed' });
    const attempt = t.attempts.get('judge_run_1_effect_1');
    // Closing the connection is recorded as Corral's stop, with no claim about the remote.
    expect(attempt).toMatchObject({ status: 'cancelled', usage: { costStatus: 'unknown' } });
  });

  it('sends nothing without the current consent', async () => {
    const t = await apisWith(() => new Response(jevAnswer('low')));
    await t.apis.setKey('jev', KEY);
    const stale = t.apis.backend(engineOf('jev', 'jev:notice-0'));
    expect(stale?.admit()).toEqual({ ok: false, reason: 'consent-required' });
    expect(t.sent).toHaveLength(0);
  });

  it('calls nothing without a key, also when the key went away after admission', async () => {
    const t = await apisWith(() => new Response(jevAnswer('low')));
    for (const id of ['jev', 'openai-decisions'] as const)
      expect(t.apis.backend(engineOf(id))?.admit()).toEqual({ ok: false, reason: 'unavailable' });
    await t.apis.setKey('jev', KEY);
    const lease = leaseOf(t.apis, 'jev');
    // Deleted behind the server's back: the call reads the store and finds nothing.
    await new FileCredentialStore(t.dir).delete('decision-api:jev');
    const flight = lease.start(request());
    await expect(flight.result).rejects.toMatchObject({ reason: 'unavailable' });
    await flight.settled;
    expect(t.sent).toHaveLength(0);
    expect(t.attempts.size).toBe(0);
  });

  it('judges with an API and no Local install, and asks only the chosen engine (P09, C18)', async () => {
    const t = await apisWith(() => new Response(jevAnswer('low')));
    await t.apis.setKey('jev', KEY);
    const launched: unknown[] = [];
    const downloads: string[] = [];
    const local = new D1Engine({
      root: join(t.dir, 'd1'),
      manifest: LINUX_X64_CPU,
      launch: (command) => {
        launched.push(command);
        throw new Error('no Local process in this test');
      },
      fetchFn: (async (url: string | URL | Request) => {
        downloads.push(String(url));
        return new Response('', { status: 404 });
      }) as typeof fetch,
    });
    const engines = routingEngines({ decisionApis: t.apis, local });
    const api = engines(engineOf('jev'));
    expect(api?.kind).toBe('api');
    const admitted = api?.admit();
    if (!admitted?.ok) throw new Error('API engine refused');
    const answer = await admitted.lease.start(request()).result;
    expect(answer.choice).toBe('low');
    expect(t.sent).toHaveLength(1);
    expect([launched, downloads]).toEqual([[], []]);

    const localBackend = engines({
      kind: 'local',
      device: { kind: 'cpu', threads: 2 },
      callerTimeoutMs: 5000,
    });
    expect(localBackend?.kind).toBe('local');
    expect(localBackend?.admit()).toEqual({ ok: false, reason: 'unavailable' });
    expect(routingEngines({ decisionApis: undefined, local })(engineOf('jev'))).toBeNull();
    expect(t.sent).toHaveLength(1);
    expect([launched, downloads]).toEqual([[], []]);
  });

  it('knows no engine for an unknown API', async () => {
    const t = await apisWith(() => new Response(jevAnswer('low')));
    expect(
      t.apis.backend({
        kind: 'api',
        id: 'bogus' as 'jev',
        callerTimeoutMs: 3000,
        consentRevision: 'x',
      }),
    ).toBeNull();
  });
});
