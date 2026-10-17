import { canonicalJson, CorralDefinition, type ReviewRecipeRevision } from '@corral/contracts';
import {
  FakeClock,
  Gate,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  SequentialIdFactory,
} from '@corral/testkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import team from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  compileDefinition,
  Coordinator,
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

function fixture(overrides: Partial<ReviewRecipeRevision> = {}) {
  const definition = CorralDefinition.parse(team);
  definition.entryNodeId = 'review_loop';
  definition.roles = definition.roles.filter((role) => ['writer', 'reviewer'].includes(role.id));
  definition.nodes = definition.nodes.filter((node) =>
    ['review_loop', 'write', 'review', 'review_decision', 'output'].includes(node.id),
  );
  definition.capabilityLinks = [];
  definition.controlEdges = definition.controlEdges.filter(
    (edge) =>
      definition.nodes.some((node) => node.id === edge.source) &&
      definition.nodes.some((node) => node.id === edge.target),
  );
  definition.controlEdges.push({
    id: 'end',
    source: 'review_loop',
    sourcePort: 'next',
    target: 'output',
    targetPort: 'in',
  });
  const writer = definition.nodes.find((node) => node.id === 'write');
  if (writer?.type !== 'agent') throw new Error('missing writer');
  writer.inputBindings = writer.inputBindings.filter((input) => input.sourceNodeId !== 'research');
  writer.inputBindings.push(
    { kind: 'run_input', name: 'brief' },
    { kind: 'run_input', name: 'criteria' },
  );
  const output = definition.nodes.find((node) => node.type === 'output');
  if (output?.type === 'output') output.requireApproval = false;
  const loop = definition.nodes.find((node) => node.type === 'loop');
  if (!loop) throw new Error('missing loop');
  loop.maxIterations = 10;
  const recipe: ReviewRecipeRevision = {
    recipeId: 'quality',
    revision: 1,
    criteriaHash: bytesToHex(sha256(utf8ToBytes(canonicalJson(definition.input.criteria)))),
    candidateNodeId: 'write',
    evaluatorRoleId: 'reviewer',
    checkIds: [],
    criteriaFiles: [],
    maxAttempts: 3,
    maxRepairs: 2,
    maxWallMs: 10000,
    maxModelCalls: 20,
    maxOutputTokens: 20000,
    ...overrides,
  };
  Object.assign(loop, { reviewRecipe: recipe });
  return definition;
}
function runtime(definition = fixture(), options: Partial<ScriptedAgentOptions> = {}) {
  const clock = new FakeClock(),
    store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    store,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      reply: (_turn, input) => `${input.nodeId} candidate ${input.round}`,
      ...options,
    }),
  });
  const transport = new InProcessTransport(coordinator);
  const result = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition,
    mode: 'mock',
  });
  if (!result.runId) throw new Error(JSON.stringify(result.receipt.error));
  const runId = result.runId;
  return { clock, coordinator, transport, store, runId, events: () => store.readEvents(runId, 0) };
}
const terminal = (status: string) => ['succeeded', 'failed', 'cancelled'].includes(status);
describe('bounded review recipes (H6)', () => {
  it('[TC-HAR-014-H] compiles the existing loop and validates the fixed criteria and evaluator', () => {
    expect(compileDefinition(fixture()).ok).toBe(true);
    expect(compileDefinition(fixture({ criteriaHash: 'a'.repeat(64) })).ok).toBe(false);
    expect(compileDefinition(fixture({ evaluatorRoleId: 'writer' })).ok).toBe(false);
    expect(compileDefinition(fixture({ candidateNodeId: 'output' })).ok).toBe(false);
  });
  it('[TC-HAR-014-H] revises once then passes the exact new candidate under the pinned recipe', async () => {
    const s = runtime();
    const final = await waitForProjection(s.transport, s.runId, (p) => terminal(p.status));
    expect(final.status).toBe('succeeded');
    expect(final.nodeExecutions.write).toHaveLength(2);
    expect(
      s
        .events()
        .filter((event) => event.type === 'recipe.evaluated')
        .map((event) => event.payload),
    ).toMatchObject([
      { verdict: 'revise', revision: 1 },
      { verdict: 'pass', revision: 1 },
    ]);
  });
  it.each([
    { maxAttempts: 1, maxRepairs: 9, reason: 'attempt_limit', count: 1 },
    { maxAttempts: 5, maxRepairs: 1, reason: 'repair_limit', count: 2 },
  ])(
    '[TC-HAR-014-N] includes the initial attempt and stops at $reason without requesting an extension',
    async ({ reason, count, ...limits }) => {
      const s = runtime(fixture(limits), { review: () => 'revise' });
      const final = await waitForProjection(
        s.transport,
        s.runId,
        (p) => terminal(p.status) || p.status === 'awaiting_user',
      );
      expect(final.status).toBe('failed');
      expect(final.nodeExecutions.write).toHaveLength(count);
      expect(
        s
          .events()
          .some((event) => event.type === 'recipe.stopped' && event.payload.reason === reason),
      ).toBe(true);
      expect(Object.values(final.approvals)).toHaveLength(0);
    },
  );
  it('[TC-HAR-014-N] stops identical candidate repetition instead of trusting a changed verdict', async () => {
    const s = runtime(fixture(), { reply: () => 'Unchanged output' });
    const final = await waitForProjection(s.transport, s.runId, (p) => terminal(p.status));
    expect(final.status).toBe('failed');
    expect(
      s
        .events()
        .some(
          (event) => event.type === 'recipe.stopped' && event.payload.reason === 'repeated_output',
        ),
    ).toBe(true);
    expect(final.nodeExecutions.review).toHaveLength(1);
  });
  it('[TC-HAR-014-N] malformed review does not become pass through generic human approval', async () => {
    const s = runtime(fixture(), { review: () => 'not JSON' });
    const final = await waitForProjection(
      s.transport,
      s.runId,
      (p) => terminal(p.status) || p.status === 'awaiting_user',
    );
    expect(final.status).toBe('failed');
    expect(
      s
        .events()
        .some(
          (event) => event.type === 'recipe.stopped' && event.payload.reason === 'review_invalid',
        ),
    ).toBe(true);
  });
  it('[TC-HAR-014-N] recipe call allowance and deadline are enforced before another model request', async () => {
    const s = runtime(fixture({ maxModelCalls: 1 }));
    const final = await waitForProjection(s.transport, s.runId, (p) => terminal(p.status));
    expect(final.status).toBe('failed');
    expect(final.budget.modelCalls).toBe(1);
    expect(
      s
        .events()
        .some((event) => event.type === 'recipe.stopped' && event.payload.reason === 'call_limit'),
    ).toBe(true);
    const entered = new Gate(),
      release = new Gate();
    const timed = runtime(fixture({ maxWallMs: 1000 }), {
      beforeReply: async () => {
        entered.open();
        await release.wait();
      },
    });
    await entered.wait();
    timed.clock.advance(1001);
    release.open();
    const ended = await waitForProjection(timed.transport, timed.runId, (p) => terminal(p.status));
    expect(ended.status).toBe('failed');
    expect(
      timed
        .events()
        .some((event) => event.type === 'recipe.stopped' && event.payload.reason === 'deadline'),
    ).toBe(true);
  });
  it('[TC-HAR-014-N] criteria and loop patches cannot loosen the recipe', async () => {
    const entered = new Gate(),
      release = new Gate();
    const s = runtime(fixture({ maxAttempts: 2 }), {
      beforeReply: async () => {
        entered.open();
        await release.wait();
      },
    });
    await entered.wait();
    const p = (await s.transport.getSnapshot(s.runId)).projection;
    for (const payload of [
      { kind: 'loop_limit' as const, nodeId: 'review_loop', maxIterations: 3 },
      {
        kind: 'criteria' as const,
        baseCriteriaVersionId: p.currentCriteriaVersionId!,
        criteria: ['Weaker'],
      },
    ]) {
      const receipt = await s.transport.sendCommand({
        schemaVersion: '0.1',
        runId: s.runId,
        commandId: `change_${payload.kind}`,
        expectedControlRevision: p.controlRevision,
        type: 'patch',
        payload,
      });
      expect(receipt.status).toBe('rejected');
    }
    release.open();
    await waitForProjection(s.transport, s.runId, (p) => terminal(p.status));
  });
});
