import type { AgentRole, CorralDefinition, CorralNode } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { expandReferences } from '../src/expand-teams.ts';
import {
  advisorPlans,
  compileDefinition,
  type Diagnostic,
  importMarkdownAgent,
  inputPortsOf,
  outputPortsOf,
  parseMarkdownAgent,
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

  it('refuses a question link to an advisor', () => {
    const definition = watched();
    definition.capabilityLinks.push({
      id: 'ask',
      kind: 'question',
      sourceNodeId: 'writer',
      targetNodeId: 'advisor',
    });
    expectOne(definition, { code: 'ADVISOR_OUTSIDE_FLOW', linkId: 'ask' });
  });
});

describe('rule 11: advise links', () => {
  it('refuses an advisor that watches no one, which is also isolated', () => {
    const definition = watched();
    definition.capabilityLinks = [];
    const diagnostics = diagnosticsOf(definition);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'ADVISOR_ADVISE_LINK', nodeId: 'advisor' }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'UNREACHABLE', nodeId: 'advisor' }),
    );
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
      expect.arrayContaining(['ADVISOR_ADVISE_LINK', 'ADVISOR_NOT_A_STEP', 'ADVISOR_OUTSIDE_FLOW']),
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
      expect.objectContaining({ code: 'ADVISOR_ADVISE_LINK', linkId: 'peer' }),
    );
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: 'CAPABILITY_TARGET' }));
  });

  it.each([
    ['an Output', 'output'],
    ['another advisor', 'second'],
  ])('refuses an advisor that watches %s', (_what, target) => {
    const definition = watched();
    definition.nodes.push(advisorNode('second'));
    definition.capabilityLinks.push(
      { id: 'second_watch', kind: 'advise', sourceNodeId: 'second', targetNodeId: 'writer' },
      { id: 'bad', kind: 'advise', sourceNodeId: 'advisor', targetNodeId: target },
    );
    expectOne(definition, { code: 'ADVISOR_ADVISE_LINK', linkId: 'bad' });
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
      expect.objectContaining({ code: 'ADVISOR_ADVISE_LINK', linkId: 'peer' }),
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
