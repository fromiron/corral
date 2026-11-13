import {
  type AgentRole,
  type CorralDefinition,
  type CorralNode,
  isWorkAgent,
} from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import en from '../../react/src/messages/en.json' with { type: 'json' };
import ko from '../../react/src/messages/ko.json' with { type: 'json' };
import { expandReferences } from '../src/expand-teams.ts';
import {
  advisorPlans,
  compileDefinition,
  type Diagnostic,
  importMarkdownAgent,
  inputPortsOf,
  outputPortsOf,
  parseMarkdownAgent,
  planRun,
} from '../src/index.ts';

// Advisor compile rules (docs/specs/features/team-graph.md, "구조 규칙" 10 and 11). Until
// advisors run, a definition that keeps every rule is still refused by ADVISOR_NOT_SUPPORTED.

const advisorRole = (change: Partial<AgentRole> = {}): AgentRole => ({
  id: 'advisor_role',
  name: 'Advisor',
  prompt: 'Watch the writer and advise only when it matters.',
  modelProfile: 'model-a',
  allowedWorkTools: ['search', 'read_document', 'list_files', 'read_file'],
  allowedCollaborationTools: ['read_artifact', 'advise'],
  outputContract: 'notes',
  ...change,
});

const advisorNode = (id = 'advisor', change: Record<string, unknown> = {}) =>
  ({
    id,
    type: 'agent',
    label: id,
    roleId: 'advisor_role',
    invocation: 'observer',
    outputName: 'notes',
    ...change,
  }) as CorralNode;

/** writer → editor → Output, with an advisor watching the writer. */
function watched(): CorralDefinition {
  const definition = linearCorral(['writer', 'editor']);
  definition.roles.push(advisorRole());
  definition.nodes.push(advisorNode());
  definition.capabilityLinks.push({
    id: 'watch',
    kind: 'advise',
    sourceNodeId: 'advisor',
    targetNodeId: 'writer',
  });
  return definition;
}

/** watched(), plus a callable helper the writer delegates to. */
function withCalledHelper(): CorralDefinition {
  const definition = watched();
  definition.roles = definition.roles.map((r) =>
    r.id === 'writer_role'
      ? { ...r, allowedCollaborationTools: [...r.allowedCollaborationTools, 'spawn_subagents'] }
      : r,
  );
  definition.nodes.push({
    id: 'helper',
    type: 'agent',
    label: 'helper',
    roleId: 'editor_role',
    invocation: 'callable',
    inputBindings: [],
    outputName: 'help',
  });
  definition.capabilityLinks.push({
    id: 'call',
    kind: 'delegate',
    sourceNodeId: 'writer',
    targetNodeId: 'helper',
  });
  return definition;
}

const diagnosticsOf = (definition: unknown) => {
  const result = compileDefinition(definition);
  if (result.ok) throw new Error('expected the definition to be refused');
  return result.diagnostics;
};
const codes = (diagnostics: Diagnostic[]) => diagnostics.map((d) => d.code);
const expectOne = (definition: unknown, expected: Partial<Diagnostic>) =>
  expect(diagnosticsOf(definition)).toContainEqual(expect.objectContaining(expected));

describe('an advisor that keeps every rule', () => {
  it('is refused only because advisors cannot run yet', () => {
    expect(diagnosticsOf(watched())).toEqual([
      expect.objectContaining({
        code: 'ADVISOR_NOT_SUPPORTED',
        severity: 'error',
        nodeId: 'advisor',
      }),
    ]);
  });

  it('a definition without advisors still compiles, with no advisors in its plan', () => {
    const result = compileDefinition(linearCorral(['writer']));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.plan.advisors).toEqual({});
  });

  it('is planned outside the run order with its role, review settings and watched agents', () => {
    const definition = watched();
    definition.nodes.push(
      { ...advisorNode('second'), review: { interval: 5, maxRequestsPerReview: 2 } } as CorralNode,
      {
        id: 'helper',
        type: 'agent',
        label: 'helper',
        roleId: 'writer_role',
        invocation: 'callable',
        inputBindings: [],
        outputName: 'help',
      },
    );
    definition.capabilityLinks.push(
      { id: 'watch_2', kind: 'advise', sourceNodeId: 'second', targetNodeId: 'editor' },
      { id: 'watch_3', kind: 'advise', sourceNodeId: 'second', targetNodeId: 'helper' },
      { id: 'watch_4', kind: 'advise', sourceNodeId: 'second', targetNodeId: 'editor' },
    );
    expect(advisorPlans(definition)).toEqual({
      advisor: {
        nodeId: 'advisor',
        roleId: 'advisor_role',
        review: { interval: 3, maxRequestsPerReview: 8 },
        watches: ['writer'],
      },
      second: {
        nodeId: 'second',
        roleId: 'advisor_role',
        review: { interval: 5, maxRequestsPerReview: 2 },
        watches: ['editor', 'helper'],
      },
    });
  });

  it('has no ports: it is neither a step nor a call target', () => {
    const node = advisorNode();
    expect(outputPortsOf(node)).toEqual([]);
    expect(inputPortsOf(node)).toEqual([]);
  });
});

describe('rule 11: an advisor stays outside the flow', () => {
  it('refuses a control edge into an advisor', () => {
    const definition = watched();
    definition.controlEdges.push({
      id: 'into_advisor',
      source: 'writer',
      sourcePort: 'error',
      target: 'advisor',
      targetPort: 'in',
    });
    const diagnostics = diagnosticsOf(definition);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'ADVISOR_OUTSIDE_FLOW', edgeId: 'into_advisor' }),
    );
    expect(codes(diagnostics)).not.toContain('INVALID_PORT');
  });

  it('refuses a control edge out of an advisor', () => {
    const definition = watched();
    definition.controlEdges.push({
      id: 'from_advisor',
      source: 'advisor',
      sourcePort: 'out',
      target: 'editor',
      targetPort: 'in',
    });
    expectOne(definition, { code: 'ADVISOR_OUTSIDE_FLOW', edgeId: 'from_advisor' });
  });

  it('refuses an advisor inside a box', () => {
    const definition = watched();
    definition.nodes.push({ id: 'box', type: 'team', label: 'box', source: { kind: 'inline' } });
    definition.nodes = definition.nodes.map((n) =>
      n.id === 'advisor' ? ({ ...n, parentId: 'box' } as CorralNode) : n,
    );
    expectOne(definition, { code: 'ADVISOR_OUTSIDE_FLOW', nodeId: 'advisor' });
  });

  it.each([
    ['from', 'advisor', 'helper'],
    ['to', 'writer', 'advisor'],
  ])('refuses a delegate link %s an advisor', (_way, source, target) => {
    const definition = watched();
    definition.nodes.push({
      id: 'helper',
      type: 'agent',
      label: 'helper',
      roleId: 'editor_role',
      invocation: 'callable',
      inputBindings: [],
      outputName: 'help',
    });
    definition.capabilityLinks.push({
      id: 'call',
      kind: 'delegate',
      sourceNodeId: source,
      targetNodeId: target,
    });
    const diagnostics = diagnosticsOf(definition);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'ADVISOR_OUTSIDE_FLOW', linkId: 'call' }),
    );
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: 'CAPABILITY_TARGET' }));
  });

  it.each([
    ['to', 'writer', 'advisor'],
    ['from', 'advisor', 'helper'],
  ])('refuses a question link %s an advisor', (_way, source, target) => {
    const definition = withCalledHelper();
    definition.capabilityLinks.push({
      id: 'ask',
      kind: 'question',
      sourceNodeId: source,
      targetNodeId: target,
    });
    expectOne(definition, { code: 'ADVISOR_OUTSIDE_FLOW', linkId: 'ask' });
  });
});

describe('rule 11: advise links', () => {
  it('refuses an advisor that watches no one, once: it is outside the reach check', () => {
    const definition = watched();
    definition.capabilityLinks = [];
    expect(diagnosticsOf(definition)).toEqual([
      expect.objectContaining({ code: 'ADVISOR_NOT_SUPPORTED', nodeId: 'advisor' }),
      expect.objectContaining({ code: 'ADVISOR_UNWATCHED', nodeId: 'advisor' }),
    ]);
  });

  it('refuses a definition whose only agent is an advisor', () => {
    const definition = watched();
    definition.entryNodeId = 'advisor';
    definition.nodes = definition.nodes.filter((n) => n.type !== 'agent' || n.id === 'advisor');
    definition.nodes = definition.nodes.map((n) =>
      n.type === 'output' ? { ...n, inputBindings: [{ kind: 'run_input', name: 'brief' }] } : n,
    );
    definition.controlEdges = [
      { id: 'e', source: 'advisor', sourcePort: 'out', target: 'output', targetPort: 'in' },
    ];
    definition.capabilityLinks = [];
    const found = codes(diagnosticsOf(definition));
    expect(found).toEqual(
      expect.arrayContaining(['ADVISOR_UNWATCHED', 'ADVISOR_NOT_A_STEP', 'ADVISOR_OUTSIDE_FLOW']),
    );
    expect(found).not.toContain('ENTRY_INVALID');
  });

  it('refuses advice from an agent that is not an advisor', () => {
    const definition = watched();
    definition.capabilityLinks.push({
      id: 'peer',
      kind: 'advise',
      sourceNodeId: 'writer',
      targetNodeId: 'editor',
    });
    const diagnostics = diagnosticsOf(definition);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'ADVISOR_ADVISE_SOURCE', linkId: 'peer' }),
    );
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: 'CAPABILITY_TARGET' }));
  });

  it.each([
    ['an Output', 'output'],
    ['another advisor', 'second'],
    ['itself', 'advisor'],
    ['a Decision', 'gate'],
    ['a Loop', 'loop'],
    ['a Team', 'team'],
    ['a Join', 'join'],
  ])('refuses an advisor that watches %s', (_what, target) => {
    const definition = watched();
    definition.nodes.push(
      advisorNode('second'),
      {
        id: 'gate',
        type: 'decision',
        label: 'gate',
        mode: 'approval',
        rule: 'human_approval',
        inputBindings: [{ kind: 'task_output', name: 'text', sourceNodeId: 'writer' }],
      },
      { id: 'loop', type: 'loop', label: 'loop', maxIterations: 2 },
      { id: 'team', type: 'team', label: 'team', source: { kind: 'inline' } },
      { id: 'join', type: 'join', label: 'join', policy: 'all' },
    );
    definition.capabilityLinks.push(
      { id: 'second_watch', kind: 'advise', sourceNodeId: 'second', targetNodeId: 'writer' },
      { id: 'bad', kind: 'advise', sourceNodeId: 'advisor', targetNodeId: target },
    );
    const diagnostics = diagnosticsOf(definition);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'ADVISOR_ADVISE_TARGET', linkId: 'bad' }),
    );
    expect(diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'ADVISOR_ADVISE_TARGET', linkId: 'second_watch' }),
    );
  });

  it('accepts a callable agent as what an advisor watches', () => {
    const definition = withCalledHelper();
    definition.capabilityLinks.push({
      id: 'watch_helper',
      kind: 'advise',
      sourceNodeId: 'advisor',
      targetNodeId: 'helper',
    });
    expect(codes(diagnosticsOf(definition))).toEqual(['ADVISOR_NOT_SUPPORTED']);
    const result = compileDefinition(definition, { advisors: 'plan' });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.plan.advisors.advisor?.watches).toEqual(['writer', 'helper']);
  });

  it('refuses parent questions on an advise link', () => {
    const definition = watched();
    definition.capabilityLinks = [
      {
        id: 'watch',
        kind: 'advise',
        sourceNodeId: 'advisor',
        targetNodeId: 'writer',
        parentQuestions: true,
      },
    ];
    expect(diagnosticsOf(definition)).toEqual([
      expect.objectContaining({ code: 'ADVISOR_ADVISE_QUESTIONS', linkId: 'watch' }),
      expect.objectContaining({ code: 'ADVISOR_NOT_SUPPORTED', nodeId: 'advisor' }),
    ]);
  });

  it('an advise link with parent questions opens no question path for its target', () => {
    const definition = watched();
    definition.capabilityLinks = [
      {
        id: 'watch',
        kind: 'advise',
        sourceNodeId: 'advisor',
        targetNodeId: 'writer',
        parentQuestions: true,
      },
    ];
    definition.nodes = definition.nodes.map((n) =>
      n.id === 'writer' && isWorkAgent(n)
        ? { ...n, inputBindings: [...n.inputBindings, { kind: 'question_answer', name: 'reply' }] }
        : n,
    );
    const result = compileDefinition(definition, { advisors: 'plan' });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'BINDING_SOURCE', nodeId: 'writer' }),
    );
  });

  it('an advise link drawn from a working agent does not count as calling its target', () => {
    const definition = linearCorral(['writer']);
    definition.nodes.push({
      id: 'helper',
      type: 'agent',
      label: 'helper',
      roleId: 'writer_role',
      invocation: 'callable',
      inputBindings: [],
      outputName: 'help',
    });
    definition.capabilityLinks.push({
      id: 'peer',
      kind: 'advise',
      sourceNodeId: 'writer',
      targetNodeId: 'helper',
    });
    const diagnostics = diagnosticsOf(definition);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'ADVISOR_ADVISE_SOURCE', linkId: 'peer' }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'UNREACHABLE', nodeId: 'helper' }),
    );
  });

  it('a watched callable agent is reached only by being called, not by being watched', () => {
    const definition = watched();
    definition.nodes.push({
      id: 'helper',
      type: 'agent',
      label: 'helper',
      roleId: 'editor_role',
      invocation: 'callable',
      inputBindings: [],
      outputName: 'help',
    });
    definition.capabilityLinks.push({
      id: 'watch_helper',
      kind: 'advise',
      sourceNodeId: 'advisor',
      targetNodeId: 'helper',
    });
    expectOne(definition, { code: 'UNREACHABLE', nodeId: 'helper' });
  });
});

describe('rule 11: tools', () => {
  it.each<[string, Partial<AgentRole>]>([
    ['a file writer', { allowedWorkTools: ['read_file', 'write_file'] }],
    ['an artifact writer', { allowedWorkTools: ['write_artifact'] }],
    [
      'a result submitter',
      { allowedCollaborationTools: ['read_artifact', 'advise', 'submit_result'] },
    ],
    ['a delegator', { allowedCollaborationTools: ['advise', 'spawn_subagents'] }],
    ['asking the person', { allowedCollaborationTools: ['advise', 'ask_user'] }],
    ['a plan keeper', { allowedCollaborationTools: ['advise', 'update_plan'] }],
    ['a replier', { allowedCollaborationTools: ['advise', 'reply'] }],
    ['an asker', { allowedCollaborationTools: ['advise', 'ask'] }],
    ['a waiter on tasks', { allowedCollaborationTools: ['advise', 'await_tasks'] }],
  ])('refuses an advisor role that is %s', (_what, change) => {
    const definition = watched();
    definition.roles = definition.roles.map((r) =>
      r.id === 'advisor_role' ? advisorRole(change) : r,
    );
    expectOne(definition, { code: 'ADVISOR_TOOLS', nodeId: 'advisor' });
  });

  it('accepts an advisor role with fewer read tools', () => {
    const definition = watched();
    definition.roles = definition.roles.map((r) =>
      r.id === 'advisor_role'
        ? advisorRole({ allowedWorkTools: ['read_file'], allowedCollaborationTools: ['advise'] })
        : r,
    );
    expect(codes(diagnosticsOf(definition))).toEqual(['ADVISOR_NOT_SUPPORTED']);
  });

  it.each(['scheduled', 'callable'])('refuses the advise tool on a %s agent', (invocation) => {
    const definition = linearCorral(['writer']);
    definition.roles[0]!.allowedCollaborationTools.push('advise');
    if (invocation === 'callable') {
      definition.nodes.push({
        id: 'helper',
        type: 'agent',
        label: 'helper',
        roleId: 'writer_role',
        invocation: 'callable',
        inputBindings: [],
        outputName: 'help',
      });
      definition.roles[0]!.allowedCollaborationTools.push('spawn_subagents');
      definition.capabilityLinks.push({
        id: 'call',
        kind: 'delegate',
        sourceNodeId: 'writer',
        targetNodeId: 'helper',
      });
    }
    const diagnostics = diagnosticsOf(definition);
    const id = invocation === 'callable' ? 'helper' : 'writer';
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'ADVISE_TOOL_ADVISOR_ONLY', nodeId: id }),
    );
  });

  it('a Markdown agent that lists advise is refused the same way once imported', () => {
    const definition = linearCorral(['writer']);
    definition.roles[0]!.allowedCollaborationTools.push('advise');
    const imported = importMarkdownAgent({
      draft: { definition },
      candidate: parseMarkdownAgent(
        '---\nname: critic\ndescription: Comment on drafts\ntools: [advise]\n---\nAdvise.',
      ),
      parentNodeId: 'writer',
      modelProfile: 'model-a',
      profiles: [{ profileId: 'model-a', available: true }],
      mappings: { advise: 'advise' },
      suffix: 'md',
    });
    expect(
      imported.definition.roles.find((r) => r.id === 'import_md_role')?.allowedCollaborationTools,
    ).toContain('advise');
    expectOne(imported.definition, { code: 'ADVISE_TOOL_ADVISOR_ONLY', nodeId: 'import_md' });
  });
});

describe('rule 11: an advisor is not a step', () => {
  it('refuses a flow that starts at an advisor', () => {
    const definition = watched();
    definition.entryNodeId = 'advisor';
    const diagnostics = diagnosticsOf(definition);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'ADVISOR_NOT_A_STEP', nodeId: 'advisor' }),
    );
    expect(codes(diagnostics)).not.toContain('ENTRY_INVALID');
  });

  it('refuses an input that reads an advisor', () => {
    const definition = watched();
    definition.nodes = definition.nodes.map((n) =>
      n.id === 'editor' && n.type === 'agent' && n.invocation !== 'observer'
        ? {
            ...n,
            inputBindings: [
              ...n.inputBindings,
              { kind: 'task_output' as const, name: 'notes', sourceNodeId: 'advisor' },
            ],
          }
        : n,
    );
    const diagnostics = diagnosticsOf(definition);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'ADVISOR_NOT_A_STEP', nodeId: 'editor' }),
    );
    expect(codes(diagnostics)).not.toContain('BINDING_SOURCE');
  });

  it.each([
    ['a Decision', 'gate'],
    ['an Output', 'output'],
    ['a referenced Team', 'team'],
  ])('refuses %s that reads an advisor', (_what, reader) => {
    const definition = watched();
    const reads = { kind: 'task_output' as const, name: 'notes', sourceNodeId: 'advisor' };
    definition.nodes.push(
      {
        id: 'gate',
        type: 'decision',
        label: 'gate',
        mode: 'approval',
        rule: 'human_approval',
        inputBindings: [{ kind: 'task_output', name: 'text', sourceNodeId: 'writer' }],
      },
      {
        id: 'team',
        type: 'team',
        label: 'team',
        source: { kind: 'reference', corralId: 'saved', definitionRevision: 1 },
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
      },
    );
    definition.nodes = definition.nodes.map((n) =>
      n.id === reader && 'inputBindings' in n
        ? ({ ...n, inputBindings: [...(n.inputBindings ?? []), reads] } as CorralNode)
        : n,
    );
    expectOne(definition, { code: 'ADVISOR_NOT_A_STEP', nodeId: reader });
  });
});

describe('a referenced Team with an advisor', () => {
  it('expands its advisor outside the Team box, renamed like every other member', () => {
    const saved = watched();
    saved.id = 'saved';
    const outer = linearCorral(['lead']);
    outer.nodes.push({
      id: 'team',
      type: 'team',
      label: 'team',
      source: { kind: 'reference', corralId: 'saved', definitionRevision: 1 },
    });
    const expanded = expandReferences(outer, () => saved);
    const advisor = expanded.nodes.find((n) => n.id === 'team.advisor');
    expect(advisor).toMatchObject({ invocation: 'observer', roleId: 'team.advisor_role' });
    expect(advisor?.parentId).toBeUndefined();
    expect(expanded.nodes.find((n) => n.id === 'team.writer')?.parentId).toBe('team');
    expect(expanded.roles.map((r) => r.id)).toContain('team.advisor_role');
    expect(expanded.capabilityLinks).toContainEqual({
      id: 'team.watch',
      kind: 'advise',
      sourceNodeId: 'team.advisor',
      targetNodeId: 'team.writer',
    });
    expect(advisorPlans(expanded)['team.advisor']?.watches).toEqual(['team.writer']);
  });
});

describe('the plan of advisors, with the door open', () => {
  const plan = (definition: unknown) => {
    const result = compileDefinition(definition, { advisors: 'plan' });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    return result.plan;
  };
  const withoutAdvisors = (definition: CorralDefinition): CorralDefinition => ({
    ...definition,
    roles: definition.roles.filter((r) => r.id !== 'advisor_role'),
    nodes: definition.nodes.filter((n) => n.type !== 'agent' || n.invocation !== 'observer'),
    capabilityLinks: definition.capabilityLinks.filter((l) => l.kind !== 'advise'),
  });
  /** The research team (a Loop and callables), with two advisors watching inside and out. */
  function researchWithAdvisors(): CorralDefinition {
    const definition = JSON.parse(JSON.stringify(researchTeam)) as CorralDefinition;
    definition.roles.push(advisorRole());
    definition.nodes.push(advisorNode('advisor'), {
      ...advisorNode('second'),
      review: { interval: 5, maxRequestsPerReview: 2 },
    } as CorralNode);
    definition.capabilityLinks.push(
      { id: 'watch_write', kind: 'advise', sourceNodeId: 'advisor', targetNodeId: 'write' },
      { id: 'watch_helper', kind: 'advise', sourceNodeId: 'advisor', targetNodeId: 'helper' },
      { id: 'watch_review', kind: 'advise', sourceNodeId: 'second', targetNodeId: 'review' },
      { id: 'watch_review_2', kind: 'advise', sourceNodeId: 'second', targetNodeId: 'review' },
    );
    return definition;
  }

  it('the default still refuses a definition that keeps every rule', () => {
    expect(codes(diagnosticsOf(researchWithAdvisors()))).toEqual([
      'ADVISOR_NOT_SUPPORTED',
      'ADVISOR_NOT_SUPPORTED',
    ]);
  });

  it('lists the advisors and leaves every other part of the plan as it is without them', () => {
    const definition = researchWithAdvisors();
    const { advisors, ...rest } = plan(definition);
    expect(advisors).toEqual({
      advisor: {
        nodeId: 'advisor',
        roleId: 'advisor_role',
        review: { interval: 3, maxRequestsPerReview: 8 },
        watches: ['write', 'helper'],
      },
      second: {
        nodeId: 'second',
        roleId: 'advisor_role',
        review: { interval: 5, maxRequestsPerReview: 2 },
        watches: ['review'],
      },
    });
    const { advisors: none, ...base } = plan(withoutAdvisors(definition));
    expect(none).toEqual({});
    expect(rest).toEqual(base);
    expect(rest.order).not.toContain('advisor');
    expect(Object.keys(rest.steps)).not.toContain('advisor');
    expect(Object.keys(rest.callables)).not.toContain('advisor');
    expect(rest.loops.review_loop?.agents).toEqual(['write', 'review']);
    expect(rest.summary).toMatchObject({ scheduledAgents: 3, callableAgents: 2 });
  });

  it('puts the advisors of a referenced and a nested referenced Team at the top, renamed', () => {
    const around = (id: string, corralId: string) => {
      const definition = linearCorral(['lead'], id);
      definition.nodes.push({
        id: 'team',
        type: 'team',
        label: 'team',
        source: { kind: 'reference', corralId, definitionRevision: 1 },
      });
      definition.controlEdges = [
        { id: 'e1', source: 'lead', sourcePort: 'out', target: 'team', targetPort: 'enter' },
        { id: 'e2', source: 'team', sourcePort: 'next', target: 'output', targetPort: 'in' },
      ];
      return definition;
    };
    const saved = watched();
    saved.id = 'saved';
    const middle = around('middle', 'saved');
    middle.roles.push(advisorRole());
    middle.nodes.push(advisorNode());
    middle.capabilityLinks.push({
      id: 'watch',
      kind: 'advise',
      sourceNodeId: 'advisor',
      targetNodeId: 'lead',
    });
    const teams: Record<string, unknown> = { saved, middle };
    const top = around('top', 'middle');
    expect(planRun(top, { resolveTeam: (id) => teams[id] })).toMatchObject({ ok: false });
    const run = planRun(top, { resolveTeam: (id) => teams[id], advisors: 'plan' });
    if (!run.ok) throw new Error(JSON.stringify(run.issues));
    expect(run.plan.advisors).toEqual({
      'team.advisor': {
        nodeId: 'team.advisor',
        roleId: 'team.advisor_role',
        review: { interval: 3, maxRequestsPerReview: 8 },
        watches: ['team.lead'],
      },
      'team.team.advisor': {
        nodeId: 'team.team.advisor',
        roleId: 'team.team.advisor_role',
        review: { interval: 3, maxRequestsPerReview: 8 },
        watches: ['team.team.writer'],
      },
    });
    for (const id of ['team.advisor', 'team.team.advisor'])
      expect(run.definition.nodes.find((n) => n.id === id)?.parentId).toBeUndefined();
    expect(run.plan.order.filter((id) => id.endsWith('advisor'))).toEqual([]);
  });
});

describe('advisor diagnostics in the editor', () => {
  const ADVISOR_CODES: Diagnostic['code'][] = [
    'ADVISOR_OUTSIDE_FLOW',
    'ADVISOR_UNWATCHED',
    'ADVISOR_ADVISE_SOURCE',
    'ADVISOR_ADVISE_TARGET',
    'ADVISOR_ADVISE_QUESTIONS',
    'ADVISOR_TOOLS',
    'ADVISE_TOOL_ADVISOR_ONLY',
    'ADVISOR_NOT_A_STEP',
    'ADVISOR_NOT_SUPPORTED',
  ];
  it.each([
    ['en', en],
    ['ko', ko],
  ])('every advisor code has a %s sentence', (_lang, messages) => {
    const catalog = messages.Validation.codes as Record<string, string>;
    for (const code of ADVISOR_CODES) expect(catalog[code], code).toBeTruthy();
  });
});
