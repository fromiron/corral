import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type DecisionApiId,
  type DecisionCancellation,
  EFFORT_LEVELS,
  type ExternalEffortJudge,
  type ModelAttempt,
  type ModelAttemptStore,
  type ReasoningInput,
  type UsageRecordV2,
} from '@corral/contracts';
import { effortText } from '@corral/local-intelligence';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { z } from 'zod';

// Decision-only APIs asked when automatic reasoning's local judge abstains
// (docs/specs/features/decision-apis.md). Each sees only the judge text the local judge read and
// the level criteria. Keys live in the user's credential store under their own names, apart from
// model sign-ins, and are never returned, logged or put in an error or attempt record.

const MAX_RESPONSE = 64 * 1024;
const INSTRUCTIONS =
  'Choose how much reasoning effort an AI coding agent should spend on the request in the input. ' +
  'Judge how hard the request is, not how long it is.';
const CRITERIA = {
  low: 'A direct answer, a lookup, a small mechanical edit, or a routine next step that needs little planning.',
  medium:
    'Ordinary development work: a focused change, a bug with a clear cause, or a step that needs some reasoning.',
  high: 'Multi-step work that needs a plan: changes across several files, unclear causes, or careful trade-offs.',
  xhigh:
    'Hard, open-ended problems: system design, subtle concurrency or correctness issues, or deep analysis.',
} satisfies Record<(typeof EFFORT_LEVELS)[number], string>;

const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
type Usage = Pick<
  UsageRecordV2,
  'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
>;

interface DecisionApiSpec {
  id: DecisionApiId;
  /** Who runs it, for the settings list. */
  provider: string;
  model: string;
  endpoint: string;
  body(text: string, model: string): unknown;
  /** The chosen level and the model that answered, or null when the answer cannot be used. */
  answer(raw: unknown): { answer: string; model: string } | null;
  usage(raw: unknown): Partial<Usage>;
}

// TypeSafe OpenAPI 0.2.0: https://api.typesafe.ai/openapi.json
const JevAnswer = z.object({
  model: z.string().min(1).max(200),
  answers: z.object({
    effort: z.object({ type: z.literal('choice'), choice: z.enum(EFFORT_LEVELS) }),
  }),
});
// https://developers.openai.com/api/reference/resources/decisions
const OpenAiAnswer = z.object({
  model: z.string().min(1).max(200),
  answers: z
    .array(
      z.object({
        type: z.literal('choice'),
        name: z.literal('effort'),
        choice: z.enum(EFFORT_LEVELS),
      }),
    )
    .length(1),
});

interface OpenAiUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
  output_tokens_details?: { reasoning_tokens?: unknown };
}

const SPECS: readonly DecisionApiSpec[] = [
  {
    id: 'jev',
    provider: 'TypeSafe',
    model: 'jev-latest',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    body: (text, model) => ({
      model,
      state: text,
      questions: { effort: { type: 'choice', instructions: INSTRUCTIONS, criteria: CRITERIA } },
    }),
    answer: (raw) => {
      const parsed = JevAnswer.safeParse(raw);
      return parsed.success
        ? { answer: parsed.data.answers.effort.choice, model: parsed.data.model }
        : null;
    },
    usage: (raw) => {
      const usage = (raw as { usage?: Record<string, unknown> } | null)?.usage;
      return { inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens) };
    },
  },
  {
    id: 'openai-decisions',
    provider: 'OpenAI',
    model: 'gpt-6-luna',
    endpoint: 'https://api.openai.com/v1/decisions',
    body: (text, model) => ({
      model,
      input: text,
      questions: [
        {
          type: 'choice',
          name: 'effort',
          instructions: INSTRUCTIONS,
          choices: EFFORT_LEVELS.map((value) => ({ value, description: CRITERIA[value] })),
        },
      ],
    }),
    // A refusal, or any answer other than one effort choice, is not usable.
    answer: (raw) => {
      const parsed = OpenAiAnswer.safeParse(raw);
      const [effort] = parsed.success ? parsed.data.answers : [];
      return parsed.success && effort ? { answer: effort.choice, model: parsed.data.model } : null;
    },
    // input_tokens already includes cached reads and writes, as Corral's records count them.
    usage: (raw) => {
      const usage = (raw as { usage?: OpenAiUsage } | null)?.usage;
      return {
        inputTokens: count(usage?.input_tokens),
        outputTokens: count(usage?.output_tokens),
        reasoningTokens: count(usage?.output_tokens_details?.reasoning_tokens),
        cacheReadTokens: count(usage?.input_tokens_details?.cached_tokens),
        cacheWriteTokens: count(usage?.input_tokens_details?.cache_write_tokens),
      };
    },
  },
];

type Cause = 'provider_error' | 'invalid_response' | 'cancelled' | 'unavailable';
const failure = (message: string, cause: Cause) => new Error(message, { cause });
const credentialId = (id: DecisionApiId) => `decision-api:${id}`;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw failure('the decision API returned no body', 'invalid_response');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_RESPONSE)
        throw failure('the decision API response is too large', 'invalid_response');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw failure('the decision API returned a response Corral cannot read', 'invalid_response');
  }
}

interface Shared {
  credentials: CredentialStore;
  attempts: ModelAttemptStore | undefined;
  fetchFn: typeof fetch;
  now: () => string;
}

class DecisionApiJudge implements ExternalEffortJudge {
  readonly provider: DecisionApiId;
  private readonly spec: DecisionApiSpec;
  private readonly shared: Shared;
  hasKey: boolean;

  constructor(spec: DecisionApiSpec, shared: Shared, hasKey: boolean) {
    this.provider = spec.id;
    this.spec = spec;
    this.shared = shared;
    this.hasKey = hasKey;
  }

  private get noKey() {
    return `no ${this.spec.provider} ${this.spec.id === 'jev' ? 'Jev' : 'Decisions'} API key is configured`;
  }

  available(): true | string {
    return this.hasKey || this.noKey;
  }

  async judge(
    input: ReasoningInput,
    request: Parameters<ExternalEffortJudge['judge']>[1],
    cancellation: DecisionCancellation,
  ): Promise<{ answer: string; model: string }> {
    const { attempts, fetchFn, now } = this.shared;
    const key = await readKey(this.shared.credentials, this.spec.id);
    if (!key) throw failure(this.noKey, 'unavailable');
    if (cancellation.aborted) throw failure('the judgment was cancelled', 'cancelled');
    const body = this.spec.body(effortText(input), request.model);
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
      provider: this.spec.id,
      modelId: request.model,
      status: 'started',
      startedAt: now(),
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
        // Judge calls do not spend the run budget; their price is not computed.
        costStatus: 'unknown',
        costUsd: null,
      },
    };
    attempts?.put(attempt);
    const abort = new AbortController();
    const off = cancellation.onCancel(() => abort.abort());
    let status: number | null = null;
    try {
      const response = await fetchFn(this.spec.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: abort.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      status = response.status;
      attempt.firstEventAt = now();
      // Error bodies may echo the request or the key; only the status is kept.
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failure(`the decision API returned HTTP ${response.status}`, 'provider_error');
      }
      const raw = await boundedJson(response);
      const usage = this.spec.usage(raw);
      attempt.usage = {
        ...attempt.usage,
        ...usage,
        source: usage.inputTokens != null && usage.outputTokens != null ? 'reported' : 'unknown',
      };
      const answer = this.spec.answer(raw);
      if (!answer)
        throw failure('the decision API returned an answer Corral cannot use', 'invalid_response');
      if (abort.signal.aborted) throw failure('the judgment was cancelled', 'cancelled');
      attempt.status = 'completed';
      attempt.endedAt = now();
      attempts?.put(attempt);
      return answer;
    } catch (error) {
      const cancelled = abort.signal.aborted;
      const known = error instanceof Error && typeof error.cause === 'string';
      // A request that failed without a response may still have reached the API.
      attempt.status = cancelled ? 'cancelled' : known ? 'failed' : 'unknown';
      attempt.endedAt = now();
      attempt.failure = {
        code: cancelled ? 'cancelled' : known ? String(error.cause) : 'network_error',
        status,
        retryAfterMs: null,
        requestId: null,
      };
      try {
        attempts?.put(attempt);
      } catch {
        /* The judgment's outcome stands without its record. */
      }
      if (cancelled) throw failure('the judgment was cancelled', 'cancelled');
      if (known) throw error;
      throw failure('the decision API request failed', 'provider_error');
    } finally {
      off();
    }
  }
}

async function readKey(credentials: CredentialStore, id: DecisionApiId) {
  const stored = await credentials.read(credentialId(id));
  return stored?.type === 'api_key' && stored.key ? stored.key : null;
}

export interface DecisionApiView {
  id: DecisionApiId;
  provider: string;
  model: string;
  keyConfigured: boolean;
}

export interface DecisionApiOptions {
  credentials: CredentialStore;
  attempts?: ModelAttemptStore;
  fetchFn?: typeof fetch;
  now?: () => string;
}

/** The supported decision APIs on one credential store. */
export class DecisionApis {
  private readonly credentials: CredentialStore;
  private readonly entries: readonly DecisionApiJudge[];

  /** Reads once which keys are stored, so `available()` needs no I/O. */
  static async open(options: DecisionApiOptions): Promise<DecisionApis> {
    const shared: Shared = {
      credentials: options.credentials,
      attempts: options.attempts,
      fetchFn: options.fetchFn ?? fetch,
      now: options.now ?? (() => new Date().toISOString()),
    };
    const entries = await Promise.all(
      SPECS.map(
        async (spec) =>
          new DecisionApiJudge(spec, shared, Boolean(await readKey(options.credentials, spec.id))),
      ),
    );
    return new DecisionApis(options.credentials, entries);
  }

  private constructor(credentials: CredentialStore, entries: readonly DecisionApiJudge[]) {
    this.credentials = credentials;
    this.entries = entries;
  }

  judges(): readonly ExternalEffortJudge[] {
    return this.entries;
  }
  list(): DecisionApiView[] {
    return SPECS.map((spec, index) => ({
      id: spec.id,
      provider: spec.provider,
      model: spec.model,
      keyConfigured: this.entries[index]?.hasKey ?? false,
    }));
  }
  async setKey(id: DecisionApiId, key: string) {
    await this.credentials.modify(credentialId(id), async () => ({ type: 'api_key', key }));
    this.entry(id).hasKey = true;
  }
  async deleteKey(id: DecisionApiId) {
    await this.credentials.delete(credentialId(id));
    this.entry(id).hasKey = false;
  }
  private entry(id: DecisionApiId) {
    const entry = this.entries.find((e) => e.provider === id);
    if (!entry) throw new Error(`unknown decision API ${id}`);
    return entry;
  }
}

/** The supported list without a credential store, for servers that cannot keep keys. */
export function decisionApiList(): DecisionApiView[] {
  return SPECS.map((spec) => ({
    id: spec.id,
    provider: spec.provider,
    model: spec.model,
    keyConfigured: false,
  }));
}
/** The model a workspace records when it chooses this API, or null for an unknown id. */
export function decisionApiModel(id: string): { id: DecisionApiId; model: string } | null {
  const spec = SPECS.find((s) => s.id === id);
  return spec ? { id: spec.id, model: spec.model } : null;
}
