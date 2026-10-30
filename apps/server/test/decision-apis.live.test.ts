// Calls the real decision APIs. Opt-in only: CORRAL_DECISION_API_LIVE=1 with CORRAL_JEV_KEY
// and/or CORRAL_OPENAI_DECISIONS_KEY. One paid request per API whose key is set, no retry.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionCancellation, ModelAttempt, ReasoningInput } from '@corral/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { DecisionApis } from '../src/decision-apis.ts';
import { FileCredentialStore } from '../src/models/credential-store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const input: ReasoningInput = {
  kind: 'turn',
  request: 'Rename the variable `cnt` to `count` in utils.ts',
  prevRequest: '',
  prev: '',
  step: 0,
  plan: '',
  calls: [],
  directiveIds: [],
};
const owner = { runId: 'run_1', executionId: 'exec_1', effectId: 'effect_1', attemptNo: 1 };
const never: DecisionCancellation = { aborted: false, onCancel: () => () => {} };

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
        const model = apis.list().find((api) => api.id === id)?.model ?? '';
        const judge = apis.judges().find((j) => j.provider === id);
        if (!judge) throw new Error(`no ${id} judge`);
        const answer = await judge.judge(input, { model, owner }, never);
        expect(['low', 'medium', 'high', 'xhigh']).toContain(answer.answer);
        expect(attempts.get('judge_run_1_effect_1')).toMatchObject({
          status: 'completed',
          usage: { source: 'reported' },
        });
      },
      30_000,
    );
});
