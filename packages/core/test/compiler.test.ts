import type { CorralDefinition } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { compileDefinition, type Diagnostic } from '../src/index.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const team = () => clone(researchTeam) as any;

function diagnosticsOf(doc: unknown, options?: Parameters<typeof compileDefinition>[1]) {
  const result = compileDefinition(doc, options);
  if (result.ok) throw new Error('expected the definition to be rejected');
  return result.diagnostics;
}

const has = (diagnostics: Diagnostic[], expected: Partial<Diagnostic>) =>
  expect(diagnostics).toContainEqual(expect.objectContaining(expected));

describe('compileDefinition: valid definition', () => {
  it('compiles the research team example into an execution plan', () => {
    const result = compileDefinition(researchTeam);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
    const { plan } = result;

    expect(plan.entryNodeId).toBe('research');
    expect(plan.order).toEqual([
      'research',
      'review_loop',
      'write',
      'review',
      'review_decision',
      'approval',
      'output',
    ]);
    expect(plan.loops.review_loop).toEqual({
      nodeId: 'review_loop',
      maxIterations: 2,
      bodyEntryNodeId: 'write',
      members: ['write', 'review', 'review_decision'],
      next: { nodeId: 'approval', port: 'in' },
    });
    expect(plan.steps.review_decision).toMatchObject({
      kind: 'decision',
      mode: 'review',
      branches: {
        pass: { nodeId: 'review_loop', port: 'exit' },
        revise: { nodeId: 'review_loop', port: 'repeat' },
      },
    });
    expect(plan.callables).toEqual({
      research: { delegate: ['helper'], question: [] },
      respond: { delegate: ['helper'], question: [] },
      write: { delegate: [], question: ['respond'] },
    });
    expect(plan.summary).toEqual({
      scheduledAgents: 3,
      callableAgents: 2,
      decisions: 2,
      loops: 1,
      outputs: 1,
      maxStaticDepth: 2,
    });
  });

  it('[TC-CAN-003-N] capability links never put a callable agent into the control order', () => {
    const result = compileDefinition(researchTeam);
    if (!result.ok) throw new Error('expected ok');
    expect(result.plan.order).not.toContain('helper');
    expect(result.plan.order).not.toContain('respond');
    expect(result.plan.steps.helper).toBeUndefined();
  });
});

describe('compileDefinition: rejected definitions name the location', () => {
  it('[TC-CAN-004-H] reports each structural problem with its code and location', () => {
    const cases: [string, (d: any) => void, Partial<Diagnostic>][] = [
      [
        'edge into a loop member from outside the loop',
        (d) => (d.controlEdges[0] = { ...d.controlEdges[0], target: 'write', targetPort: 'in' }),
        { code: 'LOOP_BOUNDARY', edgeId: 'e1' },
      ],
      [
        'unknown role',
        (d) => (d.nodes[0].roleId = 'ghost'),
        { code: 'UNKNOWN_REFERENCE', nodeId: 'research' },
      ],
      [
        'duplicate node id',
        (d) => (d.nodes[1].id = 'research'),
        { code: 'DUPLICATE_ID', nodeId: 'research' },
      ],
      [
        'agent leaving through a decision port',
        (d) => (d.controlEdges[0].sourcePort = 'pass'),
        { code: 'INVALID_PORT', edgeId: 'e1' },
      ],
      [
        'two next steps from one port',
        (d) =>
          d.controlEdges.push({
            id: 'e9',
            source: 'research',
            sourcePort: 'out',
            target: 'output',
            targetPort: 'in',
          }),
        { code: 'DUPLICATE_PORT_EDGE', edgeId: 'e9' },
      ],
      [
        'callable agent in the control flow',
        (d) => (d.controlEdges[0] = { ...d.controlEdges[0], target: 'helper', targetPort: 'in' }),
        { code: 'CALLABLE_IN_CONTROL_FLOW', edgeId: 'e1' },
      ],
      [
        'delegation the role may not perform',
        (d) => (d.roles[0].allowedCollaborationTools = ['submit_result']),
        { code: 'CAPABILITY_NOT_ALLOWED', linkId: d0Link('research', 'helper') },
      ],
      [
        'capability target that is not callable',
        (d) => (d.capabilityLinks[0].targetNodeId = 'write'),
        { code: 'CAPABILITY_TARGET', linkId: d0Link('research', 'helper') },
      ],
      [
        'review decision fed by a non-review output',
        (d) =>
          (d.nodes.find((n: any) => n.id === 'review_decision').inputBindings[0].sourceNodeId =
            'write'),
        { code: 'REVIEW_CONTRACT', nodeId: 'review_decision' },
      ],
      [
        'decision mode and rule disagree',
        (d) => (d.nodes.find((n: any) => n.id === 'approval').rule = 'review_verdict'),
        { code: 'DECISION_RULE', nodeId: 'approval' },
      ],
      [
        'review decision without a revise branch',
        (d) => (d.controlEdges = d.controlEdges.filter((e: any) => e.sourcePort !== 'revise')),
        { code: 'DECISION_BRANCH_MISSING', nodeId: 'review_decision' },
      ],
      [
        'input from a step that runs later',
        (d) =>
          d.nodes[0].inputBindings.push({
            kind: 'task_output',
            name: 'draft',
            sourceNodeId: 'write',
          }),
        { code: 'BINDING_SOURCE', nodeId: 'research' },
      ],
      [
        'previous-iteration input outside the loop',
        (d) =>
          d.nodes
            .find((n: any) => n.id === 'approval')
            .inputBindings.push({
              kind: 'previous_iteration_output',
              name: 'old',
              sourceNodeId: 'write',
              optional: true,
            }),
        { code: 'BINDING_SOURCE', nodeId: 'approval' },
      ],
      [
        'second loop',
        (d) => d.nodes.push({ id: 'loop_two', type: 'loop', label: 'Two', maxIterations: 2 }),
        { code: 'TOO_MANY_LOOPS', nodeId: 'loop_two' },
      ],
      [
        'loop without a repeat edge',
        (d) => {
          d.controlEdges = d.controlEdges.filter((e: any) => e.targetPort !== 'repeat');
          d.nodes.find((n: any) => n.id === 'review_decision').mode = 'rule';
          d.nodes.find((n: any) => n.id === 'review_decision').rule = 'required_tasks_submitted';
          for (const e of d.controlEdges) if (e.sourcePort === 'pass') e.sourcePort = 'yes';
          d.controlEdges.push({
            id: 'e_no',
            source: 'review_decision',
            sourcePort: 'no',
            target: 'review_loop',
            targetPort: 'exit',
          });
        },
        { code: 'LOOP_STRUCTURE', nodeId: 'review_loop' },
      ],
      [
        'delegation deeper than the limit',
        (d) => {
          // helper is reached at depth 1, so helper2 at 2 and helper3 at 3 at the shortest.
          const helper = d.nodes.find((n: any) => n.id === 'helper');
          d.nodes.push(
            { ...helper, id: 'helper2', label: 'Deeper' },
            { ...helper, id: 'helper3', label: 'Deepest' },
          );
          d.roles
            .find((r: any) => r.id === 'helper')
            .allowedCollaborationTools.push('spawn_subagents');
          d.capabilityLinks.push(
            { id: 'c_deep', kind: 'delegate', sourceNodeId: 'helper', targetNodeId: 'helper2' },
            { id: 'c_deeper', kind: 'delegate', sourceNodeId: 'helper2', targetNodeId: 'helper3' },
          );
        },
        { code: 'DEPTH_EXCEEDED', nodeId: 'helper3' },
      ],
    ];
    for (const [name, change, expected] of cases) {
      const doc = team();
      change(doc);
      const diagnostics = diagnosticsOf(doc);
      expect(diagnostics, name).toContainEqual(expect.objectContaining(expected));
    }
  });

  it('rejects a cycle outside a loop, naming the edge that closes it', () => {
    const doc = team();
    doc.controlEdges.push({
      id: 'e_back',
      source: 'approval',
      sourcePort: 'reject',
      target: 'research',
      targetPort: 'in',
    });
    doc.controlEdges = doc.controlEdges.filter((e: any) => e.id !== 'e8');
    doc.controlEdges.push({
      id: 'e8',
      source: 'approval',
      sourcePort: 'approve',
      target: 'output',
      targetPort: 'in',
    });
    has(diagnosticsOf(doc), { code: 'CYCLE_OUTSIDE_LOOP', edgeId: 'e_back' });
  });

  it('reports unreachable nodes', () => {
    const doc = team();
    doc.nodes.push({ ...doc.nodes[0], id: 'orphan', label: 'Orphan' });
    has(diagnosticsOf(doc), { code: 'UNREACHABLE', nodeId: 'orphan' });
  });

  it('checks model profiles against the known list when one is given', () => {
    has(diagnosticsOf(researchTeam, { knownModelProfiles: ['model-a'] }), {
      code: 'UNKNOWN_MODEL_PROFILE',
    });
    expect(compileDefinition(researchTeam, { knownModelProfiles: ['model-a', 'model-b'] }).ok).toBe(
      true,
    );
  });

  it('[TC-CAN-004-N] refuses imports it does not understand instead of ignoring them', () => {
    const unknownField = team();
    unknownField.nodes[0].retries = 3;
    has(diagnosticsOf(unknownField), { code: 'SCHEMA_INVALID', nodeId: 'research' });

    const newer = team();
    newer.schemaVersion = '0.2';
    has(diagnosticsOf(newer), { code: 'SCHEMA_INVALID' });

    expect(compileDefinition('not json at all').ok).toBe(false);
  });

  it('returns diagnostics in a stable order', () => {
    const doc = team();
    doc.nodes[0].roleId = 'ghost';
    doc.controlEdges[0].sourcePort = 'pass';
    const first = diagnosticsOf(doc);
    const second = diagnosticsOf(clone(doc));
    expect(first).toEqual(second);
  });
});

describe('compileDefinition: unfinished drafts', () => {
  it('explains what is missing in plain words, located on the node', () => {
    const doc = team();
    doc.nodes = [doc.nodes.find((n: any) => n.id === 'review_decision')];
    doc.nodes[0].inputBindings = [];
    delete doc.nodes[0].loopId;
    doc.controlEdges = [];
    doc.entryNodeId = '';
    const diagnostics = diagnosticsOf(doc);
    has(diagnostics, { code: 'SCHEMA_INVALID', message: 'Connect the nodes to define the order.' });
    has(diagnostics, {
      code: 'SCHEMA_INVALID',
      message: 'Add at least two nodes: an Agent and an Output.',
    });
    has(diagnostics, { code: 'SCHEMA_INVALID', message: 'Add an Agent where the flow starts.' });
    has(diagnostics, {
      code: 'SCHEMA_INVALID',
      nodeId: 'review_decision',
      message: 'This node needs at least one input.',
    });
  });
});

function d0Link(source: string, target: string): string {
  const link = (researchTeam as unknown as CorralDefinition).capabilityLinks.find(
    (l) => l.sourceNodeId === source && l.targetNodeId === target,
  );
  if (!link) throw new Error(`no link ${source} → ${target} in the example`);
  return link.id;
}
