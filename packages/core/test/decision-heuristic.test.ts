import type { EffortFeatures, EffortQuestion } from '@corral/contracts';
import { DecisionAnswer } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { LocalHeuristicProvider } from '../src/index.ts';

const features = (change: Partial<EffortFeatures> = {}): EffortFeatures => ({
  outputContract: 'draft',
  assignment: 'scheduled',
  round: null,
  lastReviewVerdict: null,
  inputArtifacts: 1,
  inputChars: 1_200,
  directives: 0,
  requestNo: 1,
  recentTools: [],
  ...change,
});

const question = (f: EffortFeatures, excerpt = 'Write the comparison.'): EffortQuestion => ({
  questionKind: 'reasoning_effort',
  questionVersion: 1,
  candidates: ['low', 'medium', 'high', 'xhigh'],
  subject: {
    runId: 'run_1',
    executionId: 'exec_1',
    attemptNo: 1,
    modelCallId: 'call_1',
    contextSnapshotId: 'ctx_1',
  },
  input: { features: f, excerpt },
});

const never = { aborted: false, onCancel: () => () => {} };
const judge = async (f: EffortFeatures, excerpt?: string) =>
  DecisionAnswer.parse(await new LocalHeuristicProvider().decide(question(f, excerpt), never));

describe('local-heuristic@1', () => {
  it('declares reasoning_effort v1, runs locally and answers by rule without probabilities', async () => {
    const provider = new LocalHeuristicProvider();
    expect(provider.questions).toEqual([{ kind: 'reasoning_effort', version: 1 }]);
    expect(provider.privacy).toBe('local');
    expect(provider.available()).toBe(true);
    const answer = await judge(features());
    expect(answer).toEqual({ answer: 'medium', probabilities: null, evidenceLevel: 'rule' });
  });

  it('short answers and helper parts are light; revisions and large inputs are heavy', async () => {
    expect((await judge(features({ assignment: 'question' }), 'Which source?')).answer).toBe('low');
    expect((await judge(features({ assignment: 'delegated' }), 'Find part 1.')).answer).toBe('low');
    expect((await judge(features({ round: 2, lastReviewVerdict: 'revise' }))).answer).toBe('high');
    expect((await judge(features({ inputChars: 12_000, inputArtifacts: 3 }))).answer).toBe('high');
    expect((await judge(features({ inputChars: 40_000, inputArtifacts: 5 }))).answer).toBe('xhigh');
  });

  it('the same features always give the same answer, and the answer is one of the candidates', async () => {
    for (const f of [
      features(),
      features({ directives: 3, requestNo: 6 }),
      features({ assignment: 'question', inputChars: 0, inputArtifacts: 0 }),
    ]) {
      const a = await judge(f);
      const b = await judge(f);
      expect(a).toEqual(b);
      expect(['low', 'medium', 'high', 'xhigh']).toContain(a.answer);
    }
  });
});
