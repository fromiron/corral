import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ErrorCode,
  type ModelAttemptPage,
  stepSeats,
  type TeamAssistantReply,
  TeamAssistantRequest,
  TeamAssistantResponse,
  type TeamAssistantTeam,
  type TeamComposition,
  unusableTeamProposalReason,
} from '@corral/contracts';
import {
  BUILTIN_SKILLS,
  builtinComposableAgents,
  compileDefinition,
  draftFromComposition,
  planRun,
  teamCatalog,
} from '@corral/core';
import { describe, expect, it } from 'vitest';
import {
  type LiveProfileServer,
  withLiveProfile,
  writeLiveResults,
} from './fixtures/profile-server.ts';
import {
  agentIdByName,
  type CheckRecord,
  caseCatalog,
  checkFileOf,
  checkRequest,
  checkSummaryOf,
  compiledWith,
  flowShape,
  missedExpectations,
  namedComposition,
  proposalFor,
  seatedAgents,
} from './fixtures/team-assistant-checks.ts';

// One free-text Studio request per case. No drafts are applied, saved as teams or executed.
//   CORRAL_TEAM_ASSISTANT_LIVE=1 [CORRAL_ASSISTANT_PROFILE=…] [CORRAL_ASSISTANT_SECOND=1] \
//   [CORRAL_ASSISTANT_OUT=results.json] pnpm test:live tests/live/team-assistant.live.test.ts
// With CORRAL_ASSISTANT_GOALS=<goals file> the run measures new team requests instead: each goal
// of the file (fixtures/team-compose-goals.dev.json) is sent once in create mode, one record per
// goal is written, then a summary per model. A file with `cases` instead of `goals`
// (fixtures/team-compose-goals.check.json) runs the check cases: each with its own catalog, its
// user messages and shown proposal, repeats after every first send, one record per scheduled send.
// Without CORRAL_TEAM_ASSISTANT_LIVE only the checks that need no model run.
const profiles = [process.env.CORRAL_ASSISTANT_PROFILE ?? 'deepseek-hive'];
if (process.env.CORRAL_ASSISTANT_SECOND === '1') profiles.push('zai-org-glm-5.3-flash');
const live = process.env.CORRAL_TEAM_ASSISTANT_LIVE === '1';
const goalsPath = process.env.CORRAL_ASSISTANT_GOALS;
const goalFile: unknown = goalsPath ? JSON.parse(readFileSync(resolve(goalsPath), 'utf8')) : null;
const checkMode = typeof goalFile === 'object' && goalFile !== null && 'cases' in goalFile;

// The catalog a new team request carries: the bundled agents (described, under a seat name) and
// skills, as the editor's own "add agent" and "add skill" offer them.
const bundledAgents = builtinComposableAgents(
  (id) => `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
);
const bundledSkills = BUILTIN_SKILLS.map((skill) => ({
  ref: { resourceHash: skill.resourceHash, entry: skill.entry },
  name: skill.name,
  description: skill.description,
}));
const crew = teamCatalog(bundledAgents, bundledSkills);
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

it.skipIf(!live || !!goalFile)(
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

/** A goal of the goals file and the labels written for it before the measurement. */
interface Goal {
  id: string;
  goal: string;
  lang?: 'ko' | 'en';
  /** `now`: a question is a miss; `either`: a question is acceptable. */
  plan?: 'now' | 'either';
  /** true: needs a seat that changes files; false: must have none; absent: either. */
  changes?: boolean;
  /** A small edit one seat should do alone. */
  oneSeat?: true;
}

/** A goals file: `{ split?, goals: [{ id, goal, lang?, plan?, changes?, oneSeat? }] }`. */
function goalsOf(value: unknown): Goal[] {
  const goals = (value as { goals?: unknown }).goals;
  if (!Array.isArray(goals) || goals.length === 0) throw new Error('The goals file has no goals.');
  return goals.map((entry: Record<string, unknown>, index) => {
    if (typeof entry.id !== 'string' || typeof entry.goal !== 'string')
      throw new Error(`Goal ${index} needs a string id and goal.`);
    return {
      id: entry.id,
      goal: entry.goal,
      ...(entry.lang === 'ko' || entry.lang === 'en' ? { lang: entry.lang } : {}),
      ...(entry.plan === 'now' || entry.plan === 'either' ? { plan: entry.plan } : {}),
      ...(typeof entry.changes === 'boolean' ? { changes: entry.changes } : {}),
      ...(entry.oneSeat === true ? { oneSeat: true as const } : {}),
    };
  });
}

/** One new team request, as measured: what came back and what it composed. */
interface GoalRecord {
  profileId: string;
  id: string;
  kind: TeamAssistantReply['kind'] | 'invalid' | 'error';
  questionId?: string;
  /**
   * The refusal's whole reason (`cut_off`, `shape:plan.criteria.2:too_long`, …), `''` when it
   * names none, or the error code of another failure.
   */
  reason?: string;
  seats: number;
  flow: string[];
  /** The agents of the last step that produce the team's result. */
  lastStep: { agentName: string; output: string; changesFiles: boolean }[];
  loops: { rounds: number }[];
  /** A group side by side with two or more agents that change files. */
  parallelWriters: boolean;
  hasChangingSeat: boolean;
  skillsAdded: number;
  /** The composition assembles and compiles with no error and runs as a plan. */
  compiles: boolean;
  /** Korean goal: Hangul in the team name and every duty; English goal: none. */
  languageMatches: boolean | null;
  ms: number;
  outputTokens?: number;
  /** Physical model requests recorded for the operation. */
  attempts: number;
  /** The composed team as the editor received it, with each seat's agent named, for reading. */
  composition?: TeamComposition;
  /** The plan's reason sentence, where a plan can promise what its team does not enforce. */
  planReason?: string;
}

const HANGUL = /[가-힣]/;
const ASSEMBLY = { loop: 'Loop', decision: 'Decision', join: 'Join', output: 'Output' };

function compiles(plan: TeamComposition): boolean {
  try {
    const definition = draftFromComposition(plan, 'measured', crew, ASSEMBLY);
    const compiled = compileDefinition(definition, { knownModelProfiles: ['model-a', 'model-b'] });
    return (
      compiled.ok &&
      compiled.diagnostics.every((d) => d.severity !== 'error') &&
      planRun(definition).ok
    );
  } catch {
    return false;
  }
}

function languageMatches(goal: Goal, plan: TeamComposition): boolean | null {
  if (!goal.lang) return null;
  const texts = [plan.name, ...plan.seats.map((seat) => seat.duty)];
  return goal.lang === 'ko'
    ? texts.every((text) => HANGUL.test(text))
    : texts.every((text) => !HANGUL.test(text));
}

/** The headline of one model's run; nothing asserts on it. */
function summaryOf(profileId: string, goals: Goal[], records: GoalRecord[]) {
  const label = new Map(goals.map((goal) => [goal.id, goal]));
  const now = records.filter((r) => label.get(r.id)?.plan === 'now');
  const either = records.filter((r) => label.get(r.id)?.plan === 'either');
  const immediate = now.filter((r) => r.kind === 'plan');
  const good = immediate.filter((r) => {
    const goal = label.get(r.id);
    return (
      r.compiles &&
      (goal?.changes === undefined || goal.changes === r.hasChangingSeat) &&
      (!goal?.oneSeat || r.seats === 1) &&
      r.languageMatches !== false
    );
  });
  const refusals: Record<string, number> = {};
  for (const r of records)
    if (r.kind === 'invalid' || r.kind === 'error') {
      const key = r.reason || r.kind;
      refusals[key] = (refusals[key] ?? 0) + 1;
    }
  return {
    profileId,
    summary: true,
    goals: {
      planned: goals.length,
      attempted: records.length,
      skipped: goals.length - records.length,
    },
    nowGoals: goals.filter((goal) => goal.plan === 'now').length,
    immediatePlans: immediate.length,
    goodPlans: good.length,
    goodPlanIds: good.map((r) => r.id),
    questionsOnNow: now.filter((r) => r.kind === 'question').length,
    questionsOnEither: either.filter((r) => r.kind === 'question').length,
    /** Goals the model never answered: a timeout, a sign-in or a refused request. */
    noAnswers: records.filter((r) => r.kind === 'error').length,
    refusals,
  };
}

it.skipIf(!live || !goalFile || checkMode)(
  'measures new team requests against the goals’ labels, one request per goal',
  async () => {
    const goals = goalsOf(goalFile);
    const written: unknown[] = [];
    const agents = new Map(catalog.agents.map((agent) => [agent.id, agent]));
    try {
      for (const profileId of new Set(profiles)) {
        const records: GoalRecord[] = [];
        await withLiveProfile(profileId, 100_000 * goals.length, async ({ api }) => {
          let unanswered = 0;
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
            const seats = new Map((plan?.seats ?? []).map((seat) => [seat.id, seat]));
            const agentOf = (seatId: string) => agents.get(seats.get(seatId)?.agent ?? '');
            const last = plan?.flow.at(-1);
            const producers = !last
              ? []
              : 'loop' in last
                ? last.loop.work.slice(-1)
                : stepSeats(last);
            const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
            const reason = typeof message === 'string' ? unusableTeamProposalReason(message) : null;
            const reported = history.filter((attempt) => attempt.usage.source === 'reported');
            const answered = history.some((attempt) => attempt.status === 'completed');
            const record: GoalRecord = {
              profileId,
              id: entry.id,
              kind: reply?.kind ?? (answered ? 'invalid' : 'error'),
              ...(reply?.kind === 'question' ? { questionId: reply.id } : {}),
              ...(reply ? {} : { reason: reason ?? errorCode(body) ?? `HTTP_${response.status}` }),
              seats: plan?.seats.length ?? 0,
              flow: plan ? stepKinds(plan) : [],
              lastStep: producers.map((seatId) => ({
                agentName: agentOf(seatId)?.name ?? '?',
                output: agentOf(seatId)?.output ?? '?',
                changesFiles: agentOf(seatId)?.changesFiles ?? false,
              })),
              loops: (plan?.flow ?? []).flatMap((step) =>
                'loop' in step ? [{ rounds: step.loop.rounds ?? 2 }] : [],
              ),
              parallelWriters: (plan?.flow ?? []).some(
                (step) =>
                  'parallel' in step &&
                  step.parallel.filter((seatId) => agentOf(seatId)?.changesFiles).length >= 2,
              ),
              hasChangingSeat: [...seats.keys()].some((seatId) => agentOf(seatId)?.changesFiles),
              skillsAdded: (plan?.seats ?? []).reduce(
                (sum, seat) => sum + (seat.skills?.length ?? 0),
                0,
              ),
              ...(plan
                ? {
                    composition: {
                      ...plan,
                      seats: plan.seats.map((seat) => ({
                        ...seat,
                        agent: agentOf(seat.id)?.name ?? seat.agent,
                      })),
                    },
                  }
                : {}),
              ...(reply?.kind === 'plan' ? { planReason: reply.reason } : {}),
              compiles: plan ? compiles(plan) : false,
              languageMatches: plan ? languageMatches(entry, plan) : null,
              ms,
              ...(reported.length
                ? {
                    outputTokens: reported.reduce(
                      (sum, attempt) => sum + (attempt.usage.outputTokens ?? 0),
                      0,
                    ),
                  }
                : {}),
              attempts: history.length,
            };
            records.push(record);
            console.log(JSON.stringify(record));
            // No answer at all (a timeout, a sign-in or a refused model) twice in a row: stop this
            // model rather than spend the rest of the set on the same failure. One alone may pass.
            unanswered = record.kind === 'error' ? unanswered + 1 : 0;
            if (unanswered >= 2) break;
          }
        });
        const summary = summaryOf(profileId, goals, records);
        console.log(JSON.stringify(summary));
        written.push(...records, summary);
      }
    } finally {
      writeLiveResults(process.env.CORRAL_ASSISTANT_OUT, written);
    }
    // A measurement: no pattern or composition is asserted, only that a goal was sent.
    expect(written.length).toBeGreaterThan(0);
  },
  110_000 * 200 * profiles.length,
);

it.skipIf(!live || !checkMode)(
  'sends the check cases, each against its own catalog, and repeats the marked ones',
  async () => {
    const file = checkFileOf(goalFile);
    // Every catalog and proposal is built before the first request: a name that does not resolve
    // stops the run here.
    const prepared = new Map(
      file.cases.map((entry) => {
        const resolved = caseCatalog(file, entry, bundledAgents, bundledSkills);
        const proposal = entry.proposal && proposalFor(entry.proposal, resolved.catalog);
        return [entry.id, { resolved, proposal }] as const;
      }),
    );
    const schedule = [
      ...file.cases.map((entry) => ({ entry, send: 'first' as const })),
      ...file.cases
        .filter((entry) => entry.repeat)
        .map((entry) => ({ entry, send: 'repeat' as const })),
    ];
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const written: unknown[] = [];
    try {
      for (const profileId of new Set(profiles)) {
        const header = { header: true, split: file.split, commit, profileId };
        console.log(JSON.stringify(header));
        written.push(header);
        const records: CheckRecord[] = [];
        // Each row is kept as it is made, so a run that breaks off still writes what it sent.
        const keep = (record: CheckRecord) => {
          records.push(record);
          written.push(record);
          console.log(JSON.stringify(record));
        };
        const rowOf = ({ entry, send }: (typeof schedule)[number]) => ({
          profileId,
          case: entry.id,
          kind: entry.kind,
          lang: entry.lang,
          send,
          fit: null,
        });
        try {
          await withLiveProfile(profileId, 100_000 * schedule.length, async ({ api }) => {
            let unanswered = 0;
            for (const scheduled of schedule) {
              const { entry } = scheduled;
              const row = rowOf(scheduled);
              // Two sends in a row with no answer stop this model; the rest are written as skipped.
              if (unanswered >= 2) {
                keep({ ...row, operationId: null, outcome: 'skipped' });
                continue;
              }
              const { resolved, proposal } = prepared.get(entry.id) as NonNullable<
                ReturnType<typeof prepared.get>
              >;
              const operationId = `assistant_check_${randomUUID()}`;
              const request = checkRequest(entry, resolved.catalog, proposal, operationId);
              const start = performance.now();
              const response = await api('/team-assistant', request);
              const body: unknown = await response.json();
              const ms = Math.round(performance.now() - start);
              // The attempt history carries no reasoning level, so none is recorded.
              const history = await attempts(api, operationId);
              const parsed = TeamAssistantResponse.safeParse(body);
              const reply = response.ok && parsed.success ? parsed.data.reply : undefined;
              const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
              const reason =
                typeof message === 'string' ? unusableTeamProposalReason(message) : null;
              const reported = history.filter((attempt) => attempt.usage.source === 'reported');
              const answered = history.some((attempt) => attempt.status === 'completed');
              const outcome: CheckRecord['outcome'] =
                reply?.kind === 'plan' || reply?.kind === 'question'
                  ? reply.kind
                  : reply || answered
                    ? 'invalid'
                    : 'error';
              const plan = reply?.kind === 'plan' ? reply.plan : undefined;
              const record: CheckRecord = {
                ...row,
                operationId,
                outcome,
                ...(reply?.kind === 'question' ? { questionId: reply.id } : {}),
                // A reply of a kind create mode does not take is named by its kind.
                ...(reply && !plan && reply.kind !== 'question' ? { reason: reply.kind } : {}),
                ...(!reply && answered
                  ? { reason: reason ?? errorCode(body) ?? `HTTP_${response.status}` }
                  : {}),
                ...(!reply && !answered
                  ? { code: errorCode(body) ?? reason ?? `HTTP_${response.status}` }
                  : {}),
                ms,
                attempts: history.length,
                ...(reported.length
                  ? {
                      outputTokens: reported.reduce(
                        (sum, attempt) => sum + (attempt.usage.outputTokens ?? 0),
                        0,
                      ),
                    }
                  : {}),
                ...(plan && reply?.kind === 'plan'
                  ? {
                      composition: namedComposition(plan, resolved.catalog),
                      planReason: reply.reason,
                      flow: flowShape(plan),
                      agents: seatedAgents(plan, resolved.catalog),
                      ...compiledWith(plan, resolved),
                    }
                  : {}),
                ...(reply?.kind === 'plan' || reply?.kind === 'question'
                  ? {
                      failed: missedExpectations(reply, entry.expect, resolved.catalog, entry.lang),
                    }
                  : {}),
              };
              keep(record);
              unanswered = outcome === 'error' ? unanswered + 1 : 0;
            }
          });
        } finally {
          // A send the run never reached is written as skipped; the error still ends the run.
          for (const scheduled of schedule.slice(records.length))
            keep({ ...rowOf(scheduled), operationId: null, outcome: 'skipped' });
          const summary = checkSummaryOf(profileId, records);
          console.log(JSON.stringify(summary));
          written.push(summary);
        }
      }
    } finally {
      writeLiveResults(process.env.CORRAL_ASSISTANT_OUT, written);
    }
    // A measurement: nothing about the replies is asserted, only that the cases were scheduled.
    expect(written.length).toBeGreaterThan(0);
  },
  110_000 * 40 * profiles.length,
);

describe('check cases, without a model', () => {
  const file = checkFileOf(
    JSON.parse(
      readFileSync(resolve(import.meta.dirname, 'fixtures/team-compose-goals.check.json'), 'utf8'),
    ),
  );
  const caseOf = (id: string) =>
    file.cases.find((entry) => entry.id === id) as (typeof file.cases)[number];
  const bundled = caseCatalog(file, { catalog: 'bundled' }, bundledAgents, bundledSkills);
  const legal = caseCatalog(file, { catalog: 'legal' }, bundledAgents, bundledSkills);

  it('reads every case of the check file and resolves each proposal against its own catalog', () => {
    expect(file.cases.length).toBeGreaterThan(0);
    // Nothing written for the person who rates is ever sent.
    const forRater = [
      ...Object.values(file.agents).flatMap((list) => list.map((agent) => agent.description)),
      ...file.cases.map((entry) => entry.rater),
    ].filter((text): text is string => !!text);
    for (const entry of file.cases) {
      const { catalog: sent } = caseCatalog(file, entry, bundledAgents, bundledSkills);
      const proposal = entry.proposal && proposalFor(entry.proposal, sent);
      // What the run sends is a request the endpoint accepts, messages in the file's order.
      const request = TeamAssistantRequest.parse(checkRequest(entry, sent, proposal, entry.id));
      expect(request.messages.map((message) => message.content)).toEqual(entry.messages);
      expect(request.mode === 'create' && request.proposal).toEqual(proposal);
      const sentText = JSON.stringify(request);
      for (const text of forRater) expect(sentText).not.toContain(text);
    }
  });

  it('sends a library agent as Studio does: named, with its abilities and output, never described', () => {
    expect(legal.catalog.agents.slice(0, bundled.catalog.agents.length)).toEqual(
      bundled.catalog.agents,
    );
    const added = legal.catalog.agents.slice(bundled.catalog.agents.length);
    expect(added).toEqual([
      {
        id: expect.any(String),
        name: '번역가',
        changesFiles: false,
        runsCommands: false,
        output: 'draft',
        skills: [],
      },
      {
        id: expect.any(String),
        name: '법무 검토자',
        changesFiles: false,
        runsCommands: false,
        output: 'review',
        skills: [],
      },
    ]);
    expect(JSON.stringify(legal.catalog)).not.toContain('약관과 계약 문구');
    const reviewer = legal.agentById.get(agentIdByName(legal.catalog, '법무 검토자'));
    expect(reviewer?.origin?.kind).toBe('library');
    expect(reviewer).not.toHaveProperty('description');
    // The bundled agents keep the description the editor gives them.
    expect(bundled.catalog.agents.every((agent) => !!agent.description)).toBe(true);
    const analytics = caseCatalog(file, caseOf('check-06'), bundledAgents, bundledSkills).catalog;
    expect(analytics.agents.find((agent) => agent.name === 'Chart Maker')).toMatchObject({
      changesFiles: true,
      runsCommands: true,
      output: 'draft',
    });
    expect(analytics.agents.find((agent) => agent.name === 'Data Analyst')).toMatchObject({
      changesFiles: false,
      runsCommands: true,
      output: 'notes',
    });
  });

  it('resolves a proposal’s agent names to the ids of the catalog it is sent with, or fails', () => {
    const shown = caseOf('check-08').proposal as TeamComposition;
    const sent = proposalFor(shown, bundled.catalog);
    const [first] = shown.seats as [TeamComposition['seats'][number]];
    const elsewhere = { ...shown, seats: [{ ...first, agent: '번역가' }] };
    expect(sent.seats.map((seat) => seat.agent)).toEqual(
      ['Researcher', 'Writer', 'Reviewer'].map((name) => agentIdByName(bundled.catalog, name)),
    );
    expect(sent.flow).toEqual(shown.flow);
    expect(() => proposalFor(elsewhere, bundled.catalog)).toThrow(/번역가/);
    expect(proposalFor(elsewhere, legal.catalog).seats[0]?.agent).toBe(
      agentIdByName(legal.catalog, '번역가'),
    );
  });

  it('assembles a plan with a library agent against the catalog it was sent with', () => {
    const id = (name: string) => agentIdByName(legal.catalog, name);
    const plan: TeamComposition = {
      name: '약관 번역',
      brief: '약관을 영어로 옮긴다.',
      criteria: ['조항 번호가 유지된다.'],
      seats: [
        { id: 't', agent: id('번역가'), name: '번역', duty: '약관을 번역한다.' },
        { id: 'r', agent: id('법무 검토자'), name: '검토', duty: '번역을 검토한다.' },
      ],
      flow: [{ loop: { work: ['t'], judge: 'r' } }],
    };
    expect(compiledWith(plan, legal).compiles).toBe(true);
    // The bundled crew alone does not hold these ids' agents.
    expect(compiledWith(plan, bundled).compiles).toBe(false);
  });

  it('names each expectation a hand-written plan misses, and checks none that is absent', () => {
    const id = (name: string) => agentIdByName(bundled.catalog, name);
    const seat = (seatId: string, name: string) => ({
      id: seatId,
      agent: id(name),
      name,
      duty: `Do the ${name.toLowerCase()} work.`,
    });
    const reply = (changes: Partial<TeamComposition>): TeamAssistantReply => ({
      kind: 'plan',
      reason: 'Fits.',
      plan: {
        name: 'Team',
        brief: 'Do it.',
        criteria: ['Done.'],
        seats: [seat('b', 'Builder')],
        flow: [{ seat: 'b' }],
        ...changes,
      },
    });
    const judged = reply({
      seats: [seat('w', 'Writer'), seat('r', 'Reviewer')],
      flow: [{ loop: { work: ['w'], judge: 'r', rounds: 3 } }],
    });
    const side = reply({
      seats: [seat('w', 'Writer'), seat('b', 'Builder')],
      flow: [{ parallel: ['w', 'b'] }],
      outrider: 'consultation',
    });
    const missed = (r: TeamAssistantReply, expect: Parameters<typeof missedExpectations>[1]) =>
      missedExpectations(r, expect, bundled.catalog, 'en');
    const single = reply({});
    expect(missed(single, { reply: 'plan' })).toEqual([]);
    expect(missed(single, { reply: 'plan', changes: false })).toEqual(['changes']);
    expect(missed(judged, { reply: 'plan', changes: true })).toEqual(['changes']);
    expect(missed(judged, { reply: 'plan', submitters: ['Builder'] })).toEqual(['submitters']);
    expect(missed(judged, { reply: 'plan', submitters: ['Writer'] })).toEqual([]);
    expect(missed(side, { reply: 'plan', oneResult: true })).toEqual(['oneResult']);
    expect(missed(judged, { reply: 'plan', oneResult: true })).toEqual([]);
    expect(missed(single, { reply: 'plan', loop: 'warranted' })).toEqual(['loop']);
    expect(missed(judged, { reply: 'plan', loop: 'none' })).toEqual(['loop']);
    expect(missed(judged, { reply: 'plan', loop: 'allowed' })).toEqual([]);
    expect(missed(judged, { reply: 'plan', judges: ['Verifier'] })).toEqual(['judges']);
    expect(missed(judged, { reply: 'plan', rounds: 2 })).toEqual(['rounds']);
    expect(
      missed(
        reply({
          seats: [seat('w', 'Writer'), seat('r', 'Reviewer')],
          flow: [{ loop: { work: ['w'], judge: 'r' } }],
        }),
        { reply: 'plan', rounds: 2 },
      ),
    ).toEqual([]);
    expect(missed(side, { reply: 'plan', maxSeats: 1 })).toEqual(['maxSeats']);
    expect(missed(single, { reply: 'plan', uses: ['Builder', 'Writer'] })).toEqual(['uses']);
    expect(missed(single, { reply: 'plan', keeps: ['Writer'] })).toEqual(['keeps']);
    expect(missed(judged, { reply: 'plan', drops: ['Reviewer'] })).toEqual(['drops']);
    expect(missed(single, { reply: 'plan', drops: ['Reviewer'] })).toEqual([]);
    expect(missed(side, { reply: 'plan', outrider: ['none'] })).toEqual(['outrider']);
    expect(missed(side, { reply: 'plan', outrider: ['consultation'] })).toEqual([]);
    expect(missedExpectations(single, { reply: 'plan' }, bundled.catalog, 'ko')).toEqual(['lang']);
    const question: TeamAssistantReply = {
      kind: 'question',
      id: 'material',
      choices: ['person', 'team'],
    };
    expect(missed(question, { reply: 'plan' })).toEqual(['reply']);
    expect(missed(question, { reply: 'plan_or_question', question: 'material' })).toEqual([]);
    expect(missed(question, { reply: 'plan_or_question', question: 'review_policy' })).toEqual([
      'question',
    ]);
  });

  it('reports first sends and each repeat beside its first send', () => {
    const row = { profileId: 'p', kind: 'k', lang: 'en' as const, fit: null };
    const records: CheckRecord[] = [
      {
        ...row,
        case: 'a',
        send: 'first',
        operationId: 'o1',
        outcome: 'plan',
        failed: [],
        flow: ['seat'],
        agents: ['Builder'],
      },
      {
        ...row,
        case: 'b',
        send: 'first',
        operationId: 'o2',
        outcome: 'plan',
        failed: ['loop'],
        flow: ['seat'],
        agents: ['Writer'],
      },
      { ...row, case: 'c', send: 'first', operationId: 'o3', outcome: 'question', failed: [] },
      {
        ...row,
        case: 'd',
        send: 'first',
        operationId: 'o4',
        outcome: 'invalid',
        reason: 'cut_off',
      },
      {
        ...row,
        case: 'e',
        send: 'first',
        operationId: 'o5',
        outcome: 'error',
        code: 'MODEL_UNAVAILABLE',
      },
      { ...row, case: 'f', send: 'first', operationId: null, outcome: 'skipped' },
      {
        ...row,
        case: 'a',
        send: 'repeat',
        operationId: 'o6',
        outcome: 'plan',
        failed: [],
        flow: ['loop×1'],
        agents: ['Builder'],
      },
      {
        ...row,
        case: 'c',
        send: 'repeat',
        operationId: 'o7',
        outcome: 'plan',
        failed: [],
        flow: ['seat'],
        agents: ['Writer'],
      },
      {
        ...row,
        case: 'f',
        send: 'repeat',
        operationId: 'o8',
        outcome: 'plan',
        failed: [],
        flow: ['seat'],
        agents: ['Writer'],
      },
    ];
    expect(checkSummaryOf('p', records)).toEqual({
      profileId: 'p',
      summary: true,
      first: {
        sends: 6,
        plans: 2,
        questions: 1,
        refusals: 1,
        noAnswers: 1,
        skipped: 1,
        plansMissingNothing: 1,
        plansMissingNothingIds: ['a'],
      },
      repeats: [
        {
          case: 'a',
          outcomes: ['plan', 'plan'],
          sameOutcome: true,
          sameFlow: false,
          sameAgents: true,
        },
        {
          case: 'c',
          outcomes: ['question', 'plan'],
          sameOutcome: false,
          sameFlow: null,
          sameAgents: null,
        },
        {
          case: 'f',
          outcomes: ['skipped', 'plan'],
          sameOutcome: null,
          sameFlow: null,
          sameAgents: null,
        },
      ],
    });
  });
});
