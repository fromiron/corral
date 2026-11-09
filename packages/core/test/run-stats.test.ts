import type { RunStatus } from '@corral/contracts';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  emptyProjection,
  InMemoryRunStore,
  InProcessTransport,
  type RunProjection,
  type RunSummary,
  runStats,
  type StoredRun,
} from '../src/index.ts';

const corral = linearCorral(['researcher', 'writer'], 'team');

interface Shape {
  runId: string;
  startedAt: string;
  status?: RunStatus;
  mode?: 'mock' | 'live';
  revision?: number;
  corralId?: string;
  build?: (projection: RunProjection) => void;
}

function stored({
  runId,
  startedAt,
  status = 'succeeded',
  mode = 'live',
  revision = 3,
  corralId = corral.id,
  build,
}: Shape): StoredRun {
  const projection = emptyProjection(runId);
  projection.status = status;
  projection.startedAt = startedAt;
  projection.endedAt = status === 'running' ? null : startedAt.replace('T00', 'T01');
  projection.corralId = corralId;
  build?.(projection);
  return {
    runId,
    snapshot: {
      definition: { ...corral, id: corralId },
      definitionHash: 'hash',
      source: { corralId, definitionRevision: revision },
      criteriaVersionId: 'criteria',
      mode,
      models: {},
      startedAt,
    },
    projection,
  };
}

const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}T00:00:00.000Z`;

function summaries(runs: StoredRun[]): RunSummary[] {
  return runs.map((run) => ({
    runId: run.runId,
    status: run.projection.status,
    corralId: run.snapshot.definition.id,
    startedAt: run.snapshot.startedAt,
    projectId: null,
    sessionId: null,
  }));
}

function statsOf(runs: StoredRun[], target = { corralId: corral.id, definitionRevision: 3 }) {
  const byId = new Map(runs.map((run) => [run.runId, run]));
  return runStats(target, summaries(runs), (runId) => byId.get(runId) ?? null);
}

/** Adds one execution of `nodeId` with the given facts to the projection. */
function execute(
  projection: RunProjection,
  nodeId: string,
  facts: { status?: 'succeeded' | 'failed'; attemptNo?: number; outputTokens?: number | null },
) {
  const executionId = `exec_${Object.keys(projection.executions).length + 1}`;
  const modelCallId = `call_${executionId}`;
  projection.executions[executionId] = {
    executionId,
    nodeId,
    taskId: `task_${nodeId}`,
    attemptNo: facts.attemptNo ?? 1,
    parentExecutionId: null,
    previousExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'local',
    configRevision: 0,
    criteriaVersionId: null,
    status: facts.status ?? 'succeeded',
    activity: null,
    waitingOn: null,
    modelCallIds: facts.outputTokens === undefined ? [] : [modelCallId],
    error: null,
  };
  projection.executionOrder.push(executionId);
  projection.nodeExecutions[nodeId] = [...(projection.nodeExecutions[nodeId] ?? []), executionId];
  if (facts.outputTokens !== undefined)
    projection.modelCalls[modelCallId] = {
      modelCallId,
      executionId,
      contextSnapshotId: 'context',
      profile: 'local',
      configRevision: 0,
      directiveIds: [],
      inputArtifactVersionIds: [],
      finished: true,
      usage:
        facts.outputTokens === null
          ? null
          : {
              inputTokens: 10,
              outputTokens: facts.outputTokens,
              cachedInputTokens: null,
              reasoningTokens: null,
            },
      rawUsage: null,
      certainty: facts.outputTokens === null ? 'unknown' : 'reported',
    };
}

function loop(projection: RunProjection, loopNodeId: string, outcomes: string[]) {
  projection.loopIterations[loopNodeId] = outcomes.map((outcome, index) => {
    const iterationId = `${loopNodeId}_round_${index + 1}`;
    projection.iterations[iterationId] = {
      iterationId,
      loopNodeId,
      parentIterationId: null,
      no: index + 1,
      criteriaVersionId: 'criteria',
      outcome: outcome as RunProjection['iterations'][string]['outcome'],
    };
    return iterationId;
  });
}

function branch(projection: RunProjection, nodeId: string, selectedPort: string) {
  const eventId = `branch_${Object.keys(projection.workflowBranches ?? {}).length + 1}`;
  projection.workflowBranches = {
    ...projection.workflowBranches,
    [eventId]: {
      eventId,
      recordedAt: '2026-11-01T00:00:00.000Z',
      runSeq: 1,
      nodeId,
      mode: 'review',
      iterationId: null,
      configRevision: 0,
      selectedPort,
      targetNodeId: null,
      targetPort: null,
      reasonCode: 'required_tasks_completed',
    } as NonNullable<RunProjection['workflowBranches']>[string],
  };
}

describe('run stats', () => {
  it('counts only the latest 20 finished live runs of the open revision', () => {
    const counted = Array.from({ length: 22 }, (_, i) =>
      stored({ runId: `run_${String(i + 1).padStart(2, '0')}`, startedAt: day(i + 1) }),
    );
    const runs = [
      ...counted,
      stored({ runId: 'mock', startedAt: day(28), mode: 'mock' }),
      stored({ runId: 'running', startedAt: day(29), status: 'running' }),
      stored({ runId: 'older_revision', startedAt: day(30), revision: 2 }),
      stored({ runId: 'other_team', startedAt: day(30), corralId: 'other' }),
    ];
    // Store order is not start order: the newest counted runs must still win.
    const stats = statsOf([
      ...runs.filter((_, i) => i % 2 === 0),
      ...runs.filter((_, i) => i % 2 === 1),
    ]);
    expect(stats.runs.map((run) => run.runId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `run_${String(22 - i).padStart(2, '0')}`),
    );
    expect(stats.runs[0]).toEqual({
      runId: 'run_22',
      status: 'succeeded',
      startedAt: day(22),
      endedAt: day(22).replace('T00', 'T01'),
    });
    expect(stats).toMatchObject({ corralId: corral.id, definitionRevision: 3 });
  });

  it('reads loop rounds and which runs hit the cap', () => {
    const rounds = [
      ['pass'],
      ['revise', 'pass'],
      ['revise', 'revise', 'pass'],
      ['revise', 'revise', 'cap_reached'],
    ];
    const stats = statsOf(
      rounds.map((outcomes, i) =>
        stored({
          runId: `run_${i + 1}`,
          startedAt: day(i + 1),
          build: (p) => loop(p, 'review_loop', outcomes),
        }),
      ),
    );
    expect(stats.nodes.review_loop?.perRun).toEqual([
      expect.objectContaining({ runId: 'run_4', rounds: 3, capReached: true }),
      expect.objectContaining({ runId: 'run_3', rounds: 3, capReached: false }),
      expect.objectContaining({ runId: 'run_2', rounds: 2, capReached: false }),
      expect.objectContaining({ runId: 'run_1', rounds: 1, capReached: false }),
    ]);
  });

  it('counts every branch a decision selected, run by run', () => {
    const stats = statsOf([
      stored({
        runId: 'run_1',
        startedAt: day(1),
        build: (p) => {
          branch(p, 'review', 'revise');
          branch(p, 'review', 'revise');
          branch(p, 'review', 'pass');
        },
      }),
      stored({
        runId: 'run_2',
        startedAt: day(2),
        build: (p) => {
          branch(p, 'review', 'revise');
          branch(p, 'review', 'pass');
        },
      }),
    ]);
    expect(stats.nodes.review?.perRun).toEqual([
      expect.objectContaining({ runId: 'run_2', branches: { revise: 1, pass: 1 } }),
      expect.objectContaining({ runId: 'run_1', branches: { revise: 2, pass: 1 } }),
    ]);
  });

  it('adds up agent failures, retries and reported output tokens', () => {
    const stats = statsOf([
      stored({
        runId: 'run_1',
        startedAt: day(1),
        build: (p) => {
          execute(p, 'writer', { status: 'failed', outputTokens: 30 });
          execute(p, 'writer', { attemptNo: 2, outputTokens: 70 });
          execute(p, 'writer', { outputTokens: null });
          execute(p, 'researcher', { outputTokens: 100 });
        },
      }),
    ]);
    expect(stats.totalOutputTokens).toBe(200);
    expect(stats.nodes.writer?.perRun).toEqual([
      {
        runId: 'run_1',
        executions: 3,
        failures: 1,
        retries: 1,
        outputTokens: 100,
        rounds: 0,
        capReached: false,
        branches: {},
      },
    ]);
    expect(stats.nodes.researcher?.perRun[0]).toMatchObject({ executions: 1, failures: 0 });
  });

  it('leaves out steps that did nothing in any counted run', () => {
    const stats = statsOf([
      stored({ runId: 'run_1', startedAt: day(1), build: (p) => execute(p, 'writer', {}) }),
    ]);
    expect(Object.keys(stats.nodes)).toEqual(['writer']);
  });

  it('has no runs and no figures when the revision never ran live', () => {
    const stats = statsOf([stored({ runId: 'mock', startedAt: day(1), mode: 'mock' })]);
    expect(stats).toEqual({
      corralId: corral.id,
      definitionRevision: 3,
      runs: [],
      totalOutputTokens: 0,
      nodes: {},
    });
  });

  it('is served by the coordinator and the in-process transport from the run store', async () => {
    const store = new InMemoryRunStore();
    store.insertRun(stored({ runId: 'run_1', startedAt: day(1) }));
    store.insertRun(stored({ runId: 'run_2', startedAt: day(2), mode: 'mock' }));
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    const transport = new InProcessTransport(coordinator);
    const stats = await transport.getRunStats(corral.id, 3);
    expect(stats.runs.map((run) => run.runId)).toEqual(['run_1']);
    expect((await transport.getRunStats(corral.id, 2)).runs).toEqual([]);
  });
});
