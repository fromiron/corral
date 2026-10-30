import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionCancellation, ModelAttempt, ReasoningInput } from '@corral/contracts';
import { effortText } from '@corral/local-intelligence';
import { afterEach, describe, expect, it } from 'vitest';
import { JevJudge } from '../src/jev.ts';
import { FileCredentialStore } from '../src/models/credential-store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEY = 'ts-secret-key-0123456789';
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
const answered = (choice: string, extra: Record<string, unknown> = {}) =>
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

async function judgeWith(respond: (init: RequestInit) => Promise<Response> | Response) {
  const dir = mkdtempSync(join(tmpdir(), 'corral-jev-'));
  dirs.push(dir);
  const sent: { url: string; init: RequestInit }[] = [];
  const attempts = new Map<string, ModelAttempt>();
  const judge = await JevJudge.open({
    credentials: new FileCredentialStore(dir),
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
  return { judge, sent, attempts, dir };
}

describe('Jev external judge', () => {
  it('sends the judge text and an effort choice, and records the attempt with its usage', async () => {
    const t = await judgeWith(() => new Response(answered('xhigh'), { status: 200 }));
    expect(t.judge.available()).toMatch(/no TypeSafe API key/);
    await t.judge.setKey(KEY);
    expect(t.judge.available()).toBe(true);
    expect(t.judge.keyConfigured()).toBe(true);

    const result = await t.judge.judge(input, { model: 'jev-latest', owner }, never);
    expect(result).toEqual({ answer: 'xhigh', model: 'jev-2026-09-15' });

    expect(t.sent).toHaveLength(1);
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

    const attempt = t.attempts.get('judge_run_1_effect_1');
    expect(attempt).toMatchObject({
      status: 'completed',
      provider: 'typesafe',
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

  it('reports HTTP errors and answers it cannot use without the key or the response body', async () => {
    const cases = [
      {
        response: () =>
          new Response(`{"detail":"bad key ${KEY} for ${input.request}"}`, { status: 401 }),
        cause: 'provider_error',
        status: 'failed',
      },
      { response: () => new Response(answered('max'), { status: 200 }), cause: 'invalid_response' },
      { response: () => new Response('not json', { status: 200 }), cause: 'invalid_response' },
      {
        response: () => new Response(answered('high', { padding: 'x'.repeat(70_000) })),
        cause: 'invalid_response',
      },
    ];
    for (const c of cases) {
      const t = await judgeWith(c.response);
      await t.judge.setKey(KEY);
      const failure = await t.judge.judge(input, { model: 'jev-latest', owner }, never).then(
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
    const t = await judgeWith(
      (init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    await t.judge.setKey(KEY);
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
    const judged = t.judge.judge(input, { model: 'jev-latest', owner }, cancellation);
    await new Promise((resolve) => setTimeout(resolve, 5));
    aborted = true;
    for (const fn of listeners) fn();
    await expect(judged).rejects.toThrow();
    expect(t.attempts.get('judge_run_1_effect_1')?.status).toBe('cancelled');
  });

  it('keeps the key in the credential store only, and calls nothing without one', async () => {
    const t = await judgeWith(() => new Response(answered('low')));
    await expect(t.judge.judge(input, { model: 'jev-latest', owner }, never)).rejects.toMatchObject(
      { cause: 'unavailable' },
    );
    expect(t.sent).toHaveLength(0);
    await t.judge.setKey(KEY);
    const reopened = await JevJudge.open({ credentials: new FileCredentialStore(t.dir) });
    expect(reopened.keyConfigured()).toBe(true);
    await reopened.deleteKey();
    expect(reopened.available()).toMatch(/no TypeSafe API key/);
    expect(
      (await JevJudge.open({ credentials: new FileCredentialStore(t.dir) })).keyConfigured(),
    ).toBe(false);
  });
});
