import { describe, expect, it } from 'vitest';
import {
  TeamAssistantReply,
  TeamAssistantRequest,
  TeamAssistantResponse,
  TeamAssistantTarget,
  TeamAssistantTeam,
  type TeamCatalog,
  type TeamComposition,
} from '../src/index.ts';

const target: TeamAssistantTarget = { outputId: 'final', index: 3 };
const result = { index: 3, name: 'Report', producerName: 'Writer' };
const role = { nodeId: 'writer', name: 'Writer' };
const output = { outputId: 'final', results: [result] };
const team: TeamAssistantTeam = {
  roles: [role],
  outputs: [output],
  brief: '',
  hasSharedOutrider: false,
};
const message = { role: 'user', content: 'Prepare a report.' } as const;
const catalog: TeamCatalog = {
  agents: [
    {
      id: 'a1',
      name: 'Writer',
      changesFiles: false,
      runsCommands: false,
      output: 'draft',
      skills: [],
    },
  ],
  skills: [],
};
const create: TeamAssistantRequest = {
  mode: 'create',
  operationId: '0-a',
  messages: [message],
  catalog,
};
const { catalog: _catalog, ...withoutCatalog } = create;
const edit: TeamAssistantRequest = { ...withoutCatalog, mode: 'edit', team };
const plan: TeamComposition = {
  name: 'Writing',
  brief: 'Prepare a report.',
  criteria: ['A report is ready.'],
  seats: [{ id: 's1', agent: 'a1', name: 'Writer', duty: 'Write the report.' }],
  flow: [{ seat: 's1' }],
};

describe('team assistant request', () => {
  it('a new team carries the catalog and may carry the proposal it revises; an edit carries neither', () => {
    expect(TeamAssistantRequest.safeParse(create).success).toBe(true);
    expect(TeamAssistantRequest.safeParse({ ...create, proposal: plan }).success).toBe(true);
    for (const invalid of [
      withoutCatalog,
      { ...create, catalog: { agents: [], skills: [] } },
      { ...create, catalog: { ...catalog, teams: [] } },
      { ...create, proposal: { ...plan, pattern: 'single' } },
      { ...create, proposal: { ...plan, flow: [{ parallel: ['s1', 's1'] }] } },
      { ...edit, catalog },
      { ...edit, proposal: plan },
    ])
      expect(TeamAssistantRequest.safeParse(invalid).success).toBe(false);
  });

  it('accepts edit decisions only for results at their original input index', () => {
    const decisions = {
      material: 'person',
      reviewPolicy: 'required',
      observeWork: false,
      reviewTarget: target,
    };
    expect(TeamAssistantTarget.safeParse(target).success).toBe(true);
    expect(TeamAssistantRequest.safeParse({ ...edit, decisions }).success).toBe(true);
    for (const invalid of [
      { ...edit, decisions: { reviewTarget: { ...target, index: 0 } } },
      { ...edit, decisions: { reviewTarget: { ...target, outputId: 'other' } } },
      {
        ...edit,
        team: {
          ...team,
          outputs: [
            { ...output, results: [] },
            { outputId: 'other', results: [result] },
          ],
        },
        decisions,
      },
      { ...create, decisions },
      { ...create, team },
      { ...edit, team: undefined },
      { ...edit, decisions: { ...decisions, reviewTarget: 'final:3' } },
      { ...edit, decisions: { ...decisions, reviewPolicy: 'person' } },
    ])
      expect(TeamAssistantRequest.safeParse(invalid).success).toBe(false);
  });

  it('bounds the conversation and requires an operation id', () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      ...(i === 1 ? { role: 'assistant', questionId: 'material' } : { role: 'user' }),
      content: 'a'.repeat(2000),
    }));
    expect(TeamAssistantRequest.safeParse({ ...create, messages }).success).toBe(true);
    for (const invalid of [
      { ...create, operationId: undefined },
      { ...create, operationId: '' },
      { ...create, messages: [] },
      { ...create, messages: [...messages, message] },
      { ...create, messages: [{ ...message, content: 'a'.repeat(2001) }] },
      { ...create, messages: [{ ...message, content: '' }] },
      { ...create, messages: [{ ...message, role: 'system' }] },
      { ...create, messages: ['text'] },
    ])
      expect(TeamAssistantRequest.safeParse(invalid).success).toBe(false);
    const turn = { role: 'assistant', content: 'Choose an option.' };
    for (const questionId of ['material', 'review_policy', 'review_target'])
      expect(
        TeamAssistantRequest.safeParse({ ...edit, messages: [{ ...turn, questionId }] }).success,
      ).toBe(true);
    for (const invalid of [
      turn,
      { ...turn, questionId: 'other' },
      { ...message, questionId: 'material' },
    ])
      expect(TeamAssistantRequest.safeParse({ ...edit, messages: [invalid] }).success).toBe(false);
  });

  it('does not impose plan limits on an existing team', () => {
    const longName = 'w'.repeat(500);
    const largeTeam = {
      ...team,
      brief: 'b'.repeat(5000),
      roles: Array.from({ length: 200 }, (_, i) => ({ nodeId: `writer${i}`, name: longName })),
      outputs: [{ ...output, results: [{ ...result, name: longName, producerName: longName }] }],
    };
    expect(TeamAssistantTeam.safeParse(largeTeam).success).toBe(true);
    expect(TeamAssistantRequest.safeParse({ ...edit, team: largeTeam }).success).toBe(true);
  });

  it('rejects unknown fields throughout the request rather than silently stripping them', () => {
    for (const invalid of [
      { ...edit, extra: true },
      { ...edit, messages: [{ ...message, file: 'file' }] },
      { ...edit, decisions: { extra: true } },
      { ...edit, decisions: { reviewTarget: { ...target, extra: true } } },
      { ...edit, team: { ...team, grants: [] } },
      { ...edit, team: { ...team, roles: [{ ...role, prompt: 'extra' }] } },
      { ...edit, team: { ...team, outputs: [{ ...output, extra: true }] } },
      {
        ...edit,
        team: { ...team, outputs: [{ ...output, results: [{ ...result, source: 'extra' }] }] },
      },
    ])
      expect(TeamAssistantRequest.safeParse(invalid).success).toBe(false);
  });
});

describe('team assistant reply', () => {
  it('accepts only both named choices for the selected policy, in either order', () => {
    for (const [id, first, second] of [
      ['material', 'person', 'team'],
      ['review_policy', 'opinion_only', 'required'],
    ] as const) {
      const question = { kind: 'question', id };
      for (const choices of [
        [first, second],
        [second, first],
      ]) {
        expect(TeamAssistantReply.safeParse({ ...question, choices }).success).toBe(true);
      }
      for (const choices of [
        [first],
        [first, first],
        [first, second, 'recommend'],
        [target, second],
      ]) {
        expect(TeamAssistantReply.safeParse({ ...question, choices }).success).toBe(false);
      }
    }
    expect(
      TeamAssistantReply.safeParse({
        kind: 'question',
        id: 'material',
        choices: ['required', 'opinion_only'],
      }).success,
    ).toBe(false);
  });

  it('requires two or three distinct structured review targets', () => {
    const question = { kind: 'question', id: 'review_target' };
    const other = { ...target, index: 4 };
    const third = { outputId: 'other', index: target.index };
    for (const choices of [
      [target, other],
      [target, other, third],
    ]) {
      expect(TeamAssistantReply.safeParse({ ...question, choices }).success).toBe(true);
    }
    for (const choices of [
      [target],
      [target, { ...target }],
      [target, other, third, { ...third, index: 5 }],
      ['final:3', 'final:4'],
      [target, { ...other, extra: true }],
      [target, { ...other, index: -1 }],
    ])
      expect(TeamAssistantReply.safeParse({ ...question, choices }).success).toBe(false);
  });

  it('accepts only structured plans, edits, descriptions and unsupported replies', () => {
    const reason = 'Use the requested flow.';
    const edits = [
      { kind: 'set_brief', brief: 'Updated goal.' },
      { kind: 'add_shared_advice' },
      { kind: 'require_review', ...target },
    ];
    for (const reply of [
      { kind: 'plan', plan, reason },
      { kind: 'edits', edits, reason },
      { kind: 'unsupported' },
      ...['submitter', 'members', 'review'].map((topic) => ({ kind: 'describe', topic })),
    ])
      expect(TeamAssistantReply.safeParse(reply).success).toBe(true);
    for (const reply of [
      { kind: 'plan', plan, reason, extra: true },
      { kind: 'plan', plan: { ...plan, grants: [] }, reason },
      {
        kind: 'plan',
        plan: { ...plan, seats: [{ ...plan.seats[0], tools: ['write_file'] }] },
        reason,
      },
      {
        kind: 'plan',
        plan: {
          name: 'Writing',
          pattern: 'single',
          brief: 'Prepare a report.',
          finalApproval: false,
          criteria: ['A report is ready.'],
          roles: [{ slot: 'worker', name: 'Writer', duty: 'Write the report.' }],
        },
        reason,
      },
      { kind: 'edits', edits: [], reason },
      { kind: 'edits', edits: ['add_shared_advice'], reason },
      { kind: 'edits', edits: [{ kind: 'require_review', target }], reason },
      { kind: 'edits', edits: [{ kind: 'add_shared_advice', observeWork: true }], reason },
      { kind: 'describe', topic: 'submitter', answer: 'Someone' },
      { kind: 'unsupported', reason },
      { kind: 'question', id: 'other', choices: ['team', 'person'] },
    ])
      expect(TeamAssistantReply.safeParse(reply).success).toBe(false);
  });

  it('retains the first sentence of a nonblank reason and caps a long sentence', () => {
    const base = { kind: 'plan', plan };
    for (const [reason, first] of [
      ['The author writes the guide. No reviewer is needed.', 'The author writes the guide.'],
      ['목표를 반영합니다. 다른 단계도 추가합니다.', '목표를 반영합니다.'],
      ['a'.repeat(401), 'a'.repeat(400)],
    ]) {
      expect(TeamAssistantReply.parse({ ...base, reason })).toEqual({ ...base, reason: first });
    }
    for (const reason of ['  ', ['No reviewer.']])
      expect(TeamAssistantReply.safeParse({ ...base, reason }).success).toBe(false);
  });

  it('requires a reply and a model display name in the response envelope', () => {
    const response: TeamAssistantResponse = {
      reply: { kind: 'unsupported' },
      model: 'Local Model',
    };
    expect(TeamAssistantResponse.safeParse(response).success).toBe(true);
    for (const invalid of [
      { ...response, model: { provider: 'local', modelId: 'model' } },
      { ...response, model: '' },
      { ...response, extra: true },
      { ...response, reply: 'unsupported' },
    ])
      expect(TeamAssistantResponse.safeParse(invalid).success).toBe(false);
  });
});
