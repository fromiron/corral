import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type DecisionCancellation,
  EFFORT_LEVELS,
  type ExternalEffortJudge,
  type ModelAttempt,
  type ModelAttemptStore,
  type ReasoningInput,
} from '@corral/contracts';
import { effortText } from '@corral/local-intelligence';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { z } from 'zod';

// TypeSafe's Jev as automatic reasoning's external judge. It sees only the judge text the local
// judge read and the level criteria; the key stays in the user's credential store and is never
// returned, logged or put in an error or attempt record.

export const JEV_CREDENTIAL = 'typesafe';
export const JEV_MODEL = 'jev-latest';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_RESPONSE = 64 * 1024;
const NO_KEY = 'no TypeSafe API key is configured';

const INSTRUCTIONS =
  'Choose how much reasoning effort an AI coding agent should spend on the request in the state. ' +
  'Judge how hard the request is, not how long it is.';
const CRITERIA = {
  low: 'A direct answer, a lookup, a small mechanical edit, or a routine next step that needs little planning.',
  medium:
    'Ordinary development work: a focused change, a bug with a clear cause, or a step that needs some reasoning.',
  high: 'Multi-step work that needs a plan: changes across several files, unclear causes, or careful trade-offs.',
  xhigh:
    'Hard, open-ended problems: system design, subtle concurrency or correctness issues, or deep analysis.',
} satisfies Record<(typeof EFFORT_LEVELS)[number], string>;

const Answer = z.object({
  model: z.string().min(1).max(200),
  answers: z.object({
    effort: z.object({ type: z.literal('choice'), choice: z.enum(EFFORT_LEVELS) }),
  }),
});
const tokens = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

type Cause = 'provider_error' | 'invalid_response' | 'cancelled' | 'unavailable';
const failure = (message: string, cause: Cause) => new Error(message, { cause });

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw failure('Jev returned no body', 'invalid_response');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_RESPONSE) throw failure('Jev response is too large', 'invalid_response');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw failure('Jev returned a response Corral cannot read', 'invalid_response');
  }
}

export interface JevOptions {
  credentials: CredentialStore;
  attempts?: ModelAttemptStore;
  fetchFn?: typeof fetch;
  now?: () => string;
}

export class JevJudge implements ExternalEffortJudge {
  readonly provider = 'jev' as const;
  private readonly credentials: CredentialStore;
  private readonly attempts: ModelAttemptStore | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => string;
  private hasKey: boolean;

  /** Reads once whether a key is stored, so `available()` needs no I/O. */
  static async open(options: JevOptions): Promise<JevJudge> {
    return new JevJudge(options, Boolean(await JevJudge.readKey(options.credentials)));
  }

  private constructor(options: JevOptions, hasKey: boolean) {
    this.credentials = options.credentials;
    this.attempts = options.attempts;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.hasKey = hasKey;
  }

  private static async readKey(credentials: CredentialStore) {
    const stored = await credentials.read(JEV_CREDENTIAL);
    return stored?.type === 'api_key' && stored.key ? stored.key : null;
  }

  available(): true | string {
    return this.hasKey || NO_KEY;
  }
  keyConfigured() {
    return this.hasKey;
  }
  async setKey(key: string) {
    await this.credentials.modify(JEV_CREDENTIAL, async () => ({ type: 'api_key', key }));
    this.hasKey = true;
  }
  async deleteKey() {
    await this.credentials.delete(JEV_CREDENTIAL);
    this.hasKey = false;
  }

  async judge(
    input: ReasoningInput,
    request: Parameters<ExternalEffortJudge['judge']>[1],
    cancellation: DecisionCancellation,
  ): Promise<{ answer: string; model: string }> {
    const key = await JevJudge.readKey(this.credentials);
    if (!key) throw failure(NO_KEY, 'unavailable');
    if (cancellation.aborted) throw failure('Jev judgment cancelled', 'cancelled');
    const body = {
      model: request.model,
      state: effortText(input),
      questions: { effort: { type: 'choice', instructions: INSTRUCTIONS, criteria: CRITERIA } },
    };
    const { owner } = request;
    const attempt: ModelAttempt = {
      version: 2,
      attemptId: `judge_${owner.runId}_${owner.effectId}`,
      intent: {
        requestId: owner.effectId,
        purpose: 'reasoning_effort',
        revision: owner.attemptNo,
        owner: {
          kind: 'judge',
          id: owner.effectId,
          runId: owner.runId,
          executionId: owner.executionId,
        },
      },
      provider: JEV_CREDENTIAL,
      modelId: request.model,
      status: 'started',
      startedAt: this.now(),
      endedAt: null,
      payloadHash: createHash('sha256').update(canonicalJson(body)).digest('hex'),
      payloadBytes: Buffer.byteLength(canonicalJson(body)),
      firstEventAt: null,
      failure: null,
      usage: {
        version: 2,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        source: 'unknown',
        // TypeSafe publishes no prices.
        costStatus: 'unknown',
        costUsd: null,
      },
    };
    this.attempts?.put(attempt);
    const abort = new AbortController();
    const off = cancellation.onCancel(() => abort.abort());
    let status: number | null = null;
    try {
      const response = await this.fetchFn(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: abort.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      status = response.status;
      attempt.firstEventAt = this.now();
      // Error bodies may echo the request or the key; only the status is kept.
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failure(`Jev HTTP ${response.status}`, 'provider_error');
      }
      const raw = (await boundedJson(response)) as {
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      const usage = {
        inputTokens: tokens(raw?.usage?.input_tokens),
        outputTokens: tokens(raw?.usage?.output_tokens),
      };
      attempt.usage = {
        ...attempt.usage,
        ...usage,
        source: usage.inputTokens !== null && usage.outputTokens !== null ? 'reported' : 'unknown',
      };
      const parsed = Answer.safeParse(raw);
      if (!parsed.success)
        throw failure('Jev returned an answer Corral cannot use', 'invalid_response');
      if (abort.signal.aborted) throw failure('Jev judgment cancelled', 'cancelled');
      attempt.status = 'completed';
      attempt.endedAt = this.now();
      this.attempts?.put(attempt);
      return { answer: parsed.data.answers.effort.choice, model: parsed.data.model };
    } catch (error) {
      const cancelled = abort.signal.aborted;
      const known = error instanceof Error && typeof error.cause === 'string';
      // A request that failed without a response may still have reached TypeSafe.
      attempt.status = cancelled ? 'cancelled' : known ? 'failed' : 'unknown';
      attempt.endedAt = this.now();
      attempt.failure = {
        code: cancelled ? 'cancelled' : known ? String(error.cause) : 'network_error',
        status,
        retryAfterMs: null,
        requestId: null,
      };
      try {
        this.attempts?.put(attempt);
      } catch {
        /* The judgment's outcome stands without its record. */
      }
      if (cancelled) throw failure('Jev judgment cancelled', 'cancelled');
      if (known) throw error;
      throw failure('Jev request failed', 'provider_error');
    } finally {
      off();
    }
  }
}
