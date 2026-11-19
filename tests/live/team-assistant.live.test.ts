import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ErrorCode,
  hasReviewLoop,
  type ModelAttemptPage,
  type TeamAssistantReply,
  type TeamAssistantRequest,
  TeamAssistantResponse,
  type TeamAssistantTeam,
} from '@corral/contracts';
import { expect, it } from 'vitest';
import {
  type LiveProfileServer,
  withLiveProfile,
  writeLiveResults,
} from './fixtures/profile-server.ts';

// One free-text Studio request per case. No drafts are applied, saved as teams or executed.
const profiles = [process.env.CORRAL_ASSISTANT_PROFILE ?? 'deepseek-hive'];
if (process.env.CORRAL_ASSISTANT_SECOND === '1') profiles.push('zai-org-glm-5.3-flash');
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
    accepts: (r) => r.kind === 'plan',
  },
  {
    id: 'negated-review',
    mode: 'create',
    message: '작성자가 필요할 때만 전문가에게 자문한다. 검토 통과나 자동 관찰은 필요 없다',
    accepts: (r) =>
      r.kind === 'plan' &&
      !hasReviewLoop(r.plan.pattern) &&
      r.plan.outrider !== 'required_review' &&
      !r.plan.observeWork,
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
        pattern: reply.plan.pattern,
        outrider: reply.plan.outrider ?? null,
        observeWork: !!reply.plan.observeWork,
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

it.skipIf(process.env.CORRAL_TEAM_ASSISTANT_LIVE !== '1')(
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
              ...(test.mode === 'edit' ? { mode: 'edit', team } : { mode: 'create' }),
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
