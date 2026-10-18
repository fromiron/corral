import { ReviewArtifact } from '@corral/contracts';
import { expect, it } from 'vitest';
import { systemPrompt } from '../src/worker-tools.ts';

const start = {
  type: 'start',
  executionId: 'exec_review',
  model: { provider: 'openai', modelId: 'fixture' },
  role: { name: 'Reviewer', prompt: 'Review the draft.', outputContract: 'review' },
  inputs: [
    { name: 'draft', artifactVersionId: 'artv_actual', text: 'Draft.' },
    { name: 'brief', artifactVersionId: null, text: 'Write a short answer.' },
    { name: 'criteria', artifactVersionId: null, text: 'c1: Meet the request.' },
  ],
  criteriaVersionId: 'crit_actual',
  round: 1,
  tools: ['write_artifact', 'submit_result'],
  assignment: { kind: 'scheduled' },
  delegateTo: [],
  askTo: [],
} satisfies Parameters<typeof systemPrompt>[0];

it('[TC-ART-003-N] tells reviewers what both evidenceRefs arrays can contain', () => {
  const prompt = systemPrompt(start);
  expect(prompt).toContain('For both evidenceRefs arrays');
  expect(prompt).toContain('evidence identifiers actually supplied in the inputs or tool results');
  expect(prompt).toContain('artifactVersionId, sourceId, or documentId');
  expect(prompt).toContain('^[A-Za-z][A-Za-z0-9_.:-]{0,119}$');
  expect(prompt).toContain('Do not invent IDs or use headings, quoted prose, or URLs');
  expect(prompt).toContain('use [] for brief or criteria without a supplied evidence identifier');
  expect(prompt).toContain('"targetArtifactVersionId": "artv_actual"');
  expect(prompt).toContain('"criteriaVersionId": "crit_actual"');
});

it('[TC-ART-003-N] keeps prose and URLs invalid while allowing provided artifact and source IDs', () => {
  const review = {
    targetArtifactVersionId: 'artv_actual',
    criteriaVersionId: 'crit_actual',
    verdict: 'pass',
    issues: [],
    evidenceRefs: ['artv_actual', 'source_actual', 'document_actual'],
  };
  expect(ReviewArtifact.safeParse(review).success).toBe(true);
  for (const reference of ['brief: Write a short answer.', 'https://example.test/source'])
    expect(ReviewArtifact.safeParse({ ...review, evidenceRefs: [reference] }).success).toBe(false);
});
