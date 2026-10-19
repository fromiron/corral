import { ReviewArtifact } from '@corral/contracts';
import { expect, it } from 'vitest';
import { assertImagePayload, assertProtectedPayload } from '../src/request-record.ts';
import { promptSections, systemPrompt } from '../src/worker-tools.ts';

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

it('[TC-IMAGE-001-N] an image removed or replaced with base64 prose is not image delivery', () => {
  const images = [{ data: 'AQID', mime: 'image/png' as const }];
  expect(() =>
    assertImagePayload(
      {
        messages: [
          { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }] },
        ],
      },
      images,
    ),
  ).not.toThrow();
  expect(() =>
    assertImagePayload(
      { input: [{ content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }] }] },
      images,
    ),
  ).not.toThrow();
  expect(() =>
    assertImagePayload(
      {
        messages: [
          {
            content: [
              { type: 'image', source: { type: 'base64', data: 'AQID', media_type: 'image/png' } },
            ],
          },
        ],
      },
      images,
    ),
  ).not.toThrow();
  expect(() =>
    assertImagePayload({ messages: [{ content: 'data:image/png;base64,AQID' }] }, images),
  ).toThrow(/image/);
  expect(() => assertImagePayload({ messages: [] }, images)).toThrow(/image/);
});

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

it('[TC-PROMPT-001-H] [TC-PROMPT-001-N] preserves the output contract and refuses an oversized protected prompt instead of truncating it', () => {
  expect(systemPrompt(start)).toContain('artv_actual');
  expect(systemPrompt(start)).toContain('crit_actual');
  const sections = promptSections(start);
  expect(() =>
    assertProtectedPayload({ messages: [{ content: systemPrompt(start) }] }, sections),
  ).not.toThrow();
  expect(() => assertProtectedPayload({ messages: [{ content: 'removed' }] }, sections)).toThrow(
    /removed/,
  );
  expect(() =>
    systemPrompt({ ...start, role: { ...start.role, prompt: '큰'.repeat(100_000) } }),
  ).toThrow(/prompt.*limit/i);
});

it('[TC-PROMPT-001-H] identifies the configured model separately from the role, without credentials or endpoint details', () => {
  const input = {
    ...start,
    model: {
      provider: 'hive',
      modelId: 'deepseek-ai/deepseek-v4.1-flash-1017',
      baseUrl: 'https://private-endpoint.test',
      apiKey: 'fixture-private-key',
    },
  };
  const identity = promptSections(input).find((section) => section.name === 'corral_identity')!;
  expect(identity.version).toBe(2);
  expect(identity.text).toContain(
    JSON.stringify({ provider: input.model.provider, modelId: input.model.modelId }),
  );
  expect(identity.text).not.toContain('fixture-private-key');
  expect(identity.text).not.toContain('private-endpoint.test');
});
