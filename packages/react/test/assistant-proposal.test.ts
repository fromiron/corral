import {
  canonicalJson,
  type OutputNode,
  type TeamAssistantReply,
  TeamAssistantTeam,
  type TeamComposition,
} from '@corral/contracts';
import { compileDefinition, draftFromComposition, teamCatalog } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { createTranslator } from 'use-intl';
import { expect, it } from 'vitest';
import { draftFromDefinition, type EditorDraft, emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import {
  type AssistantText,
  createProposal,
  describe,
  editProposal,
  modeOf,
  summarize,
  targetLabel,
} from '../src/team-editor/assistant-proposal.ts';
import { patchNode, patchTeam, setRequiredOutputReview } from '../src/team-editor/commands.ts';
import { agent, choices, crew } from './team-composition-fixtures.ts';

function localizedText(locale: string, catalog: typeof ko): AssistantText {
  const { TeamAssistant, TeamEditor, Inspector, Validation } = catalog;
  return createTranslator({
    locale,
    messages: { ...TeamAssistant, TeamEditor, Inspector, Validation },
  }) as AssistantText;
}

const t: AssistantText = (key, values) => (values ? `${key} ${canonicalJson(values)}` : key);
const edit = { reason: 'Review the selected result.', origin: 'choice' as const, t };
const resolved = teamCatalog(choices.agents, choices.skills);
const create = {
  reason: edit.reason,
  t,
  wording: en.TeamDraft.wording,
  initialName: 'Untitled',
  resolved,
};
const labels = { ...en.TeamDraft.wording.labels, join: t('TeamEditor.kinds.join') };
const fresh = () => emptyDraft('transient_team', create.initialName);
const plan: TeamComposition = {
  name: 'Newsletter',
  brief: 'Write a newsletter.',
  criteria: ['Use our notes.'],
  seats: [{ id: 'w', agent: agent('writer'), name: 'Copywriter', duty: 'Write the newsletter.' }],
  flow: [{ seat: 'w' }],
};
const gate = { kind: 'require_review' as const, outputId: 'output', index: 2 };
type Edits = Extract<TeamAssistantReply, { kind: 'edits' }>['edits'];
function output(draft: EditorDraft): OutputNode {
  return draft.definition.nodes.find((n): n is OutputNode => n.type === 'output')!;
}
function handEdited(unfinishedOutput = false) {
  const definition = linearCorral(['planner', 'writer']);
  definition.roles[1]!.skills = [{ resourceHash: 'a'.repeat(64), entry: 'SKILL.md' }];
  definition.roles[1]!.prompt = 'Private instructions from the agent library.';
  const draft = draftFromDefinition(definition);
  return patchNode(
    patchNode(draft, 'writer', {
      label: 'Copy desk',
      stepInstruction: 'Do not publish our private directory /home/user/private.',
    }),
    'output',
    {
      inputBindings: [
        unfinishedOutput
          ? { kind: 'run_input', name: 'brief' }
          : { kind: 'task_output', name: 'Event list', sourceNodeId: 'planner' },
        { kind: 'task_output', name: 'Outline', sourceNodeId: 'planner' },
        { kind: 'task_output', name: 'Edition', sourceNodeId: 'writer' },
      ],
    },
  );
}

it('sends only seat labels, bound results with original ordinals, advice presence and the brief', () => {
  const draft = handEdited(true);
  const summary = summarize(draft);
  expect(summary).toEqual({
    roles: [
      { nodeId: 'planner', name: 'planner' },
      { nodeId: 'writer', name: 'Copy desk' },
    ],
    outputs: [
      {
        outputId: 'output',
        results: [
          { index: 1, name: 'Outline', producerName: 'planner' },
          { index: 2, name: 'Edition', producerName: 'Copy desk' },
        ],
      },
    ],
    hasSharedOutrider: false,
    brief: draft.definition.input.brief,
  });
  expect(TeamAssistantTeam.safeParse(summary).success).toBe(true);
  const facts = describe(draft, 'submitter', t);
  expect(facts).toContain(t('facts.submitted', { name: 'Outline', producer: 'planner' }));
  expect(facts).toContain(t('facts.submitted', { name: 'Edition', producer: 'Copy desk' }));
  const members = describe(draft, 'members', t);
  expect(members).toContain(
    t('facts.receives', { member: 'Copy desk', name: 'previous', source: 'planner' }),
  );
  expect(members).not.toMatch(/Private instructions|\/home\/user|SKILL.md/);
});

it.each([
  {
    locale: 'ko',
    messages: ko,
    producer: '편집팀',
    line: '최종 결과 ‘소식지’ 제출을 맡은 역할은 편집팀입니다.',
    none: '아직 최종 결과로 받는 결과가 없습니다.',
  },
  {
    locale: 'en',
    messages: en,
    producer: 'Copy desk',
    line: 'Copy desk submits “소식지” as the final result.',
    none: 'No result is selected as the final result yet.',
  },
])(
  'answers who submits in $locale for one output, several outputs, or no received result',
  ({ locale, messages, producer, line, none }) => {
    const text = localizedText(locale, messages);
    const draft = patchNode(patchNode(handEdited(), 'writer', { label: producer }), 'output', {
      inputBindings: [
        { kind: 'run_input', name: 'brief' },
        { kind: 'task_output', name: '소식지', sourceNodeId: 'writer' },
      ],
    });
    expect(describe(draft, 'submitter', text)).toBe(line);
    const empty = patchNode(draft, 'output', {
      inputBindings: [{ kind: 'run_input', name: 'brief' }],
    });
    expect(describe(empty, 'submitter', text)).toBe(none);
    const original = output(draft);
    const multiple = draftFromDefinition({
      ...draft.definition,
      nodes: [...draft.definition.nodes, { ...original, id: 'archive', label: 'Archive' }],
    });
    expect(describe(multiple, 'submitter', text)).toBe(`Output · ${line}\nArchive · ${line}`);
  },
);

it('names the localized reviewer that actually checks the required result', () => {
  const text = localizedText('ko', ko);
  const draft = patchNode(handEdited(), 'writer', { label: '작성팀' });
  const proposal = editProposal(draft, [gate], { ...edit, t: text });
  const required = output(proposal.result).requiredReviews?.[0];
  expect(
    proposal.result.definition.nodes.find((n) => n.id === required?.reviewerNodeId)?.label,
  ).toBe('제출 전 검토자');
  expect(proposal.changes).toContain(
    'Output · Edition: 검토는 제출 전 검토자 역할이 맡습니다. 작성팀 역할은 수정 요청을 받아 고치고, 검토를 통과한 결과를 제출합니다.',
  );
});

it('builds a create preview with the real draft compiler, retaining the editor identity and a hand-chosen name', () => {
  const base = fresh();
  const renamed = patchTeam(base, { name: 'Our office bulletin' });
  const automatic = createProposal(base, plan, create);
  expect(modeOf(base)).toBe('create');
  expect(modeOf(automatic.result)).toBe('edit');
  expect(automatic.result.definition).toEqual(
    draftFromComposition(plan, base.definition.id, resolved, labels),
  );
  const custom = createProposal(renamed, plan, create);
  expect(custom.base).toBe(renamed);
  expect(custom.result.definition).toEqual({
    ...automatic.result.definition,
    name: 'Our office bulletin',
  });
  expect(custom.focus).toBe('seat_1');
  expect(custom.canApply).toBe(true);
  expect(custom.origin).toBe('model');
  expect(custom.plan).toBe(plan);
  expect(() => createProposal(handEdited(), plan, create)).toThrow();
});

it('assembles side-by-side seats and a judged loop that compile, each seat with its agent’s tools', () => {
  const preview = createProposal(fresh(), crew, create);
  const { definition } = preview.result;
  expect(compileDefinition(definition).diagnostics).toEqual([]);
  expect(definition.nodes.map((node) => node.type)).toEqual(
    expect.arrayContaining(['join', 'loop', 'decision', 'output']),
  );
  for (const seat of crew.seats) {
    const role = definition.roles.find((r) => r.name === seat.name);
    const source = resolved.agentById.get(seat.agent);
    expect(role?.allowedWorkTools).toEqual(source?.role.allowedWorkTools);
  }
  expect(summarize(preview.result).outputs[0]?.results).toEqual([
    { index: 0, name: 'draft', producerName: 'Summary' },
  ]);
});

it('makes no proposal from a composition the sent catalog cannot resolve', () => {
  const stranger = { ...plan, seats: [{ ...plan.seats[0]!, agent: 'a99' }] };
  expect(() => createProposal(fresh(), stranger, create)).toThrow(t('logic.unusable'));
  const unknownSkill = { ...plan, seats: [{ ...plan.seats[0]!, skills: ['s9'] }] };
  expect(() => createProposal(fresh(), unknownSkill, create)).toThrow(t('logic.unusable'));
});

it('requires an exact confirmation before creating a mandatory gate, and observes only when asked', () => {
  const base = fresh();
  const required: TeamComposition = { ...plan, outrider: 'required_review' };
  const preview = createProposal(base, required, create);
  expect(preview.canApply).toBe(false);
  expect(output(preview.result).requiredReviews).toBeUndefined();
  expect(preview.result.definition.sharedOutrider?.observation).toBeUndefined();
  expect(preview.targets).toEqual([
    { outputId: 'output', index: 0, name: 'draft', producerName: 'Copywriter' },
  ]);
  const target = { outputId: 'output', index: 0 };
  const text = localizedText('ko', ko);
  const confirmed = createProposal(base, required, {
    ...create,
    target,
    observe: true,
    t: text,
  });
  const gateLabels = { loop: '제출 전 검토', reviewer: '제출 전 검토자', decision: '제출 전 판정' };
  expect(confirmed.result.definition.nodes.map((node) => node.label)).toEqual(
    expect.arrayContaining(Object.values(gateLabels)),
  );
  expect(confirmed.result.definition.roles.at(-1)?.name).toBe(gateLabels.reviewer);
  expect(confirmed.canApply).toBe(true);
  expect(confirmed.result.definition.sharedOutrider?.observation).toEqual({
    targets: { kind: 'all' },
    review: { interval: 3, maxRequestsPerReview: 8 },
  });
  const observed = createProposal(base, required, { ...create, observe: true });
  const command = setRequiredOutputReview(
    observed.result,
    'output',
    'draft',
    'seat_1',
    gateLabels,
    0,
  );
  if (!command.ok) throw new Error(command.reason);
  expect(confirmed.result).toEqual(command.draft);
  expect(output(confirmed.result).requireApproval).toBe(false);
  expect(() =>
    createProposal(base, required, { ...create, target: { ...target, index: 1 } }),
  ).toThrow();
});

it('changes only the shared advice setting; a single undo keeps all hand edits', () => {
  const base = handEdited();
  const p = editProposal(base, [{ kind: 'add_shared_advice' }], edit);
  expect(p.base).toBe(base);
  expect(p.focus).toBe('@advice');
  expect(p.changes).toEqual([t('diff.advice')]);
  const { sharedOutrider, ...rest } = p.result.definition;
  expect(sharedOutrider).toEqual({
    modelProfile: 'model-a',
    principles: t('TeamEditor.sharedOutrider.defaultPrinciples'),
    targets: { kind: 'all' },
  });
  expect(rest).toEqual(base.definition);
  const store = createEditorStore(base);
  store.getState().applyDraft(p.result);
  expect(store.getState().past).toEqual([base]);
  store.getState().undo();
  expect(store.getState().draft).toBe(base);
  const duplicate = editProposal(p.result, [{ kind: 'add_shared_advice' }], edit);
  expect(duplicate.result).toBe(p.result);
  expect(duplicate.changes).toEqual([]);
  expect(duplicate.canApply).toBe(false);
});

it('previews only net changes, including the precise producer, reviewer, return path and submitter', () => {
  const base = handEdited();
  const p = editProposal(
    base,
    [
      { kind: 'set_brief', brief: 'Intermediate' },
      { kind: 'set_brief', brief: 'New request' },
      gate,
      { kind: 'add_shared_advice' },
      gate,
    ],
    edit,
  );
  const out = output(p.result);
  const required = out.requiredReviews![0]!;
  const reviewer = p.result.definition.nodes.find((n) => n.id === required.reviewerNodeId)!;
  expect(required).toMatchObject({ bindingName: 'Edition', sourceNodeId: 'writer' });
  expect(out.inputBindings.slice(0, 2)).toEqual(output(base).inputBindings.slice(0, 2));
  expect(p.result.definition.roles.find((r) => r.id === 'writer_role')).toEqual(
    base.definition.roles[1],
  );
  expect(p.result.definition.nodes.find((n) => n.id === 'writer')).toMatchObject({
    stepInstruction: 'Do not publish our private directory /home/user/private.',
  });
  expect(p.briefChange).toEqual({ before: base.definition.input.brief, after: 'New request' });
  expect(p.changes).toEqual(
    expect.arrayContaining([
      t('diff.advice'),
      t('facts.review', {
        output: 'Output',
        name: 'Edition',
        producer: 'Copy desk',
        reviewer: reviewer.label,
      }),
    ]),
  );
  expect(p.changes).toHaveLength(2);
  expect(compileDefinition(p.result.definition).ok).toBe(true);
  const reverted = editProposal(
    base,
    [
      { kind: 'set_brief', brief: 'Intermediate' },
      { kind: 'set_brief', brief: base.definition.input.brief },
    ],
    edit,
  );
  expect(reverted.result).toBe(base);
  expect(reverted.changes).toEqual([]);
  expect(reverted.briefChange).toBeUndefined();
});

it('uses existing Outrider settings, reuses a legacy gate and describes its actual renamed reviewer', () => {
  const base = handEdited();
  base.definition.sharedOutrider = {
    modelProfile: 'custom',
    principles: 'Preserve these instructions.',
    targets: { kind: 'selected', nodeIds: ['writer'] },
    artifactReview: true,
  };
  const p = editProposal(base, [gate], edit);
  expect(p.focus).toBe('output');
  expect(p.changes).toHaveLength(1);
  const out = output(p.result);
  const id = out.requiredReviews![0]!.reviewerNodeId;
  const legacy = patchNode(patchNode(p.result, id, { label: 'Legal desk' }), out.id, {
    inputBindings: out.inputBindings.map(({ bindingId: _id, ...binding }) => binding),
    requiredReviews: out.requiredReviews!.map(({ bindingId: _id, ...review }) => review),
  });
  expect(editProposal(legacy, [{ kind: 'add_shared_advice' }, gate], edit).result).toBe(legacy);
  const review = describe(legacy, 'review', t);
  expect(review).toContain(
    t('facts.review', {
      output: 'Output',
      name: 'Edition',
      producer: 'Copy desk',
      reviewer: 'Legal desk',
    }),
  );
  expect(review).toContain(t('facts.adviceSelected', { targets: 'Copy desk' }));
  expect(review).toContain(t('facts.artifactAdvice'));
  expect(review).not.toContain('Preserve these instructions.');
});

it('rejects the whole batch for a missing target, illegal field, wrong binding kind or broken definition', () => {
  const base = handEdited();
  for (const invalid of [
    { ...gate, outputId: 'invented' },
    { ...gate, index: 3 },
    { ...gate, permissions: ['run_command'] },
    { kind: 'save' },
  ]) {
    expect(() =>
      editProposal(base, [{ kind: 'add_shared_advice' }, invalid] as Edits, edit),
    ).toThrow();
    expect(base.definition.sharedOutrider).toBeUndefined();
  }
  expect(() => editProposal(handEdited(true), [{ ...gate, index: 0 }], edit)).toThrow(
    t('TeamEditor.rejected.invalidResultInput'),
  );
  expect(() =>
    editProposal(
      patchNode(base, 'writer', { roleId: 'missing_role' }),
      [{ kind: 'set_brief', brief: 'Updated' }],
      edit,
    ),
  ).toThrow(/Validation\.codes/);
  expect(() =>
    createProposal(fresh(), { ...plan, tools: ['run_command'] } as TeamComposition, create),
  ).toThrow(t('invalid.proposal'));
});

it('checks team references in the same compilation context as the open editor', () => {
  const parent = linearCorral(['planner', 'writer']);
  const child = linearCorral(['child_writer'], 'child');
  parent.nodes[1] = {
    id: 'writer',
    type: 'team',
    label: 'Editorial team',
    inputBindings: [{ name: 'brief', kind: 'run_input' }],
    source: { kind: 'reference', corralId: 'child', definitionRevision: 3 },
  };
  parent.controlEdges[0]!.targetPort = 'enter';
  parent.controlEdges[1]!.sourcePort = 'next';
  const base = draftFromDefinition(parent);
  const edits: Edits = [{ kind: 'set_brief', brief: 'Prepare an issue.' }];
  expect(() => editProposal(base, edits, edit)).toThrow(/TEAM_REF_NOT_FOUND/);
  const proposal = editProposal(base, edits, {
    ...edit,
    compileOptions: {
      resolveTeam: (id, revision) => (id === 'child' && revision === 3 ? child : undefined),
    },
  });
  expect(proposal.canApply).toBe(true);
  expect(proposal.focus).toBe('@request');
  expect(summarize(proposal.result).outputs[0]?.results[0]?.producerName).toBe('Editorial team');
});

it('distinguishes identical result rows and does not describe a bypassed review as passing', () => {
  const base = handEdited();
  const copy = patchNode(base, 'output', {
    inputBindings: [
      { kind: 'task_output', name: 'Edition', sourceNodeId: 'writer' },
      { kind: 'task_output', name: 'Edition', sourceNodeId: 'writer' },
    ],
  });
  const p = editProposal(copy, [{ ...gate, index: 1 }], edit);
  const out = output(p.result);
  expect(out.inputBindings[0]?.bindingId).toBeUndefined();
  expect(out.inputBindings[1]?.bindingId).toBe(out.requiredReviews![0]!.bindingId);
  expect(p.changes.join(' ')).toContain('Edition (#2)');
  const bypassed = draftFromDefinition(p.result.definition);
  bypassed.definition.controlEdges.push({
    id: 'skip_review',
    source: 'planner',
    sourcePort: 'error',
    target: 'output',
    targetPort: 'in',
  });
  expect(describe(bypassed, 'review', t)).toContain('facts.brokenReview');
  expect(() => editProposal(bypassed, [{ ...gate, index: 1 }], edit)).toThrow();
});

it('stays in creation mode without a work agent but never replaces unfinished structures', () => {
  const base = fresh();
  base.definition.nodes.push({
    id: 'result',
    label: 'Pinned result',
    type: 'output',
    inputBindings: [],
    requireApproval: false,
  });
  expect(modeOf(base)).toBe('create');
  expect(() => createProposal(base, plan, create)).toThrow(t('invalid.occupied'));
  base.definition.nodes = [
    {
      id: 'observer',
      label: 'Outrider',
      type: 'agent',
      roleId: 'advisor',
      invocation: 'observer',
      outputName: 'advice',
    },
  ];
  expect(modeOf(base)).toBe('create');
  expect(() => createProposal(base, plan, create)).toThrow(t('invalid.occupied'));
});

it('distinguishes a review role and human approval from an output that requires a passing review', () => {
  const base = handEdited();
  base.definition.roles[0]!.outputContract = 'review';
  output(base).requireApproval = true;
  const facts = describe(base, 'review', t);
  expect(facts).toContain(t('facts.reviewer', { member: 'planner' }));
  expect(facts).toContain(t('facts.finalApproval', { output: 'Output' }));
  expect(facts).toContain(t('facts.noGate'));
});

it('binds generated seats and the mandatory Outrider reviewer to installed profiles', () => {
  const profiles = ['deepseek-hive', 'local-review'];
  const required: TeamComposition = { ...plan, outrider: 'required_review' };
  const confirmed = createProposal(fresh(), required, {
    ...create,
    observe: true,
    target: { outputId: 'output', index: 0 },
    compileOptions: { knownModelProfiles: profiles },
  });
  expect(confirmed.canApply).toBe(true);
  expect(confirmed.result.definition.roles.map((r) => r.modelProfile)).toEqual([
    'deepseek-hive',
    'deepseek-hive',
  ]);
  expect(confirmed.result.definition.sharedOutrider?.modelProfile).toBe('deepseek-hive');
});

it('keeps an installed model slot of a composed seat and never remaps profiles from a hand-edited team', () => {
  const options = { knownModelProfiles: ['deepseek-hive', 'model-b'] };
  const compiled = createProposal(fresh(), crew, { ...create, compileOptions: options });
  const assembled = draftFromComposition(crew, 'x', resolved, labels).roles;
  expect(assembled.map((r) => r.modelProfile)).toContain('model-b');
  expect(compiled.result.definition.roles.map((r) => r.modelProfile)).toEqual(
    assembled.map((r) => (r.modelProfile === 'model-b' ? 'model-b' : 'deepseek-hive')),
  );
  const existing = handEdited();
  expect(() =>
    editProposal(existing, [{ kind: 'set_brief', brief: 'Publish next week.' }], {
      ...edit,
      compileOptions: options,
    }),
  ).toThrow(/UNKNOWN_MODEL_PROFILE/);
  expect(existing.definition.roles.every((r) => r.modelProfile === 'model-a')).toBe(true);
});

it('uses identical localized target text for typed answers, choices and confirmation', () => {
  const draft = handEdited(true);
  const out = output(draft);
  draft.definition.nodes.push({ ...out, id: 'other_output' });
  const target = { outputId: out.id, index: 2, name: 'Edition', producerName: 'Copy desk' };
  expect(targetLabel(draft, target, t)).toBe(
    [
      'Output (output)',
      t('Inspector.requiredReviewPosition', { position: 3 }),
      t('Inspector.requiredReviewSource', { binding: 'Edition', source: 'Copy desk' }),
    ].join(' · '),
  );
});
