import type { RunEvent } from '@corral/contracts';
import { emptyProjection, type RunProjection } from '@corral/core';
import { describe, expect, it } from 'vitest';
import { buildTurnProcess, turnSummary } from '../src/run/turn-process.ts';

// a chat turn's process is one flat list of one-line rows.

let seq = 0;
const at = (second: number) => `2026-10-25T00:00:${String(second).padStart(2, '0')}.000Z`;
function event(
  type: string,
  payload: Record<string, unknown>,
  second: number,
  actor: Record<string, unknown> = { kind: 'agent', id: 'lead' },
): RunEvent {
  seq++;
  return { type, runSeq: seq, recordedAt: at(second), actor, payload } as unknown as RunEvent;
}

function projection(status: RunProjection['status'], executions: [string, string, string][]) {
  const p = emptyProjection('run_turn');
  p.status = status;
  p.executionOrder = executions.map(([id]) => id);
  p.executions = Object.fromEntries(
    executions.map(([executionId, nodeId, state]) => [
      executionId,
      { executionId, nodeId, status: state, modelCallIds: [] },
    ]),
  ) as unknown as RunProjection['executions'];
  return p;
}

describe('buildTurnProcess', () => {
  it('identifies the exact artifact version for a read without replacing unknown targets', () => {
    const p = projection('succeeded', [['lead', 'assistant', 'succeeded']]);
    const version = {
      artifactVersionId: 'artv_original',
      artifactId: 'artifact_report',
      version: 2,
      parentVersionId: null,
      name: 'Security report',
      contract: 'text',
      contentHash: 'a'.repeat(64),
      byteLength: 12,
      authorExecutionId: 'lead',
      modelCallId: null,
      contextSnapshotId: null,
      submitted: true,
      configRevision: 1,
      criteriaVersionId: null,
      inputArtifactVersionIds: [],
    } satisfies RunProjection['artifacts'][string];
    p.artifacts.artv_original = version;
    p.artifacts.artv_latest = { ...version, artifactVersionId: 'artv_latest', version: 3 };
    const events = ['artv_original', 'artv_missing'].map((artifactVersionId) =>
      event(
        'tool.requested',
        {
          executionId: 'lead',
          toolCallId: artifactVersionId,
          name: 'read_artifact',
          validatedArgs: { artifactVersionId },
        },
        1,
      ),
    );
    const process = buildTurnProcess(events, p, {}, (id) => id);
    expect(process.rows).toEqual([
      {
        kind: 'tool',
        id: 'artv_original',
        name: 'read_artifact',
        target: 'artv_original',
        artifact: { name: 'Security report', version: 2 },
        status: 'requested',
      },
      {
        kind: 'tool',
        id: 'artv_missing',
        name: 'read_artifact',
        target: 'artv_missing',
        status: 'requested',
      },
    ]);
    expect(p.artifacts.artv_original.version).toBe(2);
  });

  it('uses confirmed tool cancellation while preserving a failure before run cancellation', () => {
    const p = projection('cancelled', [['lead', 'assistant', 'cancelled']]);
    const events = ['stopped', 'failed'].flatMap((id) => {
      p.toolCalls[id] = {
        toolCallId: id,
        executionId: 'lead',
        name: 'await_tasks',
        status: 'requested',
        phase: 'failed',
        effectId: id,
        reason: id === 'stopped' ? 'scope cancelled' : 'tool failed',
      };
      p.effects[id] = {
        effectId: id,
        kind: 'tool',
        scope: 'lead',
        epoch: 1,
        dispatched: true,
        reservationId: null,
        status: 'settled',
        outcome: id === 'stopped' ? 'cancelled' : 'failed',
      };
      return [
        event(
          'tool.requested',
          { executionId: 'lead', toolCallId: id, name: 'await_tasks', validatedArgs: {} },
          1,
        ),
        event(
          'tool.finished',
          { executionId: 'lead', toolCallId: id, error: p.toolCalls[id].reason },
          2,
        ),
      ];
    });
    expect(buildTurnProcess(events, p, {}, (id) => id).rows).toMatchObject([
      { id: 'stopped', status: 'cancelled' },
      { id: 'failed', status: 'failed' },
    ]);
  });
  it('lists thinking before tools and tools with their targets, without the answer', () => {
    seq = 0;
    const events = [
      event('run.started', {}, 0),
      event('model.request_prepared', { executionId: 'lead', modelCallId: 'c1' }, 1),
      event(
        'tool.requested',
        {
          executionId: 'lead',
          toolCallId: 't1',
          name: 'read_file',
          validatedArgs: { path: 'src/app.ts' },
        },
        2,
      ),
      event('tool.finished', { executionId: 'lead', toolCallId: 't1', error: null }, 3),
      event('model.request_prepared', { executionId: 'lead', modelCallId: 'c2' }, 4),
      // The Coordinator publishes the final reply; those calls are not process.
      event(
        'tool.requested',
        { executionId: 'lead', toolCallId: 't2', name: 'write_artifact', validatedArgs: {} },
        5,
        { kind: 'runtime', id: 'coordinator' },
      ),
      event('run.state_changed', { to: 'succeeded' }, 9),
    ];
    const streams = {
      c1: { text: 'Let me read the app first.\nThen fix it.', completed: true, broken: false },
      c2: { text: 'The bug is fixed.', completed: true, broken: false },
    };
    const process = buildTurnProcess(
      events,
      projection('succeeded', [['lead', 'assistant', 'succeeded']]),
      streams as never,
      (id) => id,
    );
    expect(process.rows).toEqual([
      { kind: 'think', id: 'c1', text: 'Let me read the app first.', live: false },
      { kind: 'tool', id: 't1', name: 'read_file', target: 'src/app.ts', status: 'finished' },
    ]);
    expect(process.steps).toBe(1);
    expect(process.running).toBe(false);
    expect(process.startedAt).toBe(at(0));
    expect(process.endedAt).toBe(at(9));
  });

  it('a turn that only answered has no rows, and other agents are one row each', () => {
    seq = 0;
    const answerOnly = buildTurnProcess(
      [
        event('run.started', {}, 0),
        event('model.request_prepared', { executionId: 'lead', modelCallId: 'c1' }, 1),
        event('run.state_changed', { to: 'succeeded' }, 2),
      ],
      projection('succeeded', [['lead', 'assistant', 'succeeded']]),
      { c1: { text: '안녕하세요!', completed: true, broken: false } } as never,
      (id) => id,
    );
    expect(answerOnly.rows).toEqual([]);

    seq = 0;
    const team = buildTurnProcess(
      [event('run.started', {}, 0)],
      projection('running', [
        ['lead', 'assistant', 'waiting_children'],
        ['child', 'helper', 'active'],
      ]),
      {} as never,
      (id) => (id === 'helper' ? 'Helper' : id),
    );
    expect(team.rows).toEqual([{ kind: 'agent', id: 'child', label: 'Helper', status: 'active' }]);
    expect(team.running).toBe(true);
    expect(team.endedAt).toBeNull();
    // Without loaded events, the folded header counts the same steps from the projection.
    expect(
      turnSummary(
        projection('running', [
          ['lead', 'a', 'active'],
          ['child', 'helper', 'active'],
        ]),
      ).steps,
    ).toBe(1);
  });

  it('a blocked tool keeps its row with the blocked status', () => {
    seq = 0;
    const process = buildTurnProcess(
      [
        event('model.request_prepared', { executionId: 'lead', modelCallId: 'c1' }, 1),
        event(
          'tool.requested',
          {
            executionId: 'lead',
            toolCallId: 't1',
            name: 'run_command',
            validatedArgs: { command: 'rm -rf build' },
          },
          2,
        ),
        event('tool.blocked', { executionId: 'lead', toolCallId: 't1', reason: 'denied' }, 3),
        event('run.state_changed', { to: 'failed' }, 4),
      ],
      projection('failed', [['lead', 'assistant', 'failed']]),
      {} as never,
      (id) => id,
    );
    expect(process.rows).toEqual([
      { kind: 'tool', id: 't1', name: 'run_command', target: 'rm -rf build', status: 'blocked' },
    ]);
  });
});
