// Calls the real decision APIs. Opt-in only: CORRAL_DECISION_API_LIVE=1 with CORRAL_JEV_KEY
// and/or CORRAL_OPENAI_DECISIONS_KEY. One paid request per API whose key is set, no retry.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionCancellation, EffortLevel, ModelAttempt } from '@corral/contracts';
import { effortQuestion } from '@corral/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DecisionApis, decisionApiConsent } from '../src/decision-apis.ts';
import { FileCredentialStore } from '../src/models/credential-store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const state = '## request\nRename the variable `cnt` to `count` in utils.ts';
const owner = { runId: 'run_1', executionId: 'exec_1', effectId: 'effect_1', attemptNo: 1 };
const never: DecisionCancellation = { aborted: false, onCancel: () => () => {} };
const candidates: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

const liveKeys = {
  jev: process.env.CORRAL_JEV_KEY,
  'openai-decisions': process.env.CORRAL_OPENAI_DECISIONS_KEY,
} as const;
describe.skipIf(process.env.CORRAL_DECISION_API_LIVE !== '1')('decision APIs (live)', () => {
  for (const [id, key] of Object.entries(liveKeys) as ['jev' | 'openai-decisions', string?][])
    it.skipIf(!key)(
      `${id} answers one effort question`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'corral-decision-apis-live-'));
        dirs.push(dir);
        const attempts = new Map<string, ModelAttempt>();
        const apis = await DecisionApis.open({
          credentials: new FileCredentialStore(dir),
          attempts: {
            put: (attempt) => void attempts.set(attempt.attemptId, structuredClone(attempt)),
            get: (attemptId) => attempts.get(attemptId) ?? null,
            list: () => [...attempts.values()],
          },
        });
        await apis.setKey(id, key ?? '');
        const admitted = apis
          .backend({
            kind: 'api',
            id,
            callerTimeoutMs: 10_000,
            consentRevision: decisionApiConsent(id),
          })
          ?.admit();
        if (!admitted?.ok) throw new Error(`no ${id} engine`);
        const question = effortQuestion(candidates);
        const inputUnits = await admitted.lease.countInput(state, question, never);
        expect(inputUnits).toBeLessThanOrEqual(8192);
        const answer = await admitted.lease.start({
          routeId: 'route_1',
          state,
          question,
          candidates,
          remainingMs: 10_000,
          inputUnits,
          signal: never,
          owner,
        }).result;
        expect(candidates).toContain(answer.choice);
        expect(attempts.get('judge_run_1_effect_1')).toMatchObject({
          status: 'completed',
          usage: { source: 'reported' },
        });
      },
      30_000,
    );
});
