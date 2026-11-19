import { type CorralDefinition, isWorkAgent, type OutputNode } from '@corral/contracts';
import {
  Coordinator,
  type CoordinatorDeps,
  compileDefinition,
  InMemoryRunStore,
  InProcessTransport,
  planRun,
  waitForProjection,
} from '@corral/core';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import { draftFromDefinition, exportDefinition, importDefinition } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import { applyPattern, setRequiredOutputReview } from '../src/team-editor/commands.ts';

function setup() {
  const initial = linearCorral(['planner', 'writer']);
  initial.sharedOutrider = {
    modelProfile: 'critic',
    principles: 'Check the source.',
    targets: { kind: 'all' },
  };
  const draft = draftFromDefinition(initial);
  const added = setRequiredOutputReview(draft, 'output', 'final', 'writer', true);
  if (!added.ok) throw new Error(added.reason);
  const output = added.draft.definition.nodes.find(
    (node): node is OutputNode => node.type === 'output',
  )!;
  return { draft, next: added.draft, output, gate: output.requiredReviews![0]! };
}

function start(
  definition: CorralDefinition,
  review?: ScriptedAgentOptions['review'],
  extra?: Partial<ScriptedAgentOptions>,
  overrides: Partial<CoordinatorDeps> = {},
) {
  const store = new InMemoryRunStore();
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    ...overrides,
    store,
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      reply: (_turn, input) => `${input.nodeId}: revision ${input.round}`,
      ...(review ? { review } : {}),
      ...extra,
    }),
  });
  const transport = new InProcessTransport(coordinator);
  const receipt = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition,
    mode: 'mock',
  });
  const runId = receipt.runId ?? '';
  const end = () =>
    waitForProjection(transport, runId, (p) =>
      ['succeeded', 'failed', 'cancelled'].includes(p.status),
    );
  return { store, coordinator, transport, receipt, runId, end };
}

it('installs an atomic version-bound review around the original writer and preserves independent approval', () => {
  const { draft, next, gate, output } = setup();
  const store = createEditorStore(draft);
  store.getState().applyDraft(next);
  expect(store.getState().past).toEqual([draft]);
  const reviewer = next.definition.nodes.find((n) => n.id === gate.reviewerNodeId);
  const role =
    reviewer?.type === 'agent' && next.definition.roles.find((r) => r.id === reviewer.roleId);
  expect(role).toMatchObject({
    modelProfile: 'critic',
    prompt: 'Check the source.',
    outputContract: 'review',
  });
  expect(output.requireApproval).toBe(false);
  expect(output.inputBindings).toEqual([
    { kind: 'task_output', name: 'final', sourceNodeId: 'writer', bindingId: gate.bindingId },
  ]);
  expect(compileDefinition(next.definition).diagnostics).toEqual([]);
  expect(importDefinition(exportDefinition(next))).toMatchObject({
    ok: true,
    draft: { definition: next.definition },
  });
  const unchanged = setRequiredOutputReview(next, 'output', 'final', 'writer', true);
  expect(unchanged.ok && unchanged.draft).toBe(next);
  const disabled = setRequiredOutputReview(next, 'output', 'final', 'writer', false);
  if (!disabled.ok) throw Error(disabled.reason);
  expect(disabled.draft.definition.nodes.map((n) => n.id)).toEqual(
    draft.definition.nodes.map((n) => n.id),
  );
  expect(compileDefinition(disabled.draft.definition).ok).toBe(true);
  store.getState().undo();
  expect(store.getState().draft).toBe(draft);
});

it.each(['exhausted', 'outside', 'changed source'] as const)(
  'diagnoses a %s bypass and prevents the same server start',
  (invalid) => {
    const { next, gate, output } = setup();
    if (invalid === 'changed source') output.inputBindings[0]!.sourceNodeId = 'planner';
    else
      next.definition.controlEdges.push({
        id: 'bypass',
        source: invalid === 'outside' ? 'planner' : gate.loopNodeId,
        sourcePort: invalid === 'outside' ? 'error' : 'exhausted',
        target: 'output',
        targetPort: 'in',
      });
    const result = compileDefinition(next.definition);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'REQUIRED_OUTPUT_REVIEW',
        ...(invalid === 'changed source' ? { nodeId: 'output' } : { edgeId: 'bypass' }),
      }),
    );
    expect(start(next.definition).receipt.runId).toBeNull();
  },
);

it('revises V1, reviews V2, and finalizes only the submitted V2 authored by the writer', async () => {
  const { next, gate } = setup();
  const s = start(next.definition, (input) => (input.round === 1 ? 'revise' : 'pass'));
  const p = await s.end();
  expect(p.status).toBe('succeeded');
  const reviews = Object.values(p.reviews);
  expect(reviews.map((r) => r.verdict)).toEqual(['revise', 'pass']);
  expect(reviews[0]?.targetVersionId).not.toBe(reviews[1]?.targetVersionId);
  const version = reviews[1]!.targetVersionId;
  expect(p.output?.artifactVersionIds).toEqual([version]);
  expect(p.executions[p.artifacts[version]!.authorExecutionId]!.nodeId).toBe('writer');
  expect(
    Object.values(p.workflowBranches ?? {})
      .filter((b) => b.nodeId === gate.decisionNodeId)
      .map((b) => b.selectedPort),
  ).toEqual(['revise', 'pass']);
});

it.each(['revise', 'inconclusive', 'invalid'] as const)(
  'never publishes an unreviewed version after %s',
  async (verdict) => {
    const { next } = setup();
    const s = start(next.definition, () => verdict);
    const p = await s.end();
    expect(p.status).toBe('failed');
    expect(p.output).toBeNull();
    expect(Object.values(p.artifacts).length).toBeGreaterThan(0);
    expect(s.store.readEvents(s.runId, 0).some((e) => e.type === 'output.finalized')).toBe(false);
    expect(Object.values(p.approvals)).toEqual([]);
  },
);

it('refuses an earlier version claimed by a later reviewer', async () => {
  const { next } = setup();
  let first = '';
  const s = start(next.definition, (input) => {
    const candidate = input.inputs.find(
      (i) => i.kind === 'task_output' && i.artifactVersionId,
    )?.artifactVersionId;
    if (input.round === 1) {
      first = candidate ?? '';
      return 'revise';
    }
    return JSON.stringify({
      verdict: 'pass',
      targetArtifactVersionId: first,
      criteriaVersionId: input.criteriaVersionId,
      evidenceRefs: [],
      issues: [],
    });
  });
  const p = await s.end();
  expect(first).not.toBe('');
  expect(p.status).toBe('failed');
  expect(p.output).toBeNull();
});

it('keeps a separate human final approval and cancelling during approval never finalizes', async () => {
  const { next, output } = setup();
  output.requireApproval = true;
  const s = start(next.definition, () => 'pass');
  const waiting = await waitForProjection(
    s.transport,
    s.runId,
    (p) => p.status === 'awaiting_user',
  );
  const approval = Object.values(waiting.approvals).find((a) => a.kind === 'final_output');
  expect(approval?.status).toBe('pending');
  expect(Object.values(waiting.reviews).map((r) => r.verdict)).toEqual(['pass']);
  expect(waiting.output).toBeNull();
  await s.transport.sendCommand({
    schemaVersion: '0.1',
    commandId: 'cancel',
    type: 'cancel',
    runId: s.runId,
    payload: { scope: { kind: 'run' }, reason: 'Stop' },
  });
  expect((await s.end()).status).toBe('cancelled');
  expect(s.store.readEvents(s.runId, 0).some((e) => e.type === 'output.finalized')).toBe(false);
});

it('does not finalize after the reviewer fails or while its execution is stopped', async () => {
  const { next, gate } = setup();
  const error = start(next.definition, () => 'pass', {
    beforeReply: async (_n, input) => {
      if (input.nodeId === gate.reviewerNodeId) throw Error('review unavailable');
    },
  });
  expect((await error.end()).status).toBe('failed');
  expect(error.store.readEvents(error.runId, 0).some((e) => e.type === 'output.finalized')).toBe(
    false,
  );
  const entered = new Gate(),
    release = new Gate();
  const cancelled = start(next.definition, () => 'pass', {
    beforeReply: async (_n, input) => {
      if (input.nodeId === gate.reviewerNodeId) {
        entered.open();
        await release.wait();
      }
    },
  });
  await entered.wait();
  const stopping = cancelled.transport.sendCommand({
    schemaVersion: '0.1',
    commandId: 'cancel',
    type: 'cancel',
    runId: cancelled.runId,
    payload: { scope: { kind: 'run' }, reason: 'Stop' },
  });
  release.open();
  await stopping;
  expect((await cancelled.end()).status).toBe('cancelled');
  expect(
    cancelled.store.readEvents(cancelled.runId, 0).some((e) => e.type === 'output.finalized'),
  ).toBe(false);
});

it('separates two bindings of the same producer and retains the remaining review when one is disabled', () => {
  const { next, output, gate } = setup();
  output.inputBindings.push({ kind: 'task_output', name: 'also', sourceNodeId: 'writer' });
  const result = setRequiredOutputReview(next, 'output', 'also', 'writer', true);
  if (!result.ok) throw Error(result.reason);
  const removed = setRequiredOutputReview(result.draft, 'output', 'final', 'writer', false);
  if (!removed.ok) throw Error(removed.reason);
  const rest = removed.draft.definition.nodes.find((n) => n.type === 'output');
  const kept = rest?.inputBindings.find((b) => b.name === 'also')?.bindingId;
  expect(kept).toBeDefined();
  expect(kept).not.toBe(gate.bindingId);
  expect(rest?.requiredReviews).toEqual([{ ...gate, bindingId: kept, bindingName: 'also' }]);
  expect(compileDefinition(removed.draft.definition).ok).toBe(true);
});

it.each([false, true])(
  'preserves normal submission when on-demand artifact review is %s and mandatory review is absent',
  async (onDemand) => {
    const { draft } = setup();
    if (onDemand && draft.definition.sharedOutrider)
      draft.definition.sharedOutrider.artifactReview = true;
    const run = start(draft.definition);
    const p = await run.end();
    expect(p.status).toBe('succeeded');
    expect(p.reviews).toEqual({});
    expect(p.output?.artifactVersionIds).toHaveLength(1);
  },
);

it('refuses to finalize a new writer version even after V1 passed', async () => {
  const { next, gate } = setup();
  const s = start(
    next.definition,
    () => 'pass',
    {},
    {
      runner: {
        run: async (_plan, c) => {
          await c.activate('planner', null);
          const first = { loopId: gate.loopNodeId, no: 1 };
          await c.loopEntered(first.loopId, 1);
          await c.activate('writer', first);
          await c.activate(gate.reviewerNodeId, first);
          expect(await c.decide(gate.decisionNodeId, first)).toBe('pass');
          await c.loopLeft(first.loopId, 1, 'pass');
          const second = { ...first, no: 2 };
          await c.loopEntered(second.loopId, 2);
          await c.activate('writer', second);
          await c.finalize('output');
          return { kind: 'finished', outputNodeId: 'output' };
        },
      },
    },
  );
  const p = await s.end();
  expect(Object.values(p.reviews).some((r) => r.verdict === 'pass')).toBe(true);
  expect(p.nodeExecutions.writer).toHaveLength(2);
  expect(p.status).toBe('failed');
  expect(p.output).toBeNull();
});

function referenceTeam() {
  const team = linearCorral(['planner', 'writer']);
  return {
    ...team,
    id: 'outer',
    nodes: team.nodes.map((n) =>
      n.id === 'writer'
        ? {
            id: 'writer',
            label: 'Writers',
            type: 'team' as const,
            source: { kind: 'reference' as const, corralId: 'inner', definitionRevision: 1 },
          }
        : n,
    ),
    controlEdges: team.controlEdges.map((e) => ({
      ...e,
      targetPort: e.target === 'writer' ? ('enter' as const) : e.targetPort,
      sourcePort: e.source === 'writer' ? ('next' as const) : e.sourcePort,
    })),
  };
}

it('keeps required reviews enforced within an expanded pinned team', async () => {
  const { next } = setup();
  const outer = referenceTeam();
  const defs = {
    getDefinition: (id: string, rev: number) =>
      id === 'inner' && rev === 1 ? next.definition : null,
  };
  const run = start(outer, () => 'inconclusive', {}, { corrals: defs });
  expect(run.receipt.receipt.status).toBe('applied');
  expect((await run.end()).status).toBe('failed');
  expect(run.store.readEvents(run.runId, 0).some((e) => e.type === 'output.finalized')).toBe(false);
});

it('expands only the selected duplicate input of a reference with two distinct results', () => {
  const inner = linearCorral(['first', 'second'], 'inner');
  const innerOutput = inner.nodes.find((n) => n.type === 'output')!;
  innerOutput.inputBindings.push({ kind: 'task_output', name: 'first', sourceNodeId: 'first' });
  const draft = draftFromDefinition({
    ...referenceTeam(),
    sharedOutrider: { modelProfile: 'model-a', principles: 'Review.', targets: { kind: 'all' } },
  });
  const outer = draft.definition.nodes.find((n) => n.type === 'output')!;
  outer.inputBindings.push({ ...outer.inputBindings[0]! });
  const enabled = setRequiredOutputReview(draft, 'output', 'final', 'writer', true, 1);
  if (!enabled.ok) throw Error(enabled.reason);
  const planned = planRun(enabled.draft.definition, { resolveTeam: () => inner });
  if (!planned.ok) throw Error(JSON.stringify(planned.issues));
  const result = planned.definition.nodes.find((n) => n.type === 'output')!;
  expect(result.inputBindings.map((b) => b.sourceNodeId)).toEqual([
    'writer.second',
    'writer.first',
    'writer.second',
    'writer.first',
  ]);
  const ids = result.inputBindings.map((b) => b.bindingId);
  expect(new Set(ids).size).toBe(4);
  expect(result.requiredReviews?.map((g) => g.bindingId)).toEqual(ids.slice(2));
});

it('reviews an output from a pinned team without modifying its saved revision', async () => {
  const author = linearCorral(['author'], 'inner');
  const draft = draftFromDefinition({
    ...referenceTeam(),
    sharedOutrider: { modelProfile: 'model-a', principles: 'Review.', targets: { kind: 'all' } },
  });
  const enabled = setRequiredOutputReview(draft, 'output', 'final', 'writer', true);
  if (!enabled.ok) throw Error(enabled.reason);
  const resolve = (id: string, rev: number) => (id === 'inner' && rev === 1 ? author : null);
  const planned = planRun(enabled.draft.definition, { resolveTeam: resolve });
  if (!planned.ok) throw Error(JSON.stringify(planned.issues));
  const reviewer = planned.definition.nodes.find(
    (n) => n.type === 'agent' && n.label === 'Reviewer',
  );
  expect(reviewer).toBeDefined();
  let receivedFeedback = false;
  const run = start(
    enabled.draft.definition,
    (input) => (input.round === 1 ? 'revise' : 'pass'),
    {
      beforeReply: async (_n, input) => {
        if (input.nodeId === 'writer.author' && input.round === 2)
          receivedFeedback = input.inputs.some((i) => i.name === 'review' && i.artifactVersionId);
      },
    },
    { corrals: { getDefinition: resolve } },
  );
  const p = await run.end();
  expect(p.status).toBe('succeeded');
  expect(
    p.executions[p.artifacts[p.output!.artifactVersionIds[0]!]!.authorExecutionId]!.nodeId,
  ).toBe('writer.author');
  expect(receivedFeedback).toBe(true);
  expect(author).toEqual(linearCorral(['author'], 'inner'));
});

it('keeps a required review runnable when the selected producer starts the entire workflow', () => {
  const only = linearCorral(['writer']);
  only.sharedOutrider = setup().draft.definition.sharedOutrider;
  const enabled = setRequiredOutputReview(
    draftFromDefinition(only),
    'output',
    'final',
    'writer',
    true,
  );
  if (!enabled.ok) throw Error(enabled.reason);
  expect(compileDefinition(enabled.draft.definition).diagnostics).toEqual([]);
  const run = planRun(enabled.draft.definition);
  if (!run.ok) throw Error(JSON.stringify(run.issues));
});

it('accepts an all join after the reviewed branch and identifies a bypass through an any join', () => {
  const { draft } = setup();
  const split = applyPattern(draft, 'parallel', ['writer']);
  if (!split.ok) throw Error(split.reason);
  const enabled = setRequiredOutputReview(split.draft, 'output', 'final', 'writer', true);
  if (!enabled.ok) throw Error(enabled.reason);
  const definition = enabled.draft.definition;
  expect(compileDefinition(definition).diagnostics).toEqual([]);
  const join = definition.nodes.find((n) => n.type === 'join')!;
  join.policy = 'any';
  expect(compileDefinition(definition).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'REQUIRED_OUTPUT_REVIEW' }),
  );
});

it('keeps a writer’s existing review input and supplies this gate’s feedback under a free name', async () => {
  const { draft } = setup();
  const writer = draft.definition.nodes.find((n) => n.id === 'writer');
  if (!isWorkAgent(writer)) throw Error('missing fixture writer');
  writer.inputBindings.push({ kind: 'task_output', name: 'review', sourceNodeId: 'planner' });
  const enabled = setRequiredOutputReview(draft, 'output', 'final', 'writer', true);
  if (!enabled.ok) throw Error(enabled.reason);
  const source = enabled.draft.definition.nodes.find((n) => n.id === 'writer');
  expect(isWorkAgent(source) && source.inputBindings).toEqual(
    expect.arrayContaining([
      { kind: 'task_output', name: 'review', sourceNodeId: 'planner' },
      expect.objectContaining({
        kind: 'previous_iteration_output',
        name: 'review_2',
        optional: true,
      }),
    ]),
  );
  expect(compileDefinition(enabled.draft.definition).diagnostics).toEqual([]);
});

it('delivers each submitted candidate and its review protocol even when the person only wrote human principles', async () => {
  const { next, gate } = setup();
  const reviewer = next.definition.nodes.find((n) => n.id === gate.reviewerNodeId);
  if (reviewer?.type !== 'agent' || reviewer.invocation !== 'scheduled')
    throw Error('Missing test reviewer');
  reviewer.inputBindings.push({ kind: 'task_output', name: 'notes', sourceNodeId: 'planner' });
  const candidates: string[] = [];
  const run = start(next.definition, undefined, {
    script: async (input, host) => {
      if (input.nodeId !== 'writer' && input.nodeId !== gate.reviewerNodeId) return null;
      const versions: string[] = [];
      async function write(text: string) {
        const response = await host.invokeTool({ name: 'write_artifact', args: { text } });
        if (!response.ok) throw Error('write failed');
        versions.push(String(response.result.artifactVersionId));
      }
      if (input.nodeId === 'writer') {
        for (const text of ['First page.', 'Second page.']) await write(text);
        candidates.push(...versions);
      } else {
        const docs = input.inputs.filter((i) => i.name === 'draft');
        expect(docs.map((d) => d.text)).toEqual(['First page.', 'Second page.']);
        expect(input.role.prompt).toContain('Check the source.');
        const protocol = input.inputs.find((i) => i.name === 'required_review');
        for (const id of candidates) expect(protocol?.text).toContain(id);
        const notes = input.inputs.find((i) => i.name === 'notes')?.artifactVersionId;
        expect(notes).toBeTruthy();
        expect(protocol?.text).not.toContain(notes!);
        expect(protocol?.text).toContain(input.criteriaVersionId);
        expect(protocol?.text).toContain('submit_result');
        for (const document of docs)
          await write(
            JSON.stringify({
              targetArtifactVersionId: document.artifactVersionId,
              criteriaVersionId: input.criteriaVersionId,
              verdict: 'pass',
              issues: [],
              evidenceRefs: [],
            }),
          );
      }
      const response = await host.invokeTool({
        name: 'submit_result',
        args: { artifactVersionIds: versions },
      });
      if (!response.ok) throw Error('submit failed');
      return { outcome: 'succeeded' };
    },
  });
  const p = await run.end();
  expect(p.status, p.statusReason ?? '').toBe('succeeded');
  expect(Object.values(p.reviews).map((r) => r.targetVersionId)).toEqual(candidates);
  expect(p.output?.artifactVersionIds).toEqual(candidates);
});
