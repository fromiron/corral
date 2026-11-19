import {
  TEAM_SLOTS,
  type TeamAssistantRequest,
  type TeamPattern,
  type TeamPlan,
} from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { assistantReplyFromAnswer } from '../src/index.ts';

const create = (
  content: string,
  decisions?: TeamAssistantRequest['decisions'],
): TeamAssistantRequest => ({
  operationId: 'assistant',
  mode: 'create',
  messages: [{ role: 'user', content }],
  decisions,
});
const target = { outputId: 'out', index: 3 };
const other = { outputId: 'out', index: 0 };
const edit: TeamAssistantRequest = {
  operationId: 'assistant',
  mode: 'edit',
  messages: [{ role: 'user', content: 'Require review.' }],
  team: {
    roles: [{ nodeId: 'author', name: 'Author' }],
    hasSharedOutrider: false,
    brief: '',
    outputs: [
      {
        outputId: 'out',
        results: [
          { index: other.index, name: 'Outline', producerName: 'Author' },
          { index: target.index, name: 'Draft', producerName: 'Author' },
        ],
      },
    ],
  },
};
const plan = (pattern: TeamPattern = 'single', changes?: Partial<TeamPlan>) => ({
  kind: 'plan',
  reason: 'One author can write the guide.',
  plan: {
    name: 'Guide',
    brief: 'Write a guide.',
    criteria: ['Explain the steps.'],
    pattern,
    roles: TEAM_SLOTS[pattern].map((slot) => ({ slot, name: slot, duty: 'Write the guide.' })),
    finalApproval: false,
    ...changes,
  },
});
const edits = (...items: unknown[]) => ({
  kind: 'edits',
  edits: items,
  reason: 'Require review before release.',
});
const gate = { kind: 'require_review', ...target };
const question = { kind: 'question', id: 'material', choices: ['person', 'team'] };
const read = (value: unknown, request: TeamAssistantRequest) =>
  assistantReplyFromAnswer(JSON.stringify(value), request);

describe('checked assistant proposals', () => {
  it('accepts exactly one checked reply and respects the active mode', () => {
    const request = create('One author to write the guide.');
    expect(read(plan(), request)).toEqual(plan());
    expect(read(plan(), edit)).toBeNull();
    expect(read(edits(gate), request)).toBeNull();
    expect(read({ kind: 'describe', topic: 'submitter' }, request)).toBeNull();
    expect(read({ kind: 'unsupported' }, request)).toBeNull();
    expect(read({ kind: 'unsupported' }, edit)).toEqual({ kind: 'unsupported' });
    expect(read({ kind: 'describe', topic: 'submitter' }, edit)).toEqual({
      kind: 'describe',
      topic: 'submitter',
    });
    expect(assistantReplyFromAnswer('not JSON', request)).toBeNull();
    expect(read([question, question], request)).toBeNull();
    expect(read({ ...plan(), hidden: true }, request)).toBeNull();
    expect(read({ ...plan(), plan: 'create a team' }, request)).toBeNull();
    expect(
      read(edits({ kind: 'set_brief', brief: 'New' }, { ...gate, extra: true }), edit),
    ).toBeNull();
  });

  it('ignores fences and surrounding prose around one object without extracting nested replies', () => {
    const request = create('Who supplies materials?');
    const json = JSON.stringify(question);
    for (const text of [`\`\`\`json\n${json}\n\`\`\``, `Here is my answer:\n${json}\nDone.`])
      expect(assistantReplyFromAnswer(text, request)).toEqual(question);
    for (const text of [
      JSON.stringify([question]),
      `\`\`\`json\n[${json}]\n\`\`\``,
      JSON.stringify(json),
      `${json}\n${json}`,
      `Answer: ${JSON.stringify({ ...question, extra: 'ignore' })}`,
    ])
      expect(assistantReplyFromAnswer(text, request)).toBeNull();
  });

  it.each([
    { outputId: 'missing', index: 0 },
    { outputId: 'out', index: 1 },
  ])(
    'rejects the whole answer on an invalid result target %o even with a valid decision',
    (invalid) => {
      const request = { ...edit, decisions: { reviewTarget: target } };
      expect(
        read(edits({ kind: 'set_brief', brief: 'New' }, { ...gate, ...invalid }), request),
      ).toBeNull();
      expect(
        read({ kind: 'question', id: 'review_target', choices: [other, invalid] }, edit),
      ).toBeNull();
    },
  );

  it('accepts one unanswered question at a time, never more than two per proposal', () => {
    const request = create('Make a local newsletter.');
    expect(read(question, request)).toEqual(question);
    expect(read(question, { ...request, decisions: { material: 'person' } })).toBeNull();
    const exchange = [
      { role: 'assistant' as const, questionId: 'review_policy' as const, content: 'Choose one.' },
      { role: 'user' as const, content: 'Just opinions.' },
    ];
    expect(read(question, { ...request, messages: [...request.messages, ...exchange] })).toEqual(
      question,
    );
    const twice = { ...request, messages: [...request.messages, ...exchange, ...exchange] };
    expect(read(question, twice)).toBeNull();
    expect(read(plan(), twice)).toEqual(plan());
  });

  it('never makes a required gate from an opinion-only decision in either mode', () => {
    const decisions = { reviewPolicy: 'opinion_only' } as const;
    const reply = read(
      plan('single', { outrider: 'required_review' }),
      create('Require review.', decisions),
    );
    expect(reply).toMatchObject({
      kind: 'plan',
      plan: { pattern: 'single', outrider: 'artifact_review' },
    });
    const changed = read(edits(gate), { ...edit, decisions });
    expect(changed).toMatchObject({ kind: 'edits', edits: [{ kind: 'add_shared_advice' }] });
    expect(changed?.kind === 'edits' && changed.reason).not.toBe(edits(gate).reason);
    expect(
      read(
        plan('write_review', { outrider: 'required_review' }),
        create('Request a review.', decisions),
      ),
    ).toBeNull();
    expect(
      read(edits({ kind: 'set_brief', brief: 'New goal' }), { ...edit, decisions }),
    ).toMatchObject({
      kind: 'edits',
      edits: [{ kind: 'set_brief', brief: 'New goal' }, { kind: 'add_shared_advice' }],
    });
  });

  it.each(['발행 전에 검토받게 해 줘.', 'Get a review before publishing.'])(
    'asks about policy, not a review target, when the request is ambiguous: %s',
    (content) => {
      expect(read(edits(gate), { ...edit, messages: [{ role: 'user', content }] })).toEqual({
        kind: 'question',
        id: 'review_policy',
        choices: ['opinion_only', 'required'],
      });
    },
  );

  it('lets a typed clarification resolve an ambiguous goal in either mode', () => {
    const messages: TeamAssistantRequest['messages'] = [
      { role: 'user', content: 'Get a review before publishing.' },
      { role: 'assistant', questionId: 'review_policy', content: 'Choose one.' },
      { role: 'user', content: 'I meant just a second opinion.' },
    ];
    const advice = edits({ kind: 'add_shared_advice' });
    expect(read(advice, { ...edit, messages })).toEqual(advice);
    const request = { ...create('Newsletter'), messages };
    const proposed = plan('single', { outrider: 'artifact_review' });
    expect(read(proposed, request)).toEqual(proposed);
    expect(read(proposed, { ...request, decisions: { reviewPolicy: 'required' } })).toMatchObject({
      kind: 'plan',
      plan: { outrider: 'required_review' },
    });
    const repeated = {
      kind: 'question',
      id: 'review_policy',
      choices: ['opinion_only', 'required'],
    };
    expect(read(repeated, { ...edit, messages })).toEqual({ kind: 'unsupported' });
    expect(read(repeated, request)).toBeNull();
    expect(read(plan('single', { outrider: 'clarify_review' }), request)).toBeNull();
  });

  it('does not repeat a target question after a typed result selection', () => {
    const request: TeamAssistantRequest = {
      ...edit,
      messages: [
        ...edit.messages,
        { role: 'assistant', questionId: 'review_target', content: 'Choose one.' },
        { role: 'user', content: 'Use the draft, not the outline.' },
      ],
    };
    expect(read(edits(gate), request)).toEqual(edits(gate));
    expect(
      read({ kind: 'question', id: 'review_target', choices: [other, target] }, request),
    ).toEqual({ kind: 'unsupported' });
    expect(read(edits(gate), { ...request, decisions: { reviewTarget: other } })).toMatchObject({
      kind: 'edits',
      edits: [{ kind: 'require_review', ...other }],
    });
    expect(
      read(
        { kind: 'question', id: 'review_target', choices: [other, { ...target, index: 12 }] },
        request,
      ),
    ).toBeNull();
  });

  it('resolves an explicitly picked target, otherwise asks before selecting one of several results', () => {
    expect(
      read(edits({ ...gate, ...other }), {
        ...edit,
        decisions: { reviewPolicy: 'required', reviewTarget: target },
      }),
    ).toMatchObject({ kind: 'edits', edits: [gate] });
    expect(read(edits(gate), edit)).toEqual({
      kind: 'question',
      id: 'review_target',
      choices: [other, target],
    });
    expect(
      read(edits(gate), {
        ...edit,
        messages: [
          ...edit.messages,
          { role: 'assistant', questionId: 'material', content: 'One?' },
          { role: 'assistant', questionId: 'review_policy', content: 'Two?' },
          { role: 'user', content: 'Choose.' },
        ],
      }),
    ).toBeNull();
  });

  it('keeps material choices and explicit observation settings above a conflicting model or keyword', () => {
    expect(
      read(plan('research_write_review'), create('Research the guide.', { material: 'person' })),
    ).toBeNull();
    expect(
      read(plan('write_review'), create('I provide the guide.', { material: 'team' })),
    ).toBeNull();
    const enabled = read(plan(), create('No automatic observation.', { observeWork: true }));
    expect(enabled).toMatchObject({ kind: 'plan', plan: { observeWork: true } });
    const disabled = read(
      plan('single', { observeWork: true, finalApproval: true }),
      create('Watch work in progress.', { observeWork: false }),
    );
    expect(disabled).toMatchObject({ kind: 'plan', plan: { finalApproval: false } });
    expect(disabled).not.toHaveProperty('plan.observeWork');
  });

  it.each([
    '작성자가 필요할 때만 전문가에게 자문한다. 검토 통과나 자동 관찰은 필요 없다.',
    'The writer consults an expert when needed. No review pass or automatic observation is needed.',
  ])('keeps optional consultation and no review step or observation for %s', (goal) => {
    const request = create(goal);
    const matching = plan('single', { outrider: 'consultation' });
    expect(read(matching, request)).toEqual(matching);
    const corrected = read(
      plan('write_review', { reviewRounds: 2, observeWork: true, outrider: 'required_review' }),
      request,
    );
    expect(corrected).toMatchObject({
      kind: 'plan',
      plan: {
        pattern: 'single',
        roles: [{ slot: 'worker', name: 'writer' }],
        outrider: 'consultation',
      },
    });
    expect(corrected).not.toHaveProperty('plan.reviewRounds');
    expect(corrected).not.toHaveProperty('plan.observeWork');
  });
});
