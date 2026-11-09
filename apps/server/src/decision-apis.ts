import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type DecisionApiId,
  EFFORT_LEVELS,
  type EffortQuestion,
  type ModelAttempt,
  type ModelAttemptStore,
  type RouterRequest,
  type RouterResponse,
  type RoutingBackend,
  type RoutingEngine,
  type RoutingFallbackReason,
  type RoutingFlight,
  type RoutingLease,
  type UsageRecordV2,
} from '@corral/contracts';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { z } from 'zod';

// Decision-only APIs (docs/specs/features/decision-apis.md), each one a Manual effort routing
// engine. An API sees only the frame's state and the fixed question. Keys live in the user's
// credential store under their own names, apart from model sign-ins, and are never returned,
// logged or put in an error or attempt record.

const MAX_RESPONSE = 64 * 1024;
/** The data notice shown before a person agrees to send state to an API. */
const NOTICE_VERSION = 1;

/** The consent a saved API engine must carry; another notice version sends nothing. */
export const decisionApiConsent = (id: DecisionApiId) => `${id}:notice-${NOTICE_VERSION}`;

const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
type Usage = Pick<
  UsageRecordV2,
  'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
>;
type Answer = { choice: string; probabilities?: Record<string, number> };

interface DecisionApiSpec {
  id: DecisionApiId;
  /** Who runs it, for the settings list. */
  provider: string;
  model: string;
  endpoint: string;
  body(state: string, question: EffortQuestion, model: string): unknown;
  /** The chosen level and the distribution, or null when the answer cannot be used. */
  answer(raw: unknown): Answer | null;
  usage(raw: unknown): Partial<Usage>;
}

const Probability = z.number().finite();
// TypeSafe OpenAPI 0.2.0: https://api.typesafe.ai/openapi.json
const JevAnswer = z.object({
  model: z.string().min(1).max(200),
  answers: z.object({
    effort: z.object({
      type: z.literal('choice'),
      choice: z.enum(EFFORT_LEVELS),
      probabilities: z.record(z.string().max(20), Probability).optional(),
    }),
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
        probabilities: z
          .array(z.object({ value: z.string().max(20), probability: Probability }))
          .max(EFFORT_LEVELS.length)
          .optional(),
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
    body: (state, question, model) => ({
      model,
      state,
      questions: {
        effort: {
          type: 'choice',
          instructions: question.instructions,
          criteria: question.criteria,
        },
      },
    }),
    answer: (raw) => {
      const parsed = JevAnswer.safeParse(raw);
      if (!parsed.success) return null;
      const { choice, probabilities } = parsed.data.answers.effort;
      return probabilities ? { choice, probabilities } : { choice };
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
    body: (state, question, model) => ({
      model,
      input: state,
      questions: [
        {
          type: 'choice',
          name: 'effort',
          instructions: question.instructions,
          choices: Object.entries(question.criteria).map(([value, description]) => ({
            value,
            description,
          })),
        },
      ],
    }),
    // A refusal, or any answer other than one effort choice, is not usable.
    answer: (raw) => {
      const parsed = OpenAiAnswer.safeParse(raw);
      const [effort] = parsed.success ? parsed.data.answers : [];
      if (!effort) return null;
      if (!effort.probabilities) return { choice: effort.choice };
      const probabilities = Object.fromEntries(
        effort.probabilities.map((p) => [p.value, p.probability]),
      );
      // A level listed twice is not a distribution.
      if (Object.keys(probabilities).length !== effort.probabilities.length) return null;
      return { choice: effort.choice, probabilities };
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
const REASONS: Record<Cause, RoutingFallbackReason> = {
  provider_error: 'transport-error',
  invalid_response: 'invalid-response',
  // The host stopped waiting; its own outcome already stands.
  cancelled: 'transport-error',
  unavailable: 'unavailable',
};
/** An engine failure: `reason` is the routing fallback, `cause` the attempt record's code. */
const failure = (message: string, cause: Cause) =>
  Object.assign(new Error(message, { cause }), { reason: REASONS[cause] });
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
  monotonicMs: () => number;
}

export class DecisionApiJudge {
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

  /**
   * The routing engine for a saved setting. No queue and no Busy: each request makes its own one
   * call. Without the current consent or a key it sends nothing.
   */
  backend(consentRevision: string): RoutingBackend {
    const identity = `${this.spec.id}/${this.spec.model}`;
    return {
      kind: 'api',
      identity: () => identity,
      admit: () => {
        if (consentRevision !== decisionApiConsent(this.spec.id))
          return { ok: false, reason: 'consent-required' };
        if (!this.hasKey) return { ok: false, reason: 'unavailable' };
        return { ok: true, lease: this.lease(identity) };
      },
    };
  }

  private lease(identity: string): RoutingLease {
    const { spec } = this;
    return {
      identity,
      frame: 'api-bounded',
      device: null,
      countState: async (text) => Buffer.byteLength(text),
      // The exact request body: what is counted is what is sent.
      countInput: async (state, question) =>
        Buffer.byteLength(JSON.stringify(spec.body(state, question, spec.model))),
      start: (request) => this.call(request),
      release: () => {},
    };
  }

  private call(request: RouterRequest): RoutingFlight {
    const result = this.send(request);
    // The only physical end Corral sees for a remote call is its connection closing.
    const end = () => ({
      basis: 'remote-transport-closed' as const,
      finishedAtMs: this.shared.monotonicMs(),
    });
    return { result, settled: result.then(end, end) };
  }

  private async send(request: RouterRequest): Promise<RouterResponse> {
    const { attempts, fetchFn, now } = this.shared;
    const { owner, signal } = request;
    if (!owner) throw failure('no run effect owns this judgment', 'unavailable');
    const key = await readKey(this.shared.credentials, this.spec.id);
    if (!key) throw failure(this.noKey, 'unavailable');
    if (signal.aborted) throw failure('the judgment was cancelled', 'cancelled');
    const body = this.spec.body(request.state, request.question, this.spec.model);
    const text = JSON.stringify(body);
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
      modelId: this.spec.model,
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
    const off = signal.onCancel(() => abort.abort());
    let status: number | null = null;
    try {
      const response = await fetchFn(this.spec.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: abort.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: text,
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
      attempt.status = 'completed';
      attempt.endedAt = now();
      attempts?.put(attempt);
      return { ...answer, inputTokens: usage.inputTokens ?? null, billableUnits: null };
    } catch (error) {
      const cancelled = abort.signal.aborted;
      const known = error instanceof Error && typeof error.cause === 'string';
      // A request that failed without a response may still have reached the API. A closed
      // connection is Corral's stop; it says nothing about the remote's work or billing.
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
  /** The host's monotonic clock, for when a call physically ended. */
  monotonicMs?: () => number;
}

/** The supported decision APIs on one credential store. */
export class DecisionApis {
  private readonly credentials: CredentialStore;
  private readonly entries: readonly DecisionApiJudge[];

  /** Reads once which keys are stored, so admission needs no I/O. */
  static async open(options: DecisionApiOptions): Promise<DecisionApis> {
    const shared: Shared = {
      credentials: options.credentials,
      attempts: options.attempts,
      fetchFn: options.fetchFn ?? fetch,
      now: options.now ?? (() => new Date().toISOString()),
      monotonicMs: options.monotonicMs ?? (() => performance.now()),
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

  /** The engine a saved API setting names, or null for an API Corral does not support. */
  backend(engine: Extract<RoutingEngine, { kind: 'api' }>): RoutingBackend | null {
    return (
      this.entries.find((e) => e.provider === engine.id)?.backend(engine.consentRevision) ?? null
    );
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
