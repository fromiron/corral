import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ErrorCode,
  type ModelAttemptPage,
  type TeamAssistantReply,
  type TeamAssistantRequest,
  TeamAssistantResponse,
  type TeamAssistantTeam,
  type TeamComposition,
} from '@corral/contracts';
import { BUILTIN_SKILLS, ROLE_PRESET_IDS, roleFromPreset, teamCatalog } from '@corral/core';
import { expect, it } from 'vitest';
import {
  type LiveProfileServer,
  withLiveProfile,
  writeLiveResults,
} from './fixtures/profile-server.ts';

// One free-text Studio request per case. No drafts are applied, saved as teams or executed.
//   CORRAL_TEAM_ASSISTANT_LIVE=1 [CORRAL_ASSISTANT_PROFILE=…] [CORRAL_ASSISTANT_SECOND=1] \
//   [CORRAL_ASSISTANT_OUT=results.json] pnpm test:live tests/live/team-assistant.live.test.ts
// With CORRAL_ASSISTANT_GOALS=<goals file> the run measures new team requests instead: each goal
// of the file is sent once in create mode and one record per goal is written.
const profiles = [process.env.CORRAL_ASSISTANT_PROFILE ?? 'deepseek-hive'];
if (process.env.CORRAL_ASSISTANT_SECOND === '1') profiles.push('zai-org-glm-5.3-flash');
const live = process.env.CORRAL_TEAM_ASSISTANT_LIVE === '1';
const goalsPath = process.env.CORRAL_ASSISTANT_GOALS;

// The catalog a new team request carries: the bundled agents and skills, as the editor's own
// "add agent" and "add skill" offer them.
const crew = teamCatalog(
  ROLE_PRESET_IDS.map((id) => {
    const { id: _id, ...role } = roleFromPreset(id, id, id);
    return { role, origin: { kind: 'preset' as const, presetId: id }, builtin: true };
  }),
  BUILTIN_SKILLS.map((skill) => ({
    ref: { resourceHash: skill.resourceHash, entry: skill.entry },
    name: skill.name,
    description: skill.description,
  })),
);
const { catalog } = crew;
const stepKinds = (plan: TeamComposition) =>
  plan.flow.map((step) => ('seat' in step ? 'seat' : 'parallel' in step ? 'parallel' : 'loop'));
const target = { outputId: 'output', index: 1 };
const team: TeamAssistantTeam = {
  roles: [
    { nodeId: 'planner', name: '기획자' },
    { nodeId: 'writer', name: '작성자' },
  ],
  outputs: [
    { outputId: target.outputId, results: [{ index: 1, name: '안내문', producerName: '작성자' }] },
  ],
  hasSharedOutrider: false,
  brief: '동네 자전거 소풍 안내문을 작성한다.',
};

interface Case {
  id: string;
  mode: 'create' | 'edit';
  message: string;
  decisions?: TeamAssistantRequest['decisions'];
  accepts(reply: TeamAssistantReply): boolean;
}

const cases: Case[] = [
  {
    id: 'sufficient',
    mode: 'create',
    message: '작성자 한 명으로 동네 자전거 소풍 안내문을 써 줘',
    // One writer was named: one seat.
    accepts: (r) => r.kind === 'plan' && r.plan.seats.length === 1,
  },
  {
    id: 'negated-review',
    mode: 'create',
    message: '작성자가 필요할 때만 전문가에게 자문한다. 검토 통과나 자동 관찰은 필요 없다',
    accepts: (r) =>
      r.kind === 'plan' &&
      !stepKinds(r.plan).includes('loop') &&
      r.plan.outrider !== 'required_review',
  },
  {
    id: 'underspecified',
    mode: 'create',
    message: '매주 동네 행사 소식지를 만들고 싶어',
    // TeamAssistantResponse validates each question id and that id's allowed choices.
    accepts: (r) => r.kind === 'question' || r.kind === 'plan',
  },
  {
    id: 'submitter',
    mode: 'edit',
    message: '지금 최종 결과는 누가 내?',
    accepts: (r) => r.kind === 'describe' && r.topic === 'submitter',
  },
  {
    id: 'on-demand-advice',
    mode: 'edit',
    message: '필요할 때만 조언받게 해 줘',
    accepts: (r) =>
      r.kind === 'edits' && r.edits.length === 1 && r.edits[0]?.kind === 'add_shared_advice',
  },
  {
    id: 'required-review',
    mode: 'edit',
    message: '통과해야 제출되게 해 줘',
    accepts: (r) =>
      (r.kind === 'question' && (r.id === 'review_target' || r.id === 'review_policy')) ||
      (r.kind === 'edits' &&
        r.edits.some(
          (e) =>
            e.kind === 'require_review' &&
            e.outputId === target.outputId &&
            e.index === target.index,
        )),
  },
  {
    id: 'opinion-only',
    mode: 'edit',
    message: '발행 전에 검토받게 해 줘',
    decisions: { reviewPolicy: 'opinion_only' },
    accepts: (r) =>
      r.kind !== 'plan' &&
      !(r.kind === 'edits' && r.edits.some((e) => e.kind === 'require_review')),
  },
];

type Facts = Record<string, string | number | boolean | null | string[]>;

function facts(reply: TeamAssistantReply): Facts {
  switch (reply.kind) {
    case 'question':
      return { questionId: reply.id, choices: reply.choices.length };
    case 'plan':
      return {
        seats: reply.plan.seats.length,
        flow: stepKinds(reply.plan),
        outrider: reply.plan.outrider ?? null,
      };
    case 'describe':
      return { topic: reply.topic };
    case 'edits':
      return { edits: reply.edits.map((e) => e.kind) };
    case 'unsupported':
      return {};
  }
}

interface Result {
  profileId: string;
  id: string;
  kind: TeamAssistantReply['kind'] | 'error' | 'invalid';
  accepted: boolean;
  status: number;
  latencyMs: number;
  requests: number;
  details?: Facts;
  code?: ErrorCode | null;
  sameResult?: boolean;
}

function errorCode(body: unknown) {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return ErrorCode.safeParse(code).data ?? null;
}

async function attempts(api: LiveProfileServer['api'], operationId: string) {
  const response = await api(`/model-attempts?ownerId=${encodeURIComponent(operationId)}`);
  if (!response.ok) throw new Error(`Attempt history returned ${response.status}`);
  const page: ModelAttemptPage = await response.json();
  if (page.nextCursor !== null) throw new Error('Unexpected additional attempt history page');
  return page.items;
}

it.skipIf(!live || !!goalsPath)(
  'reconciles real create and edit replies and replays a stored operation without a provider request',
  async () => {
    const results: Result[] = [];
    try {
      for (const profileId of new Set(profiles)) {
        await withLiveProfile(profileId, 420_000, async ({ api }) => {
          let replayed = false;
          for (const test of cases) {
            const operationId = `assistant_${randomUUID()}`;
            const request: TeamAssistantRequest = {
              ...(test.mode === 'edit' ? { mode: 'edit', team } : { mode: 'create', catalog }),
              operationId,
              messages: [{ role: 'user', content: test.message }],
              ...(test.decisions ? { decisions: test.decisions } : {}),
            };
            const start = performance.now();
            const response = await api('/team-assistant', request);
            const body: unknown = await response.json();
            const latencyMs = Math.round(performance.now() - start);
            const history = await attempts(api, operationId);
            const parsed = TeamAssistantResponse.safeParse(body);
            const reply = response.ok && parsed.success ? parsed.data.reply : undefined;
            const result: Result = {
              profileId,
              id: test.id,
              kind:
                reply?.kind ??
                (history.some((a) => a.status === 'completed') ? 'invalid' : 'error'),
              accepted: !!reply && test.accepts(reply) && history.length === 1,
              latencyMs,
              status: response.status,
              requests: history.length,
              ...(reply ? { details: facts(reply) } : {}),
              ...(!response.ok ? { code: errorCode(body) } : {}),
            };
            results.push(result);
            console.log(JSON.stringify(result));
            if (result.kind === 'error') break; // Do not spend more on a provider failure.
            if (!reply || replayed) continue;
            const beforeReplay = performance.now();
            const replay = await api('/team-assistant', request);
            const stored: unknown = await replay.json();
            const replayLatency = Math.round(performance.now() - beforeReplay);
            const after = await attempts(api, operationId);
            const checked = TeamAssistantResponse.safeParse(stored);
            const sameResult = replay.status === response.status && isDeepStrictEqual(stored, body);
            const replayResult: Result = {
              profileId,
              id: `${test.id}-replay`,
              kind: checked.success ? checked.data.reply.kind : 'invalid',
              accepted:
                sameResult &&
                checked.success &&
                history.length === 1 &&
                after.length === 1 &&
                after[0]?.attemptId === history[0]?.attemptId,
              sameResult,
              latencyMs: replayLatency,
              status: replay.status,
              requests: after.length - history.length,
              ...(!replay.ok ? { code: errorCode(stored) } : {}),
            };
            results.push(replayResult);
            console.log(JSON.stringify(replayResult));
            replayed = true;
          }
        });
      }
    } finally {
      writeLiveResults(process.env.CORRAL_ASSISTANT_OUT, results);
    }
    expect(
      results.filter((r) => !r.accepted).map((r) => `${r.profileId}/${r.id}:${r.kind}`),
    ).toEqual([]);
    expect(results).toHaveLength(new Set(profiles).size * (cases.length + 1));
  },
  450_000 * profiles.length,
);

/** A goals file: `{ split?, goals: [{ id, goal, ... }] }`, as `fixtures/team-draft-goals.*.json`. */
function goalsOf(value: unknown): { id: string; goal: string }[] {
  const goals = (value as { goals?: unknown }).goals;
  if (!Array.isArray(goals) || goals.length === 0) throw new Error('The goals file has no goals.');
  return goals.map((entry: { id?: unknown; goal?: unknown }, index) => {
    if (typeof entry.id !== 'string' || typeof entry.goal !== 'string')
      throw new Error(`Goal ${index} needs a string id and goal.`);
    return { id: entry.id, goal: entry.goal };
  });
}

/** One new team request, as measured: whether the answer was usable and what it composed. */
interface GoalRecord {
  profileId: string;
  id: string;
  usable: boolean;
  kind: TeamAssistantReply['kind'] | 'invalid' | 'error';
  problem?: string;
  seats: { agentName: string; changesFiles: boolean }[];
  flow: string[];
  hasChangingSeat: boolean;
  outrider: TeamComposition['outrider'] | null;
  ms: number;
  outputTokens?: number;
}

it.skipIf(!live || !goalsPath)(
  'measures the usable answers to new team requests, one request per goal',
  async () => {
    const goals = goalsOf(JSON.parse(readFileSync(resolve(goalsPath ?? ''), 'utf8')));
    const records: GoalRecord[] = [];
    const agents = new Map(catalog.agents.map((agent) => [agent.id, agent]));
    try {
      for (const profileId of new Set(profiles)) {
        await withLiveProfile(profileId, 100_000 * goals.length, async ({ api }) => {
          for (const entry of goals) {
            const operationId = `assistant_goal_${randomUUID()}`;
            const request: TeamAssistantRequest = {
              mode: 'create',
              operationId,
              messages: [{ role: 'user', content: entry.goal }],
              catalog,
            };
            const start = performance.now();
            const response = await api('/team-assistant', request);
            const body: unknown = await response.json();
            const ms = Math.round(performance.now() - start);
            const history = await attempts(api, operationId);
            const parsed = TeamAssistantResponse.safeParse(body);
            const reply = response.ok && parsed.success ? parsed.data.reply : undefined;
            const plan = reply?.kind === 'plan' ? reply.plan : undefined;
            const seats = (plan?.seats ?? []).map((seat) => ({
              agentName: agents.get(seat.agent)?.name ?? seat.agent,
              changesFiles: agents.get(seat.agent)?.changesFiles ?? false,
            }));
            const reported = history.filter((attempt) => attempt.usage.source === 'reported');
            const answered = history.some((attempt) => attempt.status === 'completed');
            const record: GoalRecord = {
              profileId,
              id: entry.id,
              usable: !!reply,
              kind: reply?.kind ?? (answered ? 'invalid' : 'error'),
              ...(reply ? {} : { problem: errorCode(body) ?? `HTTP_${response.status}` }),
              seats,
              flow: plan ? stepKinds(plan) : [],
              hasChangingSeat: seats.some((seat) => seat.changesFiles),
              outrider: plan?.outrider ?? null,
              ms,
              ...(reported.length
                ? {
                    outputTokens: reported.reduce(
                      (sum, attempt) => sum + (attempt.usage.outputTokens ?? 0),
                      0,
                    ),
                  }
                : {}),
            };
            records.push(record);
            console.log(JSON.stringify(record));
            // No answer at all (a timeout, a sign-in or a refused model): stop this model rather
            // than spend the rest of the set on the same failure.
            if (record.kind === 'error') break;
          }
        });
      }
    } finally {
      writeLiveResults(process.env.CORRAL_ASSISTANT_OUT, records);
    }
    // A measurement: no pattern or composition is asserted, only that a goal was sent.
    expect(records.length).toBeGreaterThan(0);
  },
  110_000 * 200 * profiles.length,
);
