import { CorralDefinition, DEFAULT_LIMITS } from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  type CompileOptions,
  Coordinator,
  compileDefinition,
  type Diagnostic,
  InProcessTransport,
  planRun,
} from '../src/index.ts';

// Acceptance scenarios of docs/specs/features/team-graph.md.

type Doc = Record<string, any>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const role = (id: string, tools: string[] = ['write_artifact']) => ({
  id,
  name: id,
  prompt: `Act as ${id}.`,
  modelProfile: 'model-a',
  allowedWorkTools: tools,
  allowedCollaborationTools: ['submit_result'],
  outputContract: 'text',
});

const from = (sourceNodeId: string) => [{ kind: 'task_output', name: 'input', sourceNodeId }];

const agent = (id: string, extra: Doc = {}): Doc => ({
  id,
  type: 'agent',
  label: id,
  roleId: 'worker',
  invocation: 'scheduled',
  inputBindings: [{ kind: 'run_input', name: 'brief' }],
  outputName: 'text',
  ...extra,
});

const approval = (id: string, source: string, extra: Doc = {}): Doc => ({
  id,
  type: 'decision',
  label: id,
  mode: 'approval',
  rule: 'human_approval',
  inputBindings: from(source),
  ...extra,
});

const loop = (id: string, extra: Doc = {}): Doc => ({
  id,
  type: 'loop',
  label: id,
  maxIterations: 2,
  ...extra,
});

const output = (source: string): Doc => ({
  id: 'output',
  type: 'output',
  label: 'Output',
  inputBindings: from(source),
  requireApproval: false,
});

const edge = (
  id: string,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
) => ({
  id,
  source,
  sourcePort,
  target,
  targetPort,
});

const definition = (nodes: Doc[], controlEdges: Doc[], entryNodeId: string, id = 'graph'): Doc => ({
  schemaVersion: '0.1',
  id,
  name: id,
  entryNodeId,
  input: { brief: 'Do the work.', criteria: ['It is done.'] },
  roles: [role('worker'), role('writer', ['write_file', 'read_file'])],
  nodes,
  controlEdges,
  capabilityLinks: [],
  limits: DEFAULT_LIMITS,
});

/**
 * plan → Loop A [ Loop B [ impl → check(pass: B.exit, fail: B.repeat) ] → Team C [ rev → verdict ] ]
 * → output. The verdict leaves Team C and lands on Loop A's exit and repeat in one step.
 */
function nested(): Doc {
  return definition(
    [
      agent('plan'),
      loop('A'),
      loop('B', { parentId: 'A', maxIterations: 3 }),
      agent('impl', { parentId: 'B', inputBindings: from('plan') }),
      {
        id: 'check',
        type: 'decision',
        label: 'check',
        parentId: 'B',
        mode: 'check',
        checkIds: ['tests'],
        inputBindings: from('impl'),
      },
      { id: 'C', type: 'team', label: 'C', parentId: 'A', source: { kind: 'inline' } },
      agent('rev', { parentId: 'C', inputBindings: from('impl') }),
      approval('verdict', 'rev', { parentId: 'C' }),
      output('rev'),
    ],
    [
      edge('e1', 'plan', 'out', 'A', 'enter'),
      edge('e2', 'A', 'body', 'B', 'enter'),
      edge('e3', 'B', 'body', 'impl', 'in'),
      edge('e4', 'impl', 'out', 'check', 'in'),
      edge('e5', 'check', 'pass', 'B', 'exit'),
      edge('e6', 'check', 'fail', 'B', 'repeat'),
      edge('e7', 'B', 'next', 'C', 'enter'),
      edge('e8', 'C', 'body', 'rev', 'in'),
      edge('e9', 'rev', 'out', 'verdict', 'in'),
      edge('e10', 'verdict', 'approve', 'A', 'exit'),
      edge('e11', 'verdict', 'reject', 'A', 'repeat'),
      edge('e12', 'A', 'next', 'output', 'in'),
    ],
    'plan',
  );
}

/** plan → Loop L1 [ w1 → d1 ] → Loop L2 [ w2 → d2 ] → output */
function twoLoops(): Doc {
  return definition(
    [
      agent('plan'),
      loop('L1'),
      agent('w1', { parentId: 'L1', inputBindings: from('plan') }),
      approval('d1', 'w1', { parentId: 'L1' }),
      loop('L2'),
      agent('w2', { parentId: 'L2', inputBindings: from('w1') }),
      approval('d2', 'w2', { parentId: 'L2' }),
      output('w2'),
    ],
    [
      edge('e1', 'plan', 'out', 'L1', 'enter'),
      edge('e2', 'L1', 'body', 'w1', 'in'),
      edge('e3', 'w1', 'out', 'd1', 'in'),
      edge('e4', 'd1', 'approve', 'L1', 'exit'),
      edge('e5', 'd1', 'reject', 'L1', 'repeat'),
      edge('e6', 'L1', 'next', 'L2', 'enter'),
      edge('e7', 'L2', 'body', 'w2', 'in'),
      edge('e8', 'w2', 'out', 'd2', 'in'),
      edge('e9', 'd2', 'approve', 'L2', 'exit'),
      edge('e10', 'd2', 'reject', 'L2', 'repeat'),
      edge('e11', 'L2', 'next', 'output', 'in'),
    ],
    'plan',
  );
}

/** P fans out to A and B, which both lead into `merge` (an Agent unless replaced). */
function fanOut(merge: Doc = agent('M', { inputBindings: from('A') })): Doc {
  return definition(
    [
      agent('P'),
      agent('A', { inputBindings: from('P') }),
      agent('B', { inputBindings: from('P') }),
      merge,
      output('A'),
    ],
    [
      edge('eP1', 'P', 'out', 'A', 'in'),
      edge('eP2', 'P', 'out', 'B', 'in'),
      edge('eAM', 'A', 'out', 'M', 'in'),
      edge('eBM', 'B', 'out', 'M', 'in'),
      edge('eMO', 'M', 'out', 'output', 'in'),
    ],
    'P',
  );
}

/** P → T (inline Team: body → R → exit) → output. */
function inlineTeam(): Doc {
  return definition(
    [
      agent('P'),
      { id: 'T', type: 'team', label: 'T', source: { kind: 'inline' } },
      agent('R', { parentId: 'T', inputBindings: from('P') }),
      output('R'),
    ],
    [
      edge('e1', 'P', 'out', 'T', 'enter'),
      edge('e2', 'T', 'body', 'R', 'in'),
      edge('e3', 'R', 'out', 'T', 'exit'),
      edge('e4', 'T', 'next', 'output', 'in'),
    ],
    'P',
  );
}

/** P → T (reference to a saved team) → output, with no team source: it does not run yet. */
function referenced(): Doc {
  return definition(
    [
      agent('P'),
      {
        id: 'T',
        type: 'team',
        label: 'T',
        source: { kind: 'reference', corralId: 'y', definitionRevision: 1 },
      },
      output('P'),
    ],
    [edge('e1', 'P', 'out', 'T', 'enter'), edge('e2', 'T', 'next', 'output', 'in')],
    'P',
  );
}

const join = (policy: 'all' | 'any' = 'all'): Doc => ({
  id: 'M',
  type: 'join',
  label: 'M',
  policy,
});

function compile(doc: unknown, options?: CompileOptions) {
  return compileDefinition(doc, options);
}

function errorsOf(doc: unknown, options?: CompileOptions): Diagnostic[] {
  return compile(doc, options).diagnostics.filter((d) => d.severity === 'error');
}

function warningsOf(doc: unknown, options?: CompileOptions): Diagnostic[] {
  const result = compile(doc, options);
  if (!result.ok)
    throw new Error(`expected a valid definition: ${JSON.stringify(result.diagnostics)}`);
  return result.diagnostics.filter((d) => d.severity === 'warning');
}

const codes = (diagnostics: Diagnostic[]) => diagnostics.map((d) => d.code);

describe('team graph: boxes', () => {
  it('defines a loop inside a loop and a team inside a loop', () => {
    expect(errorsOf(nested())).toEqual([]);
  });

  it('lets a node leave several boxes at once onto an ancestor loop exit and repeat', () => {
    const result = compile(nested());
    expect(codes(result.diagnostics)).not.toContain('BOX_BOUNDARY');
    expect(result.ok).toBe(true);
  });

  it('refuses an edge from outside straight into a box member', () => {
    const doc = nested();
    doc.controlEdges[0] = edge('e1', 'plan', 'out', 'impl', 'in');
    expect(errorsOf(doc)).toContainEqual(
      expect.objectContaining({ code: 'BOX_BOUNDARY', edgeId: 'e1' }),
    );
  });

  it('refuses a parent that is not a loop or an inline team, and containment cycles', () => {
    const notABox = nested();
    notABox.nodes.find((n: Doc) => n.id === 'impl').parentId = 'plan';
    expect(errorsOf(notABox)).toContainEqual(
      expect.objectContaining({ code: 'BOX_PARENT', nodeId: 'impl' }),
    );

    const cycle = nested();
    cycle.nodes.find((n: Doc) => n.id === 'A').parentId = 'B';
    expect(codes(errorsOf(cycle))).toContain('CONTAINMENT_CYCLE');
  });

  it('refuses members inside a reference team', () => {
    const doc = nested();
    doc.nodes.find((n: Doc) => n.id === 'C').source = {
      kind: 'reference',
      corralId: 'review_team',
      definitionRevision: 1,
    };
    const options: CompileOptions = { resolveTeam: () => nested() as CorralDefinition };
    expect(errorsOf(doc, options)).toContainEqual(
      expect.objectContaining({ code: 'TEAM_REFERENCE_MEMBERS', nodeId: 'rev' }),
    );
  });

  it('refuses the old loopId membership field', () => {
    const doc = clone(researchTeam) as Doc;
    for (const node of doc.nodes) {
      if (node.parentId) {
        node.loopId = node.parentId;
        delete node.parentId;
      }
    }
    expect(codes(errorsOf(doc))).toContain('SCHEMA_INVALID');
  });
});

describe('team graph: loops', () => {
  it('compiles two loops as runnable', () => {
    expect(codes(warningsOf(twoLoops()))).not.toContain('RUNTIME_UNSUPPORTED');
    expect(planRun(twoLoops()).ok).toBe(true);
  });

  it('takes repeat only from a decision', () => {
    const doc = nested();
    doc.nodes = doc.nodes.filter((n: Doc) => n.id !== 'check');
    doc.controlEdges = doc.controlEdges.filter((e: Doc) => !['e4', 'e5', 'e6'].includes(e.id));
    doc.controlEdges.push(edge('e6', 'impl', 'out', 'B', 'repeat'));
    expect(errorsOf(doc)).toContainEqual(
      expect.objectContaining({ code: 'REPEAT_NEEDS_DECISION', edgeId: 'e6' }),
    );
  });

  it('refuses a loop with no way out', () => {
    const doc = nested();
    doc.controlEdges = doc.controlEdges.filter((e: Doc) => e.id !== 'e5');
    expect(errorsOf(doc)).toContainEqual(
      expect.objectContaining({ code: 'LOOP_NO_EXIT', nodeId: 'B' }),
    );
  });

  it('refuses a body path that stops inside the loop', () => {
    const doc = nested();
    doc.nodes.push(agent('stray', { parentId: 'B', inputBindings: from('impl') }));
    doc.controlEdges.push(edge('e13', 'impl', 'out', 'stray', 'in'));
    expect(codes(errorsOf(doc))).toContain('LOOP_DEAD_END');
  });

  it('has no system ceiling on rounds, and the new loop fields and exhausted port compile', () => {
    const doc = twoLoops();
    const l1 = doc.nodes.find((n: Doc) => n.id === 'L1');
    l1.maxIterations = 50;
    l1.budget = { maxModelCalls: 40, maxWallMs: 1_200_000 };
    l1.stallDetection = true;
    doc.nodes.push(output('w1'));
    doc.nodes[doc.nodes.length - 1].id = 'report';
    doc.controlEdges.push(edge('e12', 'L1', 'exhausted', 'report', 'in'));
    expect(CorralDefinition.safeParse(doc).success).toBe(true);
    expect(errorsOf(doc)).toEqual([]);
  });

  it('may start at a loop, but never at a decision', () => {
    const doc = twoLoops();
    doc.nodes = doc.nodes.filter((n: Doc) => n.id !== 'plan');
    doc.controlEdges = doc.controlEdges.filter((e: Doc) => e.id !== 'e1');
    doc.nodes.find((n: Doc) => n.id === 'w1').inputBindings = [
      { kind: 'run_input', name: 'brief' },
    ];
    doc.entryNodeId = 'L1';
    expect(errorsOf(doc)).toEqual([]);
    expect(codes(warningsOf(doc))).not.toContain('RUNTIME_UNSUPPORTED');

    doc.entryNodeId = 'd1';
    expect(codes(errorsOf(doc))).toContain('ENTRY_INVALID');
  });
});

describe('team graph: parallel branches', () => {
  it('refuses parallel branches that meet without a join', () => {
    const errors = errorsOf(fanOut());
    const merge = errors.find((d) => d.code === 'PARALLEL_MERGE_NEEDS_JOIN');
    expect(merge?.edgeId).toMatch(/^e[AB]M$/);
  });

  it('accepts the same branches meeting at a join, and runs them', () => {
    const doc = fanOut(join());
    expect(errorsOf(doc)).toEqual([]);
    expect(codes(warningsOf(doc))).not.toContain('RUNTIME_UNSUPPORTED');
  });

  it('lets the exclusive branches of a decision meet without a join', () => {
    const doc = definition(
      [agent('P'), approval('D', 'P'), agent('M', { inputBindings: from('P') }), output('M')],
      [
        edge('e1', 'P', 'out', 'D', 'in'),
        edge('e2', 'D', 'approve', 'M', 'in'),
        edge('e3', 'D', 'reject', 'M', 'in'),
        edge('e4', 'M', 'out', 'output', 'in'),
      ],
      'P',
    );
    expect(codes(compile(doc).diagnostics)).not.toContain('PARALLEL_MERGE_NEEDS_JOIN');
    expect(compile(doc).ok).toBe(true);
  });

  it('warns about a join with a single input', () => {
    const doc = fanOut(join());
    doc.controlEdges = doc.controlEdges.filter((e: Doc) => e.id !== 'eBM');
    doc.nodes = doc.nodes.filter((n: Doc) => n.id !== 'B');
    doc.controlEdges = doc.controlEdges.filter((e: Doc) => e.id !== 'eP2');
    expect(warningsOf(doc)).toContainEqual(
      expect.objectContaining({ code: 'JOIN_SINGLE_INPUT', nodeId: 'M' }),
    );
  });

  it('warns when parallel branches write to the same working copy', () => {
    const doc = fanOut(join());
    for (const id of ['A', 'B']) doc.nodes.find((n: Doc) => n.id === id).roleId = 'writer';
    const warnings = warningsOf(doc);
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'PARALLEL_WRITERS', nodeId: 'A' }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'PARALLEL_WRITERS', nodeId: 'B' }),
    );
  });
});

describe('team graph: decisions and failure paths', () => {
  it('refuses a router with fewer than two routes', () => {
    const doc = definition(
      [
        agent('P'),
        {
          id: 'R',
          type: 'decision',
          label: 'R',
          mode: 'router',
          routes: [{ id: 'only', label: 'Only' }],
          inputBindings: from('P'),
        },
        output('P'),
      ],
      [edge('e1', 'P', 'out', 'R', 'in'), edge('e2', 'R', 'only', 'output', 'in')],
      'P',
    );
    expect(errorsOf(doc)).toContainEqual(
      expect.objectContaining({ code: 'ROUTER_ROUTES', nodeId: 'R' }),
    );
  });

  it('accepts unconnected decision exits with a warning', () => {
    const doc = definition(
      [agent('P'), approval('D', 'P'), output('P')],
      [edge('e1', 'P', 'out', 'D', 'in'), edge('e2', 'D', 'reject', 'output', 'in')],
      'P',
    );
    expect(warningsOf(doc)).toContainEqual(
      expect.objectContaining({ code: 'DECISION_BRANCH_MISSING', nodeId: 'D' }),
    );
  });

  it('accepts retries, the error port, notes and a deeper delegation limit', () => {
    const doc = definition(
      [
        agent('P', { retry: { maxAttempts: 2 }, note: 'Kept for people, not for the run.' }),
        agent('fallback', { inputBindings: from('P') }),
        output('P'),
      ],
      [
        edge('e1', 'P', 'out', 'output', 'in'),
        edge('e2', 'P', 'error', 'fallback', 'in'),
        edge('e3', 'fallback', 'out', 'output', 'in'),
      ],
      'P',
    );
    doc.limits = { ...DEFAULT_LIMITS, maxDelegationDepth: 3 };
    expect(CorralDefinition.safeParse(doc).success).toBe(true);
    expect(errorsOf(doc)).toEqual([]);
    // Retries and the error port run; only the deeper delegation limit does not yet.
    const unsupported = warningsOf(doc).filter((d) => d.code === 'RUNTIME_UNSUPPORTED');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]?.nodeId).toBeUndefined();
  });
});

describe('team graph: reference teams', () => {
  /** X: plan → T (reference) → output */
  const withReference = (corralId: string, id = 'x'): Doc =>
    definition(
      [
        agent('plan'),
        {
          id: 'T',
          type: 'team',
          label: 'T',
          source: { kind: 'reference', corralId, definitionRevision: 1 },
        },
        output('plan'),
      ],
      [edge('e1', 'plan', 'out', 'T', 'enter'), edge('e2', 'T', 'next', 'output', 'in')],
      'plan',
      id,
    );

  it('refuses a reference it cannot find', () => {
    const options: CompileOptions = { resolveTeam: () => undefined };
    expect(errorsOf(withReference('missing'), options)).toContainEqual(
      expect.objectContaining({ code: 'TEAM_REF_NOT_FOUND', nodeId: 'T' }),
    );
  });

  it('refuses references that come back around', () => {
    const teams: Record<string, Doc> = { x: withReference('y', 'x'), y: withReference('x', 'y') };
    const options: CompileOptions = {
      resolveTeam: (corralId) => teams[corralId] as CorralDefinition | undefined,
    };
    expect(errorsOf(teams.x, options)).toContainEqual(
      expect.objectContaining({ code: 'TEAM_REF_CYCLE', nodeId: 'T' }),
    );
  });

  it('compiles a reference to a team that resolves', () => {
    const inner = definition(
      [agent('solo'), output('solo')],
      [edge('e1', 'solo', 'out', 'output', 'in')],
      'solo',
      'y',
    );
    const options: CompileOptions = { resolveTeam: () => inner as CorralDefinition };
    expect(errorsOf(withReference('y'), options)).toEqual([]);
    const plan = compile(withReference('y'), options);
    if (!plan.ok) return;
    expect(plan.plan.references.T).toMatchObject({ corralId: 'y', definitionRevision: 1 });
    expect(plan.plan.references.T?.plan.order).toEqual(['solo', 'output']);
  });

  it('counts a reference to another revision of the same team as a cycle', () => {
    const options: CompileOptions = { resolveTeam: () => withReference('z', 'x') };
    expect(errorsOf(withReference('x', 'x'), options)).toContainEqual(
      expect.objectContaining({ code: 'TEAM_REF_CYCLE', nodeId: 'T' }),
    );
  });

  it('refuses a referenced team that does not compile on its own', () => {
    const broken = definition([agent('solo'), output('solo')], [], 'solo', 'y');
    const options: CompileOptions = { resolveTeam: () => broken };
    expect(errorsOf(withReference('y'), options)).toContainEqual(
      expect.objectContaining({ code: 'TEAM_REF_INVALID', nodeId: 'T' }),
    );
  });
});

describe('team graph: team inputs', () => {
  /** plan → T (reference to y, reading plan) → after (reading T) → output */
  const reading = (source: Doc): Doc =>
    definition(
      [
        agent('plan'),
        { ...source, id: 'T', type: 'team', label: 'T' },
        agent('after', { inputBindings: from('T') }),
        output('after'),
      ],
      [
        edge('e1', 'plan', 'out', 'T', 'enter'),
        edge('e2', 'T', 'next', 'after', 'in'),
        edge('e3', 'after', 'out', 'output', 'in'),
      ],
      'plan',
    );
  const saved = definition(
    [agent('solo'), output('solo')],
    [edge('e1', 'solo', 'out', 'output', 'in')],
    'solo',
    'y',
  );
  const options: CompileOptions = { resolveTeam: () => saved };
  const reference = {
    source: { kind: 'reference', corralId: 'y', definitionRevision: 1 },
    inputBindings: from('plan'),
  };

  it('lets a reference Team take inputs and be read by the steps after it', () => {
    const doc = reading(reference);
    expect(CorralDefinition.safeParse(doc).success).toBe(true);
    expect(errorsOf(doc, options)).toEqual([]);
  });

  it('checks a reference Team input like any other input', () => {
    const doc = reading({ ...reference, inputBindings: from('after') });
    expect(errorsOf(doc, options)).toContainEqual(
      expect.objectContaining({ code: 'BINDING_SOURCE', nodeId: 'T' }),
    );
  });

  it('refuses inputs on an inline Team, and reading an inline Team', () => {
    const doc = inlineTeam();
    doc.nodes.find((n: Doc) => n.id === 'T').inputBindings = from('P');
    expect(errorsOf(doc)).toContainEqual(
      expect.objectContaining({ code: 'TEAM_INPUTS_INLINE', nodeId: 'T' }),
    );
    const read = inlineTeam();
    read.nodes.push(agent('after', { inputBindings: from('T') }));
    read.nodes.find((n: Doc) => n.id === 'output').inputBindings = from('after');
    read.controlEdges = read.controlEdges.map((e: Doc) =>
      e.id === 'e4' ? { ...e, target: 'after' } : e,
    );
    read.controlEdges.push(edge('e5', 'after', 'out', 'output', 'in'));
    expect(errorsOf(read)).toContainEqual(
      expect.objectContaining({ code: 'BINDING_SOURCE', nodeId: 'after' }),
    );
  });
});

describe('team graph: what runs today', () => {
  it('keeps a single-loop team runnable with no unsupported warnings', () => {
    const result = compile(researchTeam);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(codes(result.diagnostics)).not.toContain('RUNTIME_UNSUPPORTED');
    expect(planRun(researchTeam).ok).toBe(true);
  });

  it('runs an inline Team', () => {
    expect(codes(warningsOf(inlineTeam()))).not.toContain('RUNTIME_UNSUPPORTED');
    expect(planRun(inlineTeam()).ok).toBe(true);
  });

  it('refuses to plan a run for a definition the runtime does not execute', () => {
    const saved = definition(
      [agent('solo'), output('solo')],
      [edge('e1', 'solo', 'out', 'output', 'in')],
      'solo',
      'y',
    );
    const plan = planRun(referenced(), { resolveTeam: () => saved });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ code: 'RUNTIME_UNSUPPORTED', nodeId: 'T' }),
    );
  });

  it('rejects starting such a run with the same code, without creating a run', async () => {
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    const transport = new InProcessTransport(coordinator);
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_depth',
      definition: {
        ...inlineTeam(),
        limits: { ...DEFAULT_LIMITS, maxDelegationDepth: 3 },
      } as CorralDefinition,
      mode: 'mock',
    });
    expect(runId).toBeNull();
    expect(receipt.status).toBe('rejected');
    expect(receipt.error?.code).toBe('RUNTIME_UNSUPPORTED');
  });

  it('resolves a reference team from saved teams at run start and refuses it as not runnable yet', async () => {
    const inner = definition(
      [agent('solo'), output('solo')],
      [edge('e1', 'solo', 'out', 'output', 'in')],
      'solo',
      'y',
    );
    const outer = definition(
      [
        agent('plan'),
        {
          id: 'T',
          type: 'team',
          label: 'T',
          source: { kind: 'reference', corralId: 'y', definitionRevision: 1 },
        },
        output('plan'),
      ],
      [edge('e1', 'plan', 'out', 'T', 'enter'), edge('e2', 'T', 'next', 'output', 'in')],
      'plan',
    );
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      corrals: {
        getDefinition: (corralId, revision) =>
          corralId === 'y' && revision === 1 ? (inner as CorralDefinition) : null,
      },
    });
    const { runId, receipt } = await new InProcessTransport(coordinator).startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_reference',
      definition: outer as CorralDefinition,
      mode: 'mock',
    });
    expect(runId).toBeNull();
    expect(receipt.error?.code).toBe('RUNTIME_UNSUPPORTED');
  });
});
