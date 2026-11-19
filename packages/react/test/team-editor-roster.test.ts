import {
  type ControlEdge,
  CorralDefinition,
  type CorralNode,
  type WorkAgentNode,
} from '@corral/contracts';
import { TEAM_TEMPLATE_ROLES, type TeamTemplateId, teamTemplate } from '@corral/core';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json';
import { outlineOrder } from '../src/team-editor/layout.ts';
import { type RosterRow, rosterOf } from '../src/team-editor/roster.ts';

function template(id: TeamTemplateId) {
  return teamTemplate(id, 'example', {
    name: id,
    brief: 'Prepare a result.',
    criteria: ['Reviewed'],
    roles: Object.fromEntries(
      Object.keys(TEAM_TEMPLATE_ROLES[id]).map((k) => [k, { name: k, duty: k }]),
    ),
    labels: { loop: 'Review loop', decision: 'Decision', join: 'Gather', output: 'Output' },
  });
}

const research = CorralDefinition.parse(researchTeam);
const roster = (d: CorralDefinition) => rosterOf(d, outlineOrder(d));
const edge = (
  source: string,
  sourcePort: string,
  target: string,
  targetPort: ControlEdge['targetPort'] = 'in',
): ControlEdge => ({
  id: `${source}_${sourcePort}_${target}_${targetPort}`,
  source,
  sourcePort,
  target,
  targetPort,
});
const agent = (id: string): WorkAgentNode => ({
  id,
  type: 'agent',
  label: id,
  roleId: 'researcher',
  invocation: 'scheduled',
  inputBindings: [],
  outputName: 'notes',
});
const draft = (
  entryNodeId: string,
  nodes: CorralNode[],
  controlEdges: ControlEdge[] = [],
): CorralDefinition => ({
  ...research,
  entryNodeId,
  nodes,
  controlEdges,
  capabilityLinks: [],
});
function ids(rows: readonly RosterRow[]) {
  return rows.map((r) => (r.kind === 'parallel' ? r.kind : r.nodeId));
}
function freeze(value: unknown) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

describe('team composition roster', () => {
  it.each([
    ['implement-review', [], 'implement'],
    ['plan-implement-review', ['plan'], 'implement'],
    ['bug-fix', ['investigate'], 'fix'],
  ] as const)(
    '%s: groups the review rounds and follows decision ports through the Loop boundary',
    (id, prefix, worker) => {
      const { steps, outputs, unconnected } = roster(template(id));
      expect(ids(steps)).toEqual([...prefix, 'review_loop']);
      const loop = steps.at(-1);
      expect(loop?.kind).toBe('loop');
      if (loop?.kind !== 'loop') throw new Error('expected a Loop');
      expect(loop.maxIterations).toBe(2);
      expect(ids(loop.children)).toEqual([worker, 'review', 'review_decision']);
      expect(loop.children.at(-1)).toMatchObject({
        kind: 'decision',
        branches: [
          { port: 'pass', targetId: 'review_loop', destinationId: 'output' },
          { port: 'revise', targetId: 'review_loop', destinationId: worker },
        ],
      });
      expect(outputs).toMatchObject([
        { nodeId: 'output', bindings: [{ name: 'draft', producerId: worker }] },
      ]);
      expect(unconnected).toEqual([]);
    },
  );

  it.each([
    ['parallel-review', 'scope', 'correctness', 'security', 'synthesis'],
    ['tech-decision', 'frame', 'research_a', 'research_b', 'compare'],
  ] as const)(
    '%s: keeps the branches together and the Join and following stages outside',
    (id, source, a, b, last) => {
      const definition = template(id);
      // Reversing the wires must not reverse the layout's reading order.
      const { steps, outputs } = roster({
        ...definition,
        controlEdges: definition.controlEdges.toReversed(),
      });
      expect(ids(steps)).toEqual([source, 'parallel', 'gather', last]);
      expect(steps[1]).toMatchObject({
        kind: 'parallel',
        sourceId: source,
        port: 'out',
        branches: [
          { targetId: a, rows: [{ nodeId: a }] },
          { targetId: b, rows: [{ nodeId: b }] },
        ],
      });
      expect(outputs).toMatchObject([
        { nodeId: 'output', bindings: [{ name: 'draft', producerId: last }] },
      ]);
    },
  );

  it('nests fan-outs, keeps an entire multi-step branch, and closes each group only at its own merge', () => {
    const workers = ['start', 'left', 'right', 'a', 'b', 'after'];
    const d = draft(
      'start',
      [
        ...workers.map(agent),
        ...['inner', 'outer'].map(
          (id): CorralNode => ({ type: 'join', id, label: id, policy: 'all' }),
        ),
      ],
      [
        edge('start', 'out', 'left'),
        edge('start', 'out', 'right'),
        edge('left', 'out', 'a'),
        edge('left', 'out', 'b'),
        edge('a', 'out', 'inner'),
        edge('b', 'out', 'inner'),
        edge('inner', 'out', 'after'),
        edge('after', 'out', 'outer'),
        edge('right', 'out', 'outer'),
      ],
    );
    const { steps } = roster(d);
    expect(ids(steps)).toEqual(['start', 'parallel', 'outer']);
    expect(steps[1]).toMatchObject({
      branches: [
        {
          targetId: 'left',
          rows: [
            { nodeId: 'left' },
            {
              kind: 'parallel',
              branches: [{ rows: [{ nodeId: 'a' }] }, { rows: [{ nodeId: 'b' }] }],
            },
            { nodeId: 'inner' },
            { nodeId: 'after' },
          ],
        },
        { targetId: 'right', rows: [{ nodeId: 'right' }] },
      ],
    });
  });

  it('reads the research team without mutating even nested fields; calls are under every caller, not steps', () => {
    const d = structuredClone(research);
    freeze(d);
    const result = roster(d);
    expect(ids(result.steps)).toEqual(['research', 'review_loop', 'approval']);
    expect(result.steps[0]).toMatchObject({
      calls: [{ kind: 'called', nodeId: 'helper', callerId: 'research' }],
    });
    expect(result.steps[1]).toMatchObject({
      children: [
        {
          nodeId: 'write',
          calls: [
            {
              kind: 'called',
              nodeId: 'respond',
              callerId: 'write',
              calls: [{ kind: 'called', nodeId: 'helper', callerId: 'respond' }],
            },
          ],
        },
        { nodeId: 'review' },
        { nodeId: 'review_decision' },
      ],
    });
    expect(result.steps[2]).toMatchObject({ branches: [{ port: 'approve', targetId: 'output' }] });
    expect(result.unconnected).toEqual([]);
    expect(roster(d)).toEqual(result);
    expect(d).toEqual(research);
  });

  it('accepts empty drafts and a lone agent; neither invents an Output', () => {
    expect(roster(draft('', []))).toEqual({
      steps: [],
      unconnected: [],
      outputs: [],
      advice: { shared: null, observerIds: [] },
    });
    const r = roster(draft('only', [agent('only')]));
    expect(ids(r.steps)).toEqual(['only']);
    expect(r.outputs).toEqual([]);
  });

  it('keeps disconnected steps in definition order, independently of dangling edges, calls and a missing entry', () => {
    const d = draft(
      'start',
      [agent('z'), agent('start'), agent('a'), { ...agent('helper'), invocation: 'callable' }],
      [edge('start', 'out', 'absent'), edge('absent', 'out', 'a')],
    );
    d.capabilityLinks.push(
      { id: 'call', kind: 'delegate', sourceNodeId: 'z', targetNodeId: 'helper' },
      { id: 'dangling', kind: 'question', sourceNodeId: 'start', targetNodeId: 'absent' },
    );
    const r = roster(d);
    expect(ids(r.steps)).toEqual(['start']);
    expect(r.steps[0]).toMatchObject({ calls: [] });
    expect(ids(r.unconnected)).toEqual(['z', 'a']);
    expect(r.unconnected[0]).toMatchObject({ calls: [{ kind: 'called', nodeId: 'helper' }] });
    const noEntry = roster({ ...d, entryNodeId: 'absent' });
    expect(noEntry.steps).toEqual([]);
    expect(ids(noEntry.unconnected)).toEqual(['z', 'start', 'a']);
  });

  it('shows orphan callables outside the step order, without losing callees or expanding a cycle forever', () => {
    const d = draft('start', [
      agent('start'),
      ...['helper', 'orphan', 'unused'].map(
        (id): WorkAgentNode => ({
          ...agent(id),
          invocation: 'callable',
        }),
      ),
    ]);
    d.capabilityLinks.push(
      { id: 'call', kind: 'delegate', sourceNodeId: 'orphan', targetNodeId: 'helper' },
      { id: 'recursive', kind: 'question', sourceNodeId: 'helper', targetNodeId: 'helper' },
    );
    const r = roster(d);
    expect(ids(r.steps)).toEqual(['start']);
    expect(r.unconnected).toEqual([
      {
        kind: 'callable',
        nodeId: 'orphan',
        calls: [
          {
            kind: 'called',
            nodeId: 'helper',
            callerId: 'orphan',
            calls: [
              {
                kind: 'called',
                nodeId: 'helper',
                callerId: 'helper',
                calls: [],
              },
            ],
          },
        ],
      },
      { kind: 'callable', nodeId: 'unused', calls: [] },
    ]);
  });

  it('shows a shared helper under both callers but its own outgoing call only once', () => {
    const d = draft(
      'a',
      [
        agent('a'),
        agent('b'),
        { ...agent('helper'), invocation: 'callable' },
        { ...agent('expert'), invocation: 'callable' },
      ],
      [edge('a', 'out', 'b')],
    );
    d.capabilityLinks.push(
      { id: 'a_help', kind: 'delegate', sourceNodeId: 'a', targetNodeId: 'helper' },
      { id: 'b_help', kind: 'question', sourceNodeId: 'b', targetNodeId: 'helper' },
      { id: 'expertise', kind: 'question', sourceNodeId: 'helper', targetNodeId: 'expert' },
    );
    const r = roster(d);
    expect(r.steps).toMatchObject([
      {
        nodeId: 'a',
        calls: [
          { nodeId: 'helper', callerId: 'a', calls: [{ nodeId: 'expert', callerId: 'helper' }] },
        ],
      },
      { nodeId: 'b', calls: [{ nodeId: 'helper', callerId: 'b', calls: [] }] },
    ]);
    expect(r.unconnected).toEqual([]);
  });

  it('nests an empty Loop and a pinned reference inside an inline Team, even without layout entries for members', () => {
    const d = draft(
      'team',
      [
        { id: 'team', type: 'team', label: 'Team', source: { kind: 'inline' } },
        {
          id: 'loop',
          type: 'loop',
          label: 'Repeat',
          parentId: 'team',
          limitPolicy: { kind: 'unlimited' },
          stallDetection: true,
        },
        {
          id: 'pinned',
          type: 'team',
          label: 'Other team',
          parentId: 'team',
          source: { kind: 'reference', corralId: 'other', definitionRevision: 5 },
        },
      ],
      [edge('team', 'body', 'loop', 'enter'), edge('loop', 'next', 'pinned', 'enter')],
    );
    const order = outlineOrder(d);
    order.delete('loop');
    order.delete('pinned');
    const r = rosterOf(d, order);
    expect(r.steps).toMatchObject([
      {
        kind: 'team',
        children: [
          {
            kind: 'loop',
            nodeId: 'loop',
            limitPolicy: { kind: 'unlimited' },
            stallDetection: true,
            children: [],
          },
          {
            kind: 'reference',
            nodeId: 'pinned',
            source: { corralId: 'other', definitionRevision: 5 },
          },
        ],
      },
    ]);
    const team = r.steps[0];
    expect(team?.kind === 'team' && team.children[1]).not.toHaveProperty('children');
  });

  it('uses a router’s authored names and edges; different ports never imply parallelism', () => {
    const d = draft(
      'start',
      [
        agent('start'),
        {
          id: 'decision',
          type: 'decision',
          label: 'Route',
          mode: 'router',
          inputBindings: [],
          routes: [
            { id: 'fast', label: 'Fast track' },
            { id: 'deep', label: 'Investigate' },
            { id: 'stop', label: 'Stop here' },
          ],
        },
        agent('c'),
        agent('a'),
        agent('b'),
      ],
      [
        edge('start', 'out', 'decision'),
        edge('decision', 'stop', 'c'),
        edge('decision', 'fast', 'b'),
        edge('decision', 'deep', 'a'),
      ],
    );
    const { steps } = roster(d);
    expect(ids(steps)).toEqual(['start', 'decision', 'b', 'a', 'c']);
    expect(steps[1]).toMatchObject({
      kind: 'decision',
      branches: [
        { port: 'fast', routeLabel: 'Fast track', targetId: 'b' },
        { port: 'deep', routeLabel: 'Investigate', targetId: 'a' },
        { port: 'stop', routeLabel: 'Stop here', targetId: 'c' },
      ],
    });
  });

  it('lists every actual binding of every Output and keeps observers and shared advice separate', () => {
    const d = draft(
      'writer',
      [
        agent('writer'),
        {
          id: 'observer',
          type: 'agent',
          invocation: 'observer',
          label: 'Advisor',
          roleId: 'researcher',
          outputName: 'advice',
        },
        {
          type: 'output',
          id: 'one',
          label: 'One',
          requireApproval: false,
          inputBindings: [
            { kind: 'run_input', name: 'brief' },
            { kind: 'task_output', name: 'selected', sourceNodeId: 'writer' },
            { kind: 'task_output', name: 'broken', sourceNodeId: 'missing' },
          ],
        },
        { type: 'output', id: 'two', label: 'Two', requireApproval: false, inputBindings: [] },
      ],
      [edge('writer', 'out', 'one')],
    );
    d.capabilityLinks.push({
      id: 'watch',
      kind: 'advise',
      sourceNodeId: 'observer',
      targetNodeId: 'writer',
    });
    d.sharedOutrider = {
      modelProfile: 'model-a',
      principles: 'Review carefully.',
      targets: { kind: 'selected', nodeIds: ['writer'] },
    };
    const r = roster(d);
    expect(ids(r.steps)).toEqual(['writer']);
    expect(r.advice).toEqual({
      observerIds: ['observer'],
      shared: { kind: 'selected', nodeIds: ['writer'] },
    });
    expect(r.outputs).toEqual(
      expect.arrayContaining([
        {
          nodeId: 'one',
          connected: true,
          bindings: [
            { name: 'brief', producerId: null },
            { name: 'selected', producerId: 'writer' },
            { name: 'broken', producerId: null },
          ],
        },
        { nodeId: 'two', connected: false, bindings: [] },
      ]),
    );
    expect(r.outputs).toHaveLength(2);
  });
});
