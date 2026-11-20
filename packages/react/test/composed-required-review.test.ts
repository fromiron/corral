import { type OutputNode, type RunEvent, TeamComposition } from '@corral/contracts';
import {
  Coordinator,
  compileDefinition,
  draftFromComposition,
  InProcessTransport,
  planRun,
  ROLE_PRESET_IDS,
  type RunProjection,
  roleFromPreset,
  teamCatalog,
  waitForProjection,
} from '@corral/core';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { draftFromDefinition } from '../src/editor/model.ts';
import { setRequiredOutputReview } from '../src/team-editor/commands.ts';

// A composed team that asks for a required review gets it from the editor's own command once the
// person confirms a received result (docs/specs/features/team-assistant.md, "필수 통과"). Every
// result of a composed team's Output must take it, whatever its last step.

const resolved = teamCatalog(
  ROLE_PRESET_IDS.map((id) => {
    const { id: _id, ...role } = roleFromPreset(id, id, `${id} agent`);
    return { role, origin: { kind: 'preset' as const, presetId: id }, builtin: true };
  }),
  [],
);
const agent = (name: string) =>
  resolved.catalog.agents.find((a) => a.name === `${name} agent`)?.id as string;
const seat = (id: string, name: string) => ({
  id,
  agent: agent(name),
  name: id,
  duty: `Do ${id}.`,
});
const labels = {
  loop: 'Review loop',
  decision: 'Review decision',
  join: 'Gather',
  output: 'Output',
};
const gate = { loop: '제출 전 검토', reviewer: '제출 전 검토자', decision: '제출 전 판정' };

const composed = (seats: ReturnType<typeof seat>[], flow: unknown) =>
  draftFromDefinition(
    draftFromComposition(
      TeamComposition.parse({
        name: 'Composed',
        brief: 'Ship it.',
        criteria: ['Do what the brief asks.'],
        seats,
        flow,
        outrider: 'required_review',
      }),
      'composed_1',
      resolved,
      labels,
    ),
  );

describe('a required review on a composed team', () => {
  it.each([
    [
      'a loop',
      [seat('plan', 'architect'), seat('write', 'writer'), seat('check', 'reviewer')],
      [{ seat: 'plan' }, { loop: { work: ['write'], judge: 'check' } }],
    ],
    [
      'a group side by side',
      [seat('plan', 'architect'), seat('a', 'researcher'), seat('b', 'explainer')],
      [{ seat: 'plan' }, { parallel: ['a', 'b'] }],
    ],
    [
      'a group side by side that is also the first step',
      [seat('a', 'researcher'), seat('b', 'explainer')],
      [{ parallel: ['a', 'b'] }],
    ],
  ] as const)('whose last step is %s takes it on every received result', (_name, seats, flow) => {
    const draft = composed([...seats], flow);
    const output = draft.definition.nodes.find((n): n is OutputNode => n.type === 'output');
    if (!output) throw new Error('no Output');
    expect(output.inputBindings.length).toBeGreaterThan(0);
    for (const [index, binding] of output.inputBindings.entries()) {
      const result = setRequiredOutputReview(
        draft,
        output.id,
        binding.name,
        binding.sourceNodeId as string,
        gate,
        index,
      );
      if (!result.ok) throw new Error(`result ${index}: ${result.reason}`);
      const reviewed = result.draft.definition.nodes.find(
        (n): n is OutputNode => n.type === 'output',
      );
      expect(reviewed?.requiredReviews).toHaveLength(1);
      expect(reviewed?.requiredReviews?.[0]).toMatchObject({ sourceNodeId: binding.sourceNodeId });
      const compiled = compileDefinition(result.draft.definition, {
        knownModelProfiles: ['model-a', 'model-b'],
      });
      expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(planRun(result.draft.definition).ok).toBe(true);
    }
  });

  // docs/specs/technical-design.md §9.2, features/shared-outrider.md "제출 전 필수 검토": a gate
  // around the last work of a judged loop. The judge's revise reaches the work, which continues
  // from its own last result; the gate reviewer's revise stays inside the gate's entry.
  it('around a judged loop’s last work: the judge’s revise brings the review and the work’s last result', async () => {
    const draft = composed(
      [seat('plan', 'architect'), seat('write', 'writer'), seat('check', 'reviewer')],
      [{ seat: 'plan' }, { loop: { work: ['write'], judge: 'check' } }],
    );
    const output = draft.definition.nodes.find((n): n is OutputNode => n.type === 'output');
    const [binding] = output?.inputBindings ?? [];
    if (!output || !binding?.sourceNodeId) throw new Error('no Output input');
    const result = setRequiredOutputReview(
      draft,
      output.id,
      binding.name,
      binding.sourceNodeId,
      gate,
      0,
    );
    if (!result.ok) throw new Error(result.reason);
    const { definition } = result.draft;
    const [required] =
      definition.nodes.find((n): n is OutputNode => n.type === 'output')?.requiredReviews ?? [];
    if (!required) throw new Error('no required review');
    const producer = required.sourceNodeId;
    const gateLoop = definition.nodes.find((n) => n.id === required.loopNodeId);
    const judgedLoop = gateLoop?.parentId ?? '';
    const judge = definition.nodes.find((n) => n.type === 'agent' && n.label === 'check')?.id ?? '';
    // The gate sits inside the judged loop and holds the judged loop's last work.
    expect(definition.nodes.find((n) => n.id === judgedLoop)?.type).toBe('loop');
    expect(definition.nodes.find((n) => n.id === producer)?.parentId).toBe(required.loopNodeId);
    expect(definition.nodes.find((n) => n.id === judge)?.parentId).toBe(judgedLoop);

    // The gate asks once for a revision in the judged loop's round 1; the judge asks once.
    const verdicts: Record<string, string[]> = {
      [required.reviewerNodeId]: ['revise', 'pass', 'pass'],
      [judge]: ['revise', 'pass'],
    };
    const given = new Map<string, Record<string, string[]>>();
    const clock = new FakeClock();
    const transport = new InProcessTransport(
      new Coordinator({
        clock,
        timers: clock,
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({
          turns: 1,
          appendNotes: false,
          beforeReply: async (turn, input) => {
            if (turn !== 1) return;
            const named: Record<string, string[]> = {};
            for (const { name, artifactVersionId } of input.inputs)
              if (artifactVersionId) named[name] = [...(named[name] ?? []), artifactVersionId];
            given.set(input.executionId, named);
          },
          review: (input) => verdicts[input.nodeId]?.shift() ?? 'pass',
        }),
      }),
    );
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_gate_in_judged_loop',
      definition,
      mode: 'mock',
    });
    if (!runId) throw new Error(JSON.stringify(receipt.error));
    const events: RunEvent[] = [];
    transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
    const final = await waitForProjection(transport, runId, (p: RunProjection) =>
      ['succeeded', 'failed', 'cancelled'].includes(p.status),
    );
    expect(final.status).toBe('succeeded');

    const runs = (nodeId: string) =>
      (final.nodeExecutions[nodeId] ?? []).map((id) => ({
        id,
        versions:
          final.tasks[final.executions[id]?.taskId ?? '']?.submittedArtifactVersionIds ?? [],
      }));
    const outcomes = (loopId: string) =>
      (final.loopIterations[loopId] ?? []).map((id) => final.iterations[id]?.outcome);
    expect(outcomes(judgedLoop)).toEqual(['revise', 'pass']);
    expect(outcomes(required.loopNodeId)).toEqual(['revise', 'pass', 'pass']);

    const [w1, w2, w3] = runs(producer);
    const [g1, g2, g3] = runs(required.reviewerNodeId);
    const [j1] = runs(judge);
    expect(runs(producer)).toHaveLength(3);
    const v = [w1, w2, w3].map((w) => w?.versions[0] ?? '?');
    const inputs = (id: string | undefined) => {
      const { draft: own, review, review_2: gateReview } = given.get(id ?? '') ?? {};
      return { own, review, gateReview };
    };
    // Judged round 1, gate round 1: nothing came before.
    expect(inputs(w1?.id)).toEqual({ own: undefined, review: undefined, gateReview: undefined });
    // Gate round 2: its own draft and the gate's review of it.
    expect(inputs(w2?.id)).toEqual({ own: [v[0]], review: undefined, gateReview: g1?.versions });
    // Judged round 2, gate round 1: its last result and the judge's review, no gate feedback.
    expect(inputs(w3?.id)).toEqual({ own: [v[1]], review: j1?.versions, gateReview: undefined });

    const pins = (loopId: string) =>
      events.flatMap((e) =>
        e.type === 'loop.iteration_started' && e.payload.loopNodeId === loopId
          ? [e.payload.pinnedCarryInputs]
          : [],
      );
    expect(pins(judgedLoop)).toEqual([[], [v[1], ...(j1?.versions ?? [])]]);
    expect(pins(required.loopNodeId)).toEqual([[], [v[0], ...(g1?.versions ?? [])], []]);

    // The third draft revises the second: one artifact, version 3.
    const [a1, a2, a3] = v.map((id) => final.artifacts[id]);
    expect(a3?.artifactId).toBe(a1?.artifactId);
    expect([a2?.version, a3?.version, a3?.parentVersionId]).toEqual([2, 3, v[1]]);

    // The final candidate passed the gate in its own round, and only it is finalized.
    const reviews = Object.values(final.reviews);
    expect(
      reviews
        .filter((r) => [g1, g2, g3].some((g) => g?.versions.includes(r.reviewVersionId)))
        .map((r) => [r.targetVersionId, r.verdict]),
    ).toEqual([
      [v[0], 'revise'],
      [v[1], 'pass'],
      [v[2], 'pass'],
    ]);
    const lastGate = Object.values(final.workflowBranches ?? {}).findLast(
      (b) => b.nodeId === required.decisionNodeId,
    );
    expect(lastGate?.selectedPort).toBe('pass');
    expect(lastGate?.evidenceRefs).toContainEqual({ kind: 'artifact', id: v[2] });
    expect(final.output?.artifactVersionIds).toEqual([v[2]]);
  });
});
