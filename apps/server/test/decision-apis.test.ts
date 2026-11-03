import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionCancellation, ModelAttempt, ReasoningInput } from '@corral/contracts';
import { effortText } from '@corral/local-intelligence';
import { afterEach, describe, expect, it } from 'vitest';
import { DecisionApis } from '../src/decision-apis.ts';
import { FileCredentialStore } from '../src/models/credential-store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEY = 'decision-secret-key-0123456789';
const MODEL_KEY = 'model-secret-key-9876543210';
const input: ReasoningInput = {
  kind: 'turn',
  request: '## brief\n\nDesign a distributed task queue',
  prevRequest: '',
  prev: '',
  step: 0,
  plan: '',
  calls: [],
  directiveIds: [],
};
const owner = { runId: 'run_1', executionId: 'exec_1', effectId: 'effect_1', attemptNo: 1 };
const never: DecisionCancellation = { aborted: false, onCancel: () => () => {} };
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
  });
  return { apis, sent, attempts, dir };
}
const judgeOf = (apis: DecisionApis, id: 'jev' | 'openai-decisions') => {
  const judge = apis.judges().find((j) => j.provider === id);
  if (!judge) throw new Error(`no ${id} judge`);
  return judge;
};

describe('decision APIs', () => {
  it('lists the supported APIs with their models and whether a key is stored, never the key', async () => {
    const t = await apisWith(() => new Response(jevAnswer('low')));
    expect(t.apis.list()).toEqual([
      { id: 'jev', provider: 'TypeSafe', model: 'jev-latest', keyConfigured: false },
      { id: 'openai-decisions', provider: 'OpenAI', model: 'gpt-6-luna', keyConfigured: false },
    ]);
    // A model provider's OpenAI key does not connect OpenAI Decisions.
    expect(judgeOf(t.apis, 'openai-decisions').available()).toMatch(/no OpenAI Decisions API key/);

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
    expect(judgeOf(reopened, 'openai-decisions').available()).toMatch(
      /no OpenAI Decisions API key/,
    );
    expect(
      (await DecisionApis.open({ credentials: new FileCredentialStore(t.dir) })).list()[1],
    ).toMatchObject({ keyConfigured: false });
  });

  it('asks Jev with the judge text and an effort choice, and records the attempt', async () => {
    const t = await apisWith(() => new Response(jevAnswer('xhigh'), { status: 200 }));
    await t.apis.setKey('jev', KEY);
    const result = await judgeOf(t.apis, 'jev').judge(input, { model: 'jev-latest', owner }, never);
    expect(result).toEqual({ answer: 'xhigh', model: 'jev-2026-09-15' });

    const [{ url, init } = { url: '', init: {} }] = t.sent;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'jev-latest',
      state: effortText(input),
      questions: { effort: { type: 'choice' } },
    });
    expect(Object.keys(body.questions.effort.criteria)).toEqual(['low', 'medium', 'high', 'xhigh']);
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
    const result = await judgeOf(t.apis, 'openai-decisions').judge(
      input,
      { model: 'gpt-6-luna', owner },
      never,
    );
    expect(result).toEqual({ answer: 'high', model: 'gpt-6-luna' });

    const [{ url, init } = { url: '', init: {} }] = t.sent;
    expect(url).toBe('https://api.openai.com/v1/decisions');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      input: effortText(input),
      questions: [{ type: 'choice', name: 'effort' }],
    });
    expect(Object.keys(body)).toEqual(['model', 'input', 'questions']);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].choices.map((choice: { value: string }) => choice.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(typeof body.questions[0].instructions).toBe('string');

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

  it('reports HTTP errors, refusals and answers it cannot use without the key or the body', async () => {
    const cases = [
      {
        id: 'jev' as const,
        response: () =>
          new Response(`{"detail":"bad key ${KEY} for ${input.request}"}`, { status: 401 }),
        cause: 'provider_error',
      },
      {
        id: 'openai-decisions' as const,
        response: () =>
          new Response(
            `{"error":{"message":"Incorrect API key provided: ${KEY}","type":"invalid_request_error"}}`,
            { status: 401 },
          ),
        cause: 'provider_error',
      },
      {
        id: 'jev' as const,
        response: () => new Response(jevAnswer('max')),
        cause: 'invalid_response',
      },
      {
        id: 'openai-decisions' as const,
        response: () => new Response(openaiAnswer({ type: 'refusal', name: 'effort' })),
        cause: 'invalid_response',
      },
      {
        id: 'openai-decisions' as const,
        response: () =>
          new Response(
            openaiAnswer({ type: 'choice', name: 'effort', choice: 'max', confidence: 1 }),
          ),
        cause: 'invalid_response',
      },
      { id: 'jev' as const, response: () => new Response('not json'), cause: 'invalid_response' },
      {
        id: 'jev' as const,
        response: () => new Response(jevAnswer('high', { padding: 'x'.repeat(70_000) })),
        cause: 'invalid_response',
      },
    ];
    for (const c of cases) {
      const t = await apisWith(c.response);
      await t.apis.setKey(c.id, KEY);
      const failure = await judgeOf(t.apis, c.id)
        .judge(input, { model: c.id === 'jev' ? 'jev-latest' : 'gpt-6-luna', owner }, never)
        .then(
          () => null,
          (error: Error) => error,
        );
      expect(failure?.cause).toBe(c.cause);
      expect(failure?.message).not.toContain(KEY);
      expect(failure?.message).not.toContain('distributed task queue');
      const attempt = t.attempts.get('judge_run_1_effect_1');
      expect(attempt?.status).toBe('failed');
      expect(JSON.stringify(attempt)).not.toContain(KEY);
    }
  });

  it('aborts the request when the judgment is no longer wanted, and records it as cancelled', async () => {
    const t = await apisWith(
      (init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    await t.apis.setKey('openai-decisions', KEY);
    const listeners = new Set<() => void>();
    let aborted = false;
    const cancellation: DecisionCancellation = {
      get aborted() {
        return aborted;
      },
      onCancel: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const judged = judgeOf(t.apis, 'openai-decisions').judge(
      input,
      { model: 'gpt-6-luna', owner },
      cancellation,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    aborted = true;
    for (const fn of listeners) fn();
    await expect(judged).rejects.toThrow();
    expect(t.attempts.get('judge_run_1_effect_1')?.status).toBe('cancelled');
  });

  it('calls nothing without a key', async () => {
    const t = await apisWith(() => new Response(jevAnswer('low')));
    for (const id of ['jev', 'openai-decisions'] as const)
      await expect(
        judgeOf(t.apis, id).judge(input, { model: 'm', owner }, never),
      ).rejects.toMatchObject({ cause: 'unavailable' });
    expect(t.sent).toHaveLength(0);
  });
});
