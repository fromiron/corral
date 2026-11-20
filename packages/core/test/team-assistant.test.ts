import type { TeamAssistantRequest, TeamCatalog, TeamComposition } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { assistantReplyFromAnswer, readAssistantAnswer } from '../src/index.ts';

// The catalog a new team request carries: what the editor can pick by hand.
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
    {
      id: 'a2',
      name: 'Reviewer',
      changesFiles: false,
      runsCommands: false,
      output: 'review',
      skills: [],
    },
    {
      id: 'a3',
      name: 'Researcher',
      changesFiles: false,
      runsCommands: false,
      output: 'notes',
      skills: [],
    },
    {
      id: 'a4',
      name: 'Judge',
      changesFiles: false,
      runsCommands: false,
      output: 'draft',
      skills: [],
    },
  ],
  skills: [{ id: 's1', name: 'plain-language', description: 'Writes plainly.' }],
};
const create = (
  content: string,
  decisions?: TeamAssistantRequest['decisions'],
): TeamAssistantRequest => ({
  operationId: 'assistant',
  mode: 'create',
  messages: [{ role: 'user', content }],
  catalog,
  ...(decisions ? { decisions } : {}),
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
/** A composed plan: one writer, unless the changes say otherwise. */
const plan = (changes: Partial<TeamComposition> = {}) => ({
  kind: 'plan',
  reason: 'One author can write the guide.',
  plan: {
    name: 'Guide',
    brief: 'Write a guide.',
    criteria: ['Explain the steps.'],
    seats: [{ id: 's1', agent: 'a1', name: 'Writer', duty: 'Write the guide.' }],
    flow: [{ seat: 's1' }],
    ...changes,
  },
});
/** A writer judged by a reviewer in a loop. */
const judged = (changes: Partial<TeamComposition> = {}) =>
  plan({
    seats: [
      { id: 'w', agent: 'a1', name: 'Writer', duty: 'Write the guide.' },
      { id: 'r', agent: 'a2', name: 'Reviewer', duty: 'Check the guide.' },
    ],
    flow: [{ loop: { work: ['w'], judge: 'r' } }],
    ...changes,
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
  it('normalises a seat’s skills: catalog ids only, none the agent has, each once, at most four', () => {
    const skilled: TeamCatalog = {
      agents: [{ ...(catalog.agents[0] as TeamCatalog['agents'][number]), skills: ['own'] }],
      skills: ['own', 'one', 'two', 'three', 'four', 'five'].map((id) => ({
        id: id === 'own' ? 'own-2' : id,
        name: id,
        description: '',
      })),
    };
    const request: TeamAssistantRequest = {
      operationId: 'assistant',
      mode: 'create',
      messages: [{ role: 'user', content: 'Write the guide.' }],
      catalog: skilled,
    };
    const seat = { id: 'write', agent: 'a1', name: 'Writer', duty: 'Write the guide.' };
    const withSkills = (skills: string[]) =>
      plan({ seats: [{ ...seat, skills }], flow: [{ seat: 'write' }] });
    expect(
      read(withSkills(['ghost', 'one', 'own-2', 'one', 'two', 'three', 'four', 'five']), request),
    ).toEqual(withSkills(['one', 'two', 'three', 'four']));
    // Nothing left is no skills at all; a seat that named none is left as it is.
    expect(read(withSkills(['ghost', 'own-2']), request)).toEqual(
      plan({ seats: [seat], flow: [{ seat: 'write' }] }),
    );
    expect(read(plan({ seats: [seat], flow: [{ seat: 'write' }] }), request)).toEqual(
      plan({ seats: [seat], flow: [{ seat: 'write' }] }),
    );
  });

  it('names why an answer cannot be used, never with its text', () => {
    const request = create('Write the guide.');
    const problem = (text: string, on: TeamAssistantRequest = request) => {
      const result = readAssistantAnswer(text, on);
      return 'problem' in result ? result.problem : 'usable';
    };
    const json = (value: unknown) => JSON.stringify(value);
    expect(problem('not JSON at all')).toBe('not_json');
    expect(problem('{"kind": "plan",')).toBe('not_json');
    expect(problem(`${json(question)}\n${json(question)}`)).toBe('not_json');
    expect(problem(json([question]))).toBe('shape');
    expect(problem(json({ ...plan(), hidden: true }))).toBe('shape');
    expect(problem(json(plan({ flow: [] })))).toBe('shape');
    expect(problem(json(edits(gate)))).toBe('kind');
    expect(problem(json(plan()), edit)).toBe('kind');
    expect(problem(json({ kind: 'unsupported' }))).toBe('kind');
    expect(problem(json(plan({ seats: [{ id: 's1', agent: 'a99', name: 'W', duty: 'd' }] })))).toBe(
      'unknown_agent',
    );
    expect(
      problem(
        json(
          judged({
            seats: [
              { id: 'w', agent: 'a1', name: 'Writer', duty: 'Write the guide.' },
              { id: 'r', agent: 'a4', name: 'Judge', duty: 'Judge the guide.' },
            ],
          }),
        ),
      ),
    ).toBe('judge_without_review');
    expect(problem(json(judged()), create('Write it.', { reviewPolicy: 'opinion_only' }))).toBe(
      'loop_with_opinion_only',
    );
    expect(problem(json(question), create('Write it.', { material: 'person' }))).toBe(
      'decision_conflict',
    );
    expect(problem(json(plan()))).toBe('usable');
    expect(readAssistantAnswer(json(plan()), request)).toEqual({ reply: plan() });
  });

  it('accepts exactly one checked reply and respects the active mode', () => {
    const request = create('One author to write the guide.');
    expect(read(plan(), request)).toEqual(plan());
    expect(read(judged(), request)).toEqual(judged());
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
    const reply = read(plan({ outrider: 'required_review' }), create('Require review.', decisions));
    expect(reply).toMatchObject({ kind: 'plan', plan: { outrider: 'artifact_review' } });
    expect(reply?.kind === 'plan' && reply.reason).not.toBe(plan().reason);
    expect(read(plan(), create('Write it.', decisions))).toMatchObject({
      kind: 'plan',
      plan: { outrider: 'artifact_review' },
    });
    const changed = read(edits(gate), { ...edit, decisions });
    expect(changed).toMatchObject({ kind: 'edits', edits: [{ kind: 'add_shared_advice' }] });
    expect(changed?.kind === 'edits' && changed.reason).not.toBe(edits(gate).reason);
    // A judged loop is a pass condition: the person ruled it out.
    expect(read(judged(), create('Request a review.', decisions))).toBeNull();
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
    const proposed = plan({ outrider: 'artifact_review' });
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
    expect(read(plan({ outrider: 'clarify_review' } as never), request)).toBeNull();
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

  it('refuses a composition the catalog cannot seat', () => {
    const request = create('Write the guide.');
    const seat = { id: 's1', agent: 'a1', name: 'Writer', duty: 'Write the guide.' };
    expect(read(plan({ seats: [{ ...seat, agent: 'a99' }] }), request)).toBeNull();
    expect(read(plan({ seats: [{ ...seat, skills: ['s1'] }] }), request)).toMatchObject({
      kind: 'plan',
    });
    // An unknown skill never sinks the team: it is dropped.
    expect(read(plan({ seats: [{ ...seat, skills: ['s9'] }] }), request)).toEqual(
      plan({ seats: [seat] }),
    );
    // Only an agent with the review contract can judge.
    const judgedBy = (agent: string) =>
      judged({
        seats: [
          { id: 'w', agent: 'a1', name: 'Writer', duty: 'Write the guide.' },
          { id: 'r', agent, name: 'Judge', duty: 'Judge the guide.' },
        ],
      });
    expect(read(judgedBy('a4'), request)).toBeNull();
    expect(read(judgedBy('a2'), request)).toMatchObject({ kind: 'plan' });
    // No tool, observation or approval field reaches a plan.
    for (const extra of [
      { seats: [{ ...seat, tools: ['write_file'] }] },
      { observeWork: true },
      { finalApproval: true },
    ])
      expect(read(plan(extra as never), request)).toBeNull();
  });

  it('a required pass the person chose becomes the plan’s policy', () => {
    const reply = read(judged(), create('Get it checked.', { reviewPolicy: 'required' }));
    expect(reply).toMatchObject({ kind: 'plan', plan: { outrider: 'required_review' } });
    expect(reply?.kind === 'plan' && reply.reason).not.toBe(judged().reason);
    const already = plan({ outrider: 'required_review' });
    expect(read(already, create('Get it checked.', { reviewPolicy: 'required' }))).toEqual(already);
  });

  it('passes the material choice and observation to the model, not to a structural check', () => {
    const researched = plan({
      seats: [
        { id: 'r', agent: 'a3', name: 'Researcher', duty: 'Find sources.' },
        { id: 'w', agent: 'a1', name: 'Writer', duty: 'Write the guide.' },
      ],
      flow: [{ seat: 'r' }, { seat: 'w' }],
    });
    expect(read(researched, create('I provide the guide.', { material: 'person' }))).toEqual(
      researched,
    );
    expect(read(plan(), create('Research it.', { material: 'team' }))).toEqual(plan());
    expect(read(plan(), create('Watch work in progress.', { observeWork: true }))).toEqual(plan());
  });

  it.each([
    '작성자가 필요할 때만 전문가에게 자문한다. 검토 통과나 자동 관찰은 필요 없다.',
    'The writer consults an expert when needed. No review pass or automatic observation is needed.',
    'Get a review before publishing.',
  ])('does not read the goal’s words to change a new team’s composition: %s', (goal) => {
    const request = create(goal);
    for (const reply of [
      plan({ outrider: 'consultation' }),
      judged({ outrider: 'required_review' }),
      plan(),
    ])
      expect(read(reply, request)).toEqual(reply);
  });
});
