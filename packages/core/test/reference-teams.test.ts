import {
  type CorralDefinition,
  DEFAULT_LIMITS,
  CorralDefinition as Definition,
} from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  InProcessTransport,
  planRun,
  type RunProjection,
  reviewCriteriaHash,
  waitForProjection,
} from '../src/index.ts';

// Reference Teams expand at run start (docs/specs/features/team-graph.md, "팀 실행").

// biome-ignore lint/suspicious/noExplicitAny: test documents are built loosely, then parsed.
type Doc = any;

const role = (id: string) => ({
  id,
  name: id,
  prompt: `Act as ${id}.`,
  modelProfile: 'model-a',
  allowedWorkTools: ['write_artifact'],
  allowedCollaborationTools: ['submit_result'],
  outputContract: 'text',
});
const brief = [{ kind: 'run_input', name: 'brief' }];
const from = (sourceNodeId: string, name = 'input') => [
  { kind: 'task_output', name, sourceNodeId },
];
const agent = (id: string, inputBindings: Doc[] = brief, roleId = 'worker'): Doc => ({
  id,
  type: 'agent',
  label: id,
  roleId,
  invocation: 'scheduled',
  inputBindings,
  outputName: 'text',
});
const output = (source: string, requireApproval = false): Doc => ({
  id: 'output',
  type: 'output',
  label: 'Output',
  inputBindings: from(source, 'final'),
  requireApproval,
});
const edge = (
  id: string,
  source: string,
  sourcePort: string,
  target: string,
  targetPort = 'in',
) => ({
  id,
  source,
  sourcePort,
  target,
  targetPort,
});
const definition = (
  id: string,
  nodes: Doc[],
  controlEdges: Doc[],
  entryNodeId: string,
  roles = [role('worker')],
): CorralDefinition =>
  Definition.parse({
    schemaVersion: '0.1',
    id,
    name: id,
    entryNodeId,
    input: { brief: `Brief of ${id}.`, criteria: [`Criteria of ${id}.`] },
    roles,
    nodes,
    controlEdges,
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
  });
const reference = (id: string, corralId: string, extra: Doc = {}): Doc => ({
  id,
  type: 'team',
  label: id,
  source: { kind: 'reference', corralId, definitionRevision: 1 },
  ...extra,
});

/** Saved team y: W (reads the brief) → output; its own role is called writer. */
const saved = (requireApproval = false) =>
  definition(
    'y',
    [agent('W', brief, 'writer'), output('W', requireApproval)],
    [edge('e1', 'W', 'out', 'output')],
    'W',
    [role('writer')],
  );

/** P → T (reference to y, reading P) → Q (reading T) → output */
const outer = (team: Doc = reference('T', 'y', { inputBindings: from('P', 'plan') })) =>
  definition(
    'x',
    [agent('P'), team, agent('Q', from('T', 'work')), output('Q')],
    [
      edge('e1', 'P', 'out', 'T', 'enter'),
      edge('e2', 'T', 'next', 'Q'),
      edge('e3', 'Q', 'out', 'output'),
    ],
    'P',
  );

const plan = (doc: CorralDefinition, teams: Record<string, CorralDefinition>) =>
  planRun(doc, { resolveTeam: (corralId) => teams[corralId] });
const node = (doc: CorralDefinition, id: string) => doc.nodes.find((n) => n.id === id);

describe('reference teams: expansion', () => {
  it('copies the saved team into the Team with prefixed ids and runs it as an inline Team', () => {
    const planned = plan(outer(), { y: saved() });
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
    const run = planned.definition;
    expect(node(run, 'T')).toMatchObject({ type: 'team', source: { kind: 'inline' } });
    expect(node(run, 'T')).not.toHaveProperty('inputBindings');
    // The saved team's member and role, named under the Team; its Output is gone.
    expect(node(run, 'T.W')).toMatchObject({ parentId: 'T', roleId: 'T.writer' });
    expect(node(run, 'T.output')).toBeUndefined();
    expect(run.roles.map((r) => r.id)).toEqual(['worker', 'T.writer']);
    expect(run.controlEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'T', sourcePort: 'body', target: 'T.W' }),
        expect.objectContaining({
          source: 'T.W',
          sourcePort: 'out',
          target: 'T',
          targetPort: 'exit',
        }),
      ]),
    );
    // The member reads the Team's input instead of the brief; Q reads what the Output collected.
    expect(node(run, 'T.W')).toMatchObject({ inputBindings: from('P', 'plan') });
    expect(node(run, 'Q')).toMatchObject({ inputBindings: from('T.W', 'work') });
    // The run keeps its own input and limits.
    expect(run.input.brief).toBe('Brief of x.');
  });

  it('reads the run brief when the Team takes no inputs', () => {
    const planned = plan(outer(reference('T', 'y')), { y: saved() });
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
    expect(node(planned.definition, 'T.W')).toMatchObject({ inputBindings: brief });
  });

  it('puts an approval where the saved Output asked for one', () => {
    const planned = plan(outer(), { y: saved(true) });
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
    const run = planned.definition;
    expect(node(run, 'T.output')).toMatchObject({
      type: 'decision',
      mode: 'approval',
      parentId: 'T',
      inputBindings: from('T.W', 'final'),
    });
    expect(run.controlEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'T.W', target: 'T.output' }),
        expect.objectContaining({
          source: 'T.output',
          sourcePort: 'approve',
          target: 'T',
          targetPort: 'exit',
        }),
      ]),
    );
  });

  it('expands a reference inside a referenced team', () => {
    const middle = definition(
      'm',
      [reference('U', 'y'), agent('A', from('U', 'got')), output('A')],
      [edge('e1', 'U', 'next', 'A'), edge('e2', 'A', 'out', 'output')],
      'U',
    );
    const planned = plan(outer(reference('T', 'm')), { m: middle, y: saved() });
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
    const run = planned.definition;
    expect(node(run, 'T.U')).toMatchObject({ parentId: 'T', source: { kind: 'inline' } });
    expect(node(run, 'T.U.W')).toMatchObject({ parentId: 'T.U', roleId: 'T.U.writer' });
    expect(node(run, 'T.A')).toMatchObject({ inputBindings: from('T.U.W', 'got') });
    expect(node(run, 'Q')).toMatchObject({ inputBindings: from('T.A', 'work') });
  });

  it('refuses a saved team whose review recipe pins other criteria', () => {
    const reviewed = Definition.parse({
      ...saved(),
      roles: [role('writer'), { ...role('reviewer'), outputContract: 'review' }],
      nodes: [
        { id: 'L', type: 'loop', label: 'L', maxIterations: 2 },
        { ...agent('W', brief, 'writer'), parentId: 'L' },
        {
          ...agent(
            'R',
            [...from('W', 'draft'), { kind: 'run_input', name: 'criteria' }],
            'reviewer',
          ),
          parentId: 'L',
        },
        {
          id: 'D',
          type: 'decision',
          label: 'D',
          parentId: 'L',
          mode: 'review',
          rule: 'review_verdict',
          inputBindings: from('R', 'review'),
        },
        output('W'),
      ],
      controlEdges: [
        edge('e1', 'L', 'body', 'W'),
        edge('e2', 'W', 'out', 'R'),
        edge('e3', 'R', 'out', 'D'),
        edge('e4', 'D', 'pass', 'L', 'exit'),
        edge('e5', 'D', 'revise', 'L', 'repeat'),
        edge('e6', 'L', 'next', 'output'),
      ],
      entryNodeId: 'L',
    });
    const recipeLoop = reviewed.nodes.find((n) => n.id === 'L');
    if (recipeLoop?.type !== 'loop') throw new Error('loop');
    recipeLoop.reviewRecipe = {
      recipeId: 'r',
      revision: 1,
      criteriaHash: reviewCriteriaHash(reviewed.input.criteria),
      candidateNodeId: 'W',
      evaluatorRoleId: 'reviewer',
      criteriaFiles: [],
      checkIds: [],
      maxAttempts: 2,
      maxRepairs: 1,
      maxWallMs: 10000,
      maxModelCalls: 20,
      maxOutputTokens: 20000,
    };
    expect(plan(reviewed, {}).ok).toBe(true);
    const planned = plan(outer(), { y: reviewed });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.issues).toContainEqual(
      expect.objectContaining({ code: 'GRAPH_INVALID', nodeId: 'T.L' }),
    );
  });
});

describe('reference teams: running', () => {
  const finished = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
  const start = async (teams: Record<string, CorralDefinition>, doc = outer()) => {
    const transport = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
        corrals: {
          getDefinition: (corralId, revision) => (revision === 1 ? teams[corralId] : null) ?? null,
        },
      }),
    );
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: `cmd_${Math.random()}`,
      definition: doc,
      mode: 'mock',
    });
    if (!runId) throw new Error(JSON.stringify(receipt.error));
    return { transport, runId };
  };
  const submitted = (p: RunProjection, nodeId: string) => {
    const execution = p.executions[p.nodeExecutions[nodeId]?.at(-1) ?? ''];
    return p.tasks[execution?.taskId ?? '']?.submittedArtifactVersionIds ?? [];
  };
  const inputsOf = (p: RunProjection, nodeId: string) => {
    const executionId = p.nodeExecutions[nodeId]?.at(-1);
    return Object.values(p.modelCalls)
      .filter((call) => call.executionId === executionId)
      .flatMap((call) => call.inputArtifactVersionIds);
  };

  it('runs the expanded team between the steps around it, with the pinned definition', async () => {
    const teams = { y: saved() };
    const { transport, runId } = await start(teams);
    // A later save of the team does not reach a run that has started.
    teams.y = definition('y', [agent('Z'), output('Z')], [edge('e1', 'Z', 'out', 'output')], 'Z');
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(final.executionOrder.map((id) => final.executions[id]?.nodeId)).toEqual([
      'P',
      'T.W',
      'Q',
    ]);
    expect(inputsOf(final, 'T.W')).toEqual(expect.arrayContaining(submitted(final, 'P')));
    expect(inputsOf(final, 'Q')).toEqual(expect.arrayContaining(submitted(final, 'T.W')));
  });

  it('asks before leaving the team when its Output asked for approval', async () => {
    const { transport, runId } = await start({ y: saved(true) });
    const waiting = await waitForProjection(transport, runId, (p) =>
      Object.values(p.approvals).some((a) => a.status === 'pending'),
    );
    const approval = Object.values(waiting.approvals).find((a) => a.status === 'pending');
    // The team's work is done and the step after it waits for the approval.
    expect(approval?.subjectVersionIds).toEqual(submitted(waiting, 'T.W'));
    expect(waiting.nodeExecutions.Q).toBeUndefined();
    await transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'reject_team',
      runId,
      type: 'resolve_approval',
      expectedControlRevision: waiting.controlRevision,
      payload: {
        approvalId: approval?.approvalId ?? '',
        decision: 'reject',
        subjectVersionId: approval?.subjectVersionIds[0] ?? '',
      },
    });
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('cancelled');
    expect(final.executionOrder.map((id) => final.executions[id]?.nodeId)).not.toContain('Q');
  });
});
