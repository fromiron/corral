import { ReviewArtifact } from '@corral/contracts';
import { expect, it } from 'vitest';
import { assertImagePayload, assertProtectedPayload } from '../src/request-record.ts';
import { parametersOf, promptSections, systemPrompt, userPrompt } from '../src/worker-tools.ts';

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

it('a marked meeting response is a conversation instead of a work report', () => {
  const input = {
    ...start,
    meeting: { sessionId: 'session_chat', roundId: 'message_1', participantId: 'participant_1' },
    role: { name: 'GPT', prompt: 'Give your own opinion.', outputContract: 'text' },
    tools: [...start.tools, 'update_plan'],
  };
  const prompt = systemPrompt(input);
  expect(prompt).toContain('Your display name in this shared conversation');
  expect(prompt).toContain('Respond to the latest posted messages');
  expect(prompt).toContain('Return your answer directly as the final response');
  expect(prompt).not.toContain('Complete the requested work');
  expect(prompt).not.toContain('Report what was observed, inferred, and not checked');
  expect(prompt).not.toContain('Perform the scheduled task');
  expect(prompt).not.toContain('call update_plan before');
  expect(prompt).not.toContain('When your work is complete, call write_artifact');
  expect(prompt).toContain('host permissions remain authoritative');
  expect(prompt).toContain('Honor cancellation');

  const ordinary = systemPrompt({ ...input, meeting: undefined });
  expect(ordinary).toContain('Complete the requested work');
  expect(ordinary).toContain('When your work is complete, call write_artifact');
  expect(ordinary).not.toContain('Your display name in this shared conversation');
});

it('a secretary keeps its explicit structured format without a work submission prompt', () => {
  const prompt = systemPrompt({
    ...start,
    meeting: { sessionId: 'session_chat', roundId: 'message_2', participantId: 'secretary' },
    role: {
      name: 'Secretary',
      prompt: 'Summarize the supplied conversation as JSON with summary and decisions.',
      outputContract: 'text',
    },
  });
  expect(prompt).toContain(
    'Summarize the supplied conversation as JSON with summary and decisions.',
  );
  expect(prompt).toContain('Follow any explicit output format in your role instructions');
  expect(prompt).not.toContain('When your work is complete, call write_artifact');
});

it('supplies the configured image profile and structured generator schema to the model', () => {
  const prompt = systemPrompt({
    ...start,
    role: { ...start.role, imageProfile: 'images_default' },
    tools: ['generate_image'],
  });
  expect(prompt).toContain('use profileId "images_default"');
  expect(systemPrompt(start)).not.toContain('use profileId');
  const schema = parametersOf('generate_image', start);
  expect(schema).toMatchObject({
    required: ['profileId', 'prompt'],
    properties: { size: { enum: ['1024x1024', '1536x1024', '1024x1536'] } },
    additionalProperties: false,
  });
});

it('requires plans for multistep work only when update_plan is available', () => {
  const unavailable = systemPrompt(start);
  expect(unavailable).not.toContain('call update_plan');
  const available = systemPrompt({ ...start, tools: [...start.tools, 'update_plan'] });
  expect(available).toContain('call update_plan before the first substantial step');
  expect(available).toContain('again when the current step changes');
  expect(available).toContain(
    'Do not create a plan for a greeting or a short single-step question',
  );
});

it('an image removed or replaced with base64 prose is not image delivery', () => {
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

it('tells reviewers what both evidenceRefs arrays can contain', () => {
  const prompt = systemPrompt(start);
  expect(prompt).toContain('For both evidenceRefs arrays');
  expect(prompt).toContain('evidence identifiers actually supplied in the inputs or tool results');
  expect(prompt).toContain('artifactVersionId, sourceId, or documentId');
  expect(prompt).toContain('^[A-Za-z][A-Za-z0-9_.:-]{0,119}$');
  expect(prompt).toContain('Do not invent IDs or use headings, quoted prose, or URLs');
  expect(prompt).toContain('use [] for brief or criteria without a supplied evidence identifier');
  expect(userPrompt(start)).toContain('"targetArtifactVersionId":"artv_actual"');
  expect(userPrompt(start)).toContain('"criteriaVersionId":"crit_actual"');
});

it('keeps prose and URLs invalid while allowing provided artifact and source IDs', () => {
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

it('preserves the output contract and refuses an oversized protected prompt instead of truncating it', () => {
  expect(userPrompt(start)).toContain('artv_actual');
  expect(userPrompt(start)).toContain('crit_actual');
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

it('current criteria and artifact revisions do not rewrite the stable system prefix', () => {
  const changed = {
    ...start,
    criteriaVersionId: 'crit_next',
    inputs: [{ ...start.inputs[0]!, artifactVersionId: 'artv_next' }],
    item: { batchId: 'batch_fixture', index: 2, total: 3 },
  };
  expect(systemPrompt(changed)).toBe(systemPrompt(start));
  expect(userPrompt(changed)).toContain('crit_next');
  expect(userPrompt(changed)).toContain('artv_next');
  expect(userPrompt(changed)).toContain('isolated item 2 of 3');
});

it('identifies the configured model separately from the role, without credentials or endpoint details', () => {
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

it('model instructions do not present legacy defaults or numeric sentinels as active budgets', async () => {
  const { DEFAULT_LIMITS } = await import('@corral/contracts');
  const brief = {
    version: 1 as const,
    inputHash: 'a'.repeat(64),
    criteriaVersionId: 'criteria',
    assignment: 'scheduled' as const,
    outputContract: 'text' as const,
    taskScope: 'work' as const,
    verificationScope: 'targeted' as const,
    canModifyFiles: false,
    limits: DEFAULT_LIMITS,
    usageLimits: 'none' as const,
    sourceRefs: [],
    resources: [],
  };
  const unlimited = userPrompt({ ...start, taskBrief: brief });
  expect(unlimited).not.toContain('maxModelCalls');
  expect(unlimited).not.toContain('64000');
  expect(unlimited).toContain('maxSpawns');
  const limited = userPrompt({
    ...start,
    taskBrief: {
      ...brief,
      usageLimits: undefined,
      limits: {
        ...DEFAULT_LIMITS,
        maxModelCalls: 20,
        maxOutputTokens: Number.MAX_SAFE_INTEGER,
        maxOutputTokensPerCall: Number.MAX_SAFE_INTEGER,
        modelTimeoutMs: Number.MAX_SAFE_INTEGER,
        runDeadlineMs: Number.MAX_SAFE_INTEGER,
      },
    },
  });
  expect(limited).toContain('"maxModelCalls":20');
  expect(limited).not.toContain(String(Number.MAX_SAFE_INTEGER));
});
