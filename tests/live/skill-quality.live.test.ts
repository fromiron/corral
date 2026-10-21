import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  HarnessDefault,
  HarnessResourceView,
  SkillAdoption,
  SkillEvaluationView,
} from '@corral/contracts';
import { type CorralServer, createLiveModels, startCorralServer } from '@corral/server';
import { expect, it } from 'vitest';
import { candidateHash } from '../../tools/release/candidate.ts';

// Existing GPT OAuth only, isolated local library, 4 cases / at most 16 model requests.
it.skipIf(process.env.CORRAL_SKILL_LIVE !== '1')(
  '[TC-QEVAL-003-H] [TC-QEVAL-004-H] real GPT Skill comparison, explicit adoption and rollback',
  async () => {
    const candidate = candidateHash();
    const workspace = mkdtempSync(join(tmpdir(), 'corral-skill-live-'));
    let server: CorralServer | undefined;
    let requests = 0;
    let passed = false;
    let evidence: unknown = null;
    try {
      const live = createLiveModels();
      const agents = live.agents;
      live.agents = (...args) => {
        const adapter = agents(...args);
        return {
          start(input, host) {
            if (input.model.auth !== 'oauth') throw new Error('Skill live test requires GPT OAuth');
            return adapter.start(input, {
              ...host,
              prepareModelRequest(...parameters) {
                if (++requests > 16) throw new Error('Skill live request cap');
                return host.prepareModelRequest(...parameters);
              },
            });
          },
        };
      };
      server = await startCorralServer({
        workspace,
        worktreeRoot: join(workspace, 'worktrees'),
        port: 0,
        live,
        agents: {
          async start() {
            throw new Error('unexpected simulated execution');
          },
        },
      });
      const login = await fetch(`${server.url}/api/v1/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: server.url },
        body: JSON.stringify({
          token: new URL(server.bootstrapUrl).hash.slice('#bootstrap='.length),
        }),
      });
      expect(login.status).toBe(204);
      const headers = {
        'content-type': 'application/json',
        cookie: (login.headers.get('set-cookie') ?? '').split(';')[0]!,
        'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
        origin: server.url,
      };
      const call = async <T>(
        path: string,
        body?: unknown,
        method = body === undefined ? 'GET' : 'POST',
      ): Promise<T> => {
        const response = await fetch(`${server!.url}/api/v1/harness${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`Skill live API ${path}: ${response.status}`);
        return response.json() as Promise<T>;
      };
      const review = await call<{ reviewId: string }>('/documents/review', {
        kind: 'skill',
        name: 'Colour fixture',
        content:
          '---\nname: colour-fixture\ndescription: Use only when asked to name a primary colour; never for arithmetic.\n---\nWhen asked to name a primary colour, reply with exactly 파랑. Do not add punctuation or commentary.',
      });
      const resource = await call<HarnessResourceView>('/resources', { reviewId: review.reviewId });
      await call(`/resources/${resource.hash}/trust`, { trusted: true }, 'PUT');
      await call(
        '/profiles/live-fixture',
        {
          expectedRevision: 0,
          profile: {
            name: 'Live fixture',
            policy: 'strict',
            allowedTools: ['read', 'read_artifact', 'write_artifact', 'submit_result'],
            resources: [],
            startupCommands: [],
          },
        },
        'PUT',
      );
      await call(
        '/defaults/personal/default',
        { expectedRevision: 0, binding: { profileId: 'live-fixture', revision: 1 } },
        'PUT',
      );
      let evaluation = await call<SkillEvaluationView>('/skill-quality/evaluations', {
        operationId: 'skill-live-evaluation',
        candidate: { resourceHash: resource.hash, kind: 'skill', entry: resource.skills[0]!.entry },
        mode: 'live',
        modelProfile: 'model-a',
        fixtures: [
          {
            id: 'korean-colour',
            brief:
              '기본 색 한 가지를 말해 주세요. 정확히 파랑만 출력하세요. Read any applicable listed Skill before answering. Save the exact answer with write_artifact and submit_result; no clarification or research.',
            expected: { kind: 'exact', text: '파랑' },
            shouldActivate: true,
            phase: 'calibration',
          },
          {
            id: 'japanese-arithmetic',
            brief:
              '2+2はいくつですか。数字のみ。Colour instructions do not apply to arithmetic. Save the exact answer with write_artifact and submit_result; no clarification or research.',
            expected: { kind: 'exact', text: '4' },
            shouldActivate: false,
            phase: 'holdout',
          },
        ],
      });
      const deadline = Date.now() + 250000;
      while (evaluation.status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        evaluation = await call(`/skill-quality/evaluations/${evaluation.id}`);
      }
      evidence = {
        status: evaluation.status,
        cases: evaluation.results.map(
          ({
            variant,
            fixtureId,
            status,
            correct,
            activationPassed,
            modelCalls,
            unknownTokens,
            definitionHash,
            harnessHashes,
            modelHashes,
          }) => ({
            variant,
            fixtureId,
            status,
            correct,
            activationPassed,
            modelCalls,
            unknownTokens,
            definitionHash,
            harnessHashes,
            modelHashes,
          }),
        ),
      };
      console.log('[skill-live]', JSON.stringify(evidence));
      expect(evaluation.status).toBe('completed');
      expect(evaluation.results).toHaveLength(4);
      expect(
        evaluation.results.every(
          (row) => row.status === 'succeeded' && row.correct && row.unknownTokens === 0,
        ),
      ).toBe(true);
      expect(
        evaluation.results.find(
          (row) => row.variant === 'candidate' && row.fixtureId === 'korean-colour',
        )?.activationPassed,
      ).toBe(true);
      expect(
        evaluation.results.find(
          (row) => row.variant === 'candidate' && row.fixtureId === 'japanese-arithmetic',
        )?.activationPassed,
      ).toBe(true);
      const adoption = await call<SkillAdoption>('/skill-quality/adopt', {
        operationId: 'skill-live-adopt',
        evaluationId: evaluation.id,
        reviewed: true,
        target: {
          scope: 'personal',
          scopeId: 'default',
          expectedRevision: 1,
          binding: { profileId: 'live-fixture', revision: 1 },
        },
      });
      const rollback = await call<HarnessDefault>('/skill-quality/rollback', {
        operationId: 'skill-live-rollback',
        adoptionId: adoption.id,
        expectedRevision: adoption.defaultRevision,
      });
      expect(rollback.binding).toEqual({ profileId: 'live-fixture', revision: 1 });
      passed = true;
    } finally {
      await server?.close();
      rmSync(workspace, { recursive: true, force: true });
      mkdirSync(join(import.meta.dirname, 'test-results'), { recursive: true });
      writeFileSync(
        join(import.meta.dirname, 'test-results/skill-quality.json'),
        JSON.stringify(
          {
            candidate,
            sameCandidate: candidate === candidateHash(),
            passed,
            requests,
            evidence,
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    }
  },
  280000,
);
