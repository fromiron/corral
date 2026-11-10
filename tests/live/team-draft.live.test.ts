import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  type ModelAttemptPage,
  TEAM_PATTERNS,
  TEAM_SLOTS,
  type TeamPattern,
  TeamPlan,
} from '@corral/contracts';
import { PATTERN_TEMPLATES, planFromGoal, type TeamWording } from '@corral/core';
import {
  type CorralServer,
  createLiveModels,
  type ModelProfileView,
  startCorralServer,
} from '@corral/server';
import { describe, expect, it } from 'vitest';

// Pattern choice of "Draft a team from a goal" with real models (docs/specs/features/library.md).
// Opt-in only, never in ordinary CI: one draft request per goal per model, through the same
// route and ModelRegistry.draftTeam the Studio uses, each model in its own temporary workspace
// whose only profile is that model. The signed-in OpenAI account comes from Corral's own sign-in
// or the Codex CLI login, as for `pnpm corral dev`; nothing here changes either.
//
//   CORRAL_DRAFT_LIVE=1 \
//   CORRAL_DRAFT_GOALS=tests/live/fixtures/team-draft-goals.dev.json \
//   CORRAL_DRAFT_MODELS=gpt-6-luna,gpt-6.1-terra \
//   CORRAL_DRAFT_OUT=/path/outside/the/repo/result.json \
//   pnpm test:live team-draft.live.test.ts
//
// The result keeps the chosen pattern, acceptance, latency and request counts. It never keeps
// or prints the answer text, the goal's draft, credentials or local paths.

const enabled = process.env.CORRAL_DRAFT_LIVE === '1';
/** A run's whole budget: two models over a 20-goal set is 40. */
const REQUEST_CAP = 60;
const PROVIDER = 'openai';

interface GoalEntry {
  id: string;
  goal: string;
  accept: TeamPattern[];
}

/** A goals file: `{ split?, goals: [{ id, goal, accept: [pattern, ...] }] }`. */
function goalSet(value: unknown): { split: string | null; goals: GoalEntry[] } {
  const set = value as { split?: unknown; goals?: unknown };
  if (!Array.isArray(set.goals) || set.goals.length === 0)
    throw new Error('The goals file has no goals.');
  const goals = set.goals.map((entry: Partial<GoalEntry>, index) => {
    const accept = Array.isArray(entry.accept) ? entry.accept : [];
    if (
      typeof entry.id !== 'string' ||
      typeof entry.goal !== 'string' ||
      !entry.goal.trim() ||
      entry.goal.length > 2000 ||
      accept.length === 0 ||
      !accept.every((pattern) => (TEAM_PATTERNS as readonly string[]).includes(pattern))
    )
      throw new Error(`Goal ${index + 1} needs an id, a goal and known accepted patterns.`);
    return { id: entry.id, goal: entry.goal, accept };
  });
  return { split: typeof set.split === 'string' ? set.split : null, goals };
}

/** A wording for the local rule's choice; the words do not affect which pattern it picks. */
const LOCAL_WORDING: TeamWording = {
  roles: Object.fromEntries(
    ['worker', 'planner', 'researcher', 'writer', 'reviewer'].map((slot) => [
      slot,
      { name: slot, duty: `Do the ${slot} part.` },
    ]),
  ) as TeamWording['roles'],
  criteria: { direct: 'Answer the brief.', sources: 'Name the sources.' },
  labels: { loop: 'Review loop', decision: 'Review decision', output: 'Output', join: 'Join' },
  templates: Object.fromEntries(
    Object.keys(PATTERN_TEMPLATES).map((pattern) => [
      pattern,
      {
        roles: Object.fromEntries(
          TEAM_SLOTS[pattern as TeamPattern].map((slot) => [
            slot,
            { name: slot, duty: `Do the ${slot} part.` },
          ]),
        ),
        criteria: ['Do what the brief asks.'],
      },
    ]),
  ) as unknown as NonNullable<TeamWording['templates']>,
};

interface GoalResult {
  id: string;
  /** The chosen pattern, `invalid` when the answer failed the contract, `error` when no answer. */
  pattern: TeamPattern | 'invalid' | 'error';
  accepted: boolean;
  latencyMs: number;
  /** The route's error code when there was no usable plan. */
  code?: string;
  /** Provider attempts behind the one draft request (managed retries included). */
  attempts: number;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

interface ModelResult {
  modelId: string;
  /** What the server said about the profile before any draft request. */
  profile: { available: boolean; method: string | null; subscriptionSupported: boolean | null };
  stoppedBecause?: string;
  goals: GoalResult[];
  accepted: number;
  invalid: number;
  errors: number;
}

function settings() {
  const goalsPath = process.env.CORRAL_DRAFT_GOALS;
  const out = process.env.CORRAL_DRAFT_OUT;
  const models = (process.env.CORRAL_DRAFT_MODELS ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (!goalsPath || !out || models.length === 0)
    throw new Error('Set CORRAL_DRAFT_GOALS, CORRAL_DRAFT_MODELS and CORRAL_DRAFT_OUT.');
  const set = goalSet(JSON.parse(readFileSync(resolve(goalsPath), 'utf8')));
  if (set.goals.length * models.length > REQUEST_CAP)
    throw new Error(`The run would exceed its ${REQUEST_CAP} request cap.`);
  return { set, models: [...new Set(models)], out: resolve(out) };
}

async function signedInServer(modelId: string) {
  const directory = mkdtempSync(join(tmpdir(), 'corral-draft-live-'));
  mkdirSync(join(directory, '.corral'));
  writeFileSync(
    join(directory, '.corral', 'config.json'),
    JSON.stringify({
      schemaVersion: '0.1',
      // The draft request uses the first profile; this workspace has only the measured model.
      modelProfiles: [{ id: 'draft-live', provider: PROVIDER, model: modelId }],
    }),
  );
  const server: CorralServer = await startCorralServer({
    workspace: directory,
    port: 0,
    live: createLiveModels(),
    // No run is started here; a simulated execution would be a bug.
    agents: {
      start: async () => {
        throw new Error('unexpected execution in the draft measurement');
      },
    },
    worktreeRoot: join(directory, 'worktrees'),
    bootstrapToken: randomUUID(),
  });
  const token = new URL(server.bootstrapUrl).hash.replace('#bootstrap=', '');
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token }),
  });
  if (login.status !== 204) throw new Error('The temporary server refused its own login.');
  const headers = {
    'content-type': 'application/json',
    origin: server.url,
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
  };
  const api = (path: string, body?: unknown) =>
    fetch(`${server.url}/api/v1${path}`, {
      headers,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const close = async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { api, close };
}

async function measure(
  modelId: string,
  goals: GoalEntry[],
  budget: { used: number },
): Promise<ModelResult> {
  const server = await signedInServer(modelId);
  const result: ModelResult = {
    modelId,
    profile: { available: false, method: null, subscriptionSupported: null },
    goals: [],
    accepted: 0,
    invalid: 0,
    errors: 0,
  };
  try {
    const profiles: ModelProfileView[] = await (await server.api('/model-profiles')).json();
    const profile = profiles.find((value) => value.profileId === 'draft-live');
    result.profile = {
      available: profile?.available ?? false,
      method: profile?.method ?? null,
      subscriptionSupported: profile?.subscriptionSupported ?? null,
    };
    // Without a sign-in or with a refused model, no draft request is sent at all.
    if (!profile?.available) {
      result.stoppedBecause = 'profile not available (sign-in missing or model refused)';
      return result;
    }
    for (const entry of goals) {
      if (budget.used >= REQUEST_CAP) throw new Error('request cap reached');
      budget.used += 1;
      const operationId = `draft_live_${randomUUID()}`;
      const started = performance.now();
      const response = await server.api('/team-drafts', { goal: entry.goal, operationId });
      const latencyMs = Math.round(performance.now() - started);
      const body: unknown = await response.json();
      let pattern: GoalResult['pattern'];
      let code: string | undefined;
      const plan = response.ok ? TeamPlan.safeParse((body as { plan?: unknown }).plan) : null;
      if (plan?.success) pattern = plan.data.pattern;
      else {
        const error = (body as { error?: { code?: string; message?: string } }).error;
        code = error?.code ?? `HTTP_${response.status}`;
        // The route's own wording for an answer that failed the contract.
        pattern =
          code === 'MODEL_UNAVAILABLE' &&
          /answer was not a usable team plan/.test(error?.message ?? '')
            ? 'invalid'
            : 'error';
      }
      const page: ModelAttemptPage = await (
        await server.api(`/model-attempts?ownerId=${encodeURIComponent(operationId)}`)
      ).json();
      const reported = page.items.filter((attempt) => attempt.usage.source === 'reported');
      const goal: GoalResult = {
        id: entry.id,
        pattern,
        accepted: (entry.accept as string[]).includes(pattern),
        latencyMs,
        ...(code ? { code } : {}),
        attempts: page.items.length,
        outputTokens: reported.length
          ? reported.reduce((sum, attempt) => sum + (attempt.usage.outputTokens ?? 0), 0)
          : null,
        reasoningTokens: reported.length
          ? reported.reduce((sum, attempt) => sum + (attempt.usage.reasoningTokens ?? 0), 0)
          : null,
      };
      result.goals.push(goal);
      if (goal.accepted) result.accepted += 1;
      if (pattern === 'invalid') result.invalid += 1;
      if (pattern === 'error') result.errors += 1;
    }
    return result;
  } finally {
    await server.close();
  }
}

describe.skipIf(!enabled)('team draft pattern choice with real models', () => {
  it('drafts each goal once per model and records the chosen patterns', async () => {
    const { set, models, out } = settings();
    const startedAt = new Date().toISOString();
    const budget = { used: 0 };
    const results: ModelResult[] = [];
    const local = set.goals.map((entry) => {
      const pattern = planFromGoal(entry.goal, LOCAL_WORDING)?.pattern ?? null;
      return {
        id: entry.id,
        pattern,
        accepted: pattern !== null && (entry.accept as string[]).includes(pattern),
      };
    });
    let failure: string | null = null;
    try {
      for (const modelId of models) {
        const measured = await measure(modelId, set.goals, budget);
        results.push(measured);
        if (measured.stoppedBecause) {
          failure = `${modelId}: ${measured.stoppedBecause}`;
          break;
        }
      }
    } catch (error) {
      // Provider errors can carry request details; keep only the kind of failure.
      failure = error instanceof Error ? error.message.slice(0, 200) : 'unknown failure';
    } finally {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            split: set.split,
            startedAt,
            completedAt: new Date().toISOString(),
            requests: budget.used,
            requestCap: REQUEST_CAP,
            failure,
            local: {
              accepted: local.filter((goal) => goal.accepted).length,
              total: local.length,
              goals: local,
            },
            models: results,
          },
          null,
          2,
        )}\n`,
      );
    }
    console.log(
      `[draft live] ${results
        .map(
          (model) =>
            `${model.modelId}: ${model.accepted}/${model.goals.length} accepted, ${model.invalid} invalid, ${model.errors} errors`,
        )
        .join(
          '; ',
        )}; local ${local.filter((goal) => goal.accepted).length}/${local.length}; ${budget.used} requests`,
    );
    expect(failure).toBeNull();
    expect(budget.used).toBeLessThanOrEqual(REQUEST_CAP);
  }, 3_600_000);
});

describe.runIf(!enabled)('team draft live measurement', () => {
  it('is skipped unless CORRAL_DRAFT_LIVE=1 (it calls real models with your sign-in)', () => {
    expect(enabled).toBe(false);
  });
});
