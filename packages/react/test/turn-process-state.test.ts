import type { RunEvent } from '@corral/contracts';
import { emptyProjection, type RunProjection } from '@corral/core';
import { describe, expect, it } from 'vitest';
import { buildTurnProcess } from '../src/run/turn-process.ts';

const at = (second: number) => `2026-10-25T00:00:${String(second).padStart(2, '0')}.000Z`;
function event(type: string, payload: Record<string, unknown>, seq: number): RunEvent {
  return {
    type,
    runSeq: seq,
    recordedAt: at(seq),
    actor: { kind: 'agent', id: 'lead' },
    payload,
  } as unknown as RunEvent;
}
function projection(status: RunProjection['status'] = 'running', executionStatus = 'active') {
  const p = emptyProjection('run_turn');
  p.status = status;
  p.startedAt = at(0);
  p.executionOrder = ['lead'];
  p.executions.lead = {
    executionId: 'lead',
    nodeId: 'assistant',
    status: executionStatus,
    modelCallIds: ['c1'],
  } as never;
  p.modelCalls.c1 = {
    modelCallId: 'c1',
    executionId: 'lead',
    profile: 'model-a',
    finished: false,
    inputArtifactVersionIds: [],
  } as never;
  return p;
}
const request = event(
  'model.request_prepared',
  {
    executionId: 'lead',
    modelCallId: 'c1',
    profile: 'model-a',
    directiveIds: [],
    inputArtifactVersionIds: [],
  },
  1,
);
const toolRequested = event(
  'tool.requested',
  {
    executionId: 'lead',
    toolCallId: 't1',
    name: 'read_file',
    validatedArgs: { path: 'src/app.ts' },
  },
  2,
);
const process = (p: RunProjection, events: RunEvent[] = [request], text = '') =>
  buildTurnProcess(
    events,
    p,
    { c1: { text, next: 1, completed: false, broken: false } },
    (id) => id,
  );

describe('observed ThinkingSteps states', () => {
  it('shows the first observed model request before response text or a tool call', () => {
    const p = projection();
    expect(process(p).rows).toMatchObject([
      { kind: 'model', id: 'c1', no: 1, phase: 'preparing', active: true },
    ]);
    p.effects.model = {
      kind: 'model_request',
      reservationId: 'c1',
      scope: 'lead',
      dispatched: true,
    } as never;
    expect(process(p).rows[0]).toMatchObject({ kind: 'model', phase: 'generating' });
    expect(process(p, []).rows).toEqual([]);
  });

  it('keeps ordinary response text out of the process and preserves observed tool detail', () => {
    const p = projection();
    p.modelCalls.c1 = { ...p.modelCalls.c1!, finished: true, responseRef: 'response_c1' };
    const result = process(
      p,
      [
        request,
        toolRequested,
        event('tool.started', { executionId: 'lead', toolCallId: 't1' }, 3),
        event(
          'tool.finished',
          { executionId: 'lead', toolCallId: 't1', resultRef: 'result_1', error: null },
          4,
        ),
      ],
      'Ordinary answer is not private reasoning.',
    );
    expect(result.rows.map((row) => row.kind)).toEqual(['model', 'tool']);
    expect(JSON.stringify(result.rows)).not.toContain('Ordinary answer');
    expect(result.rows[1]).toMatchObject({
      kind: 'tool',
      id: 't1',
      status: 'finished',
      args: { path: 'src/app.ts' },
      resultRef: 'result_1',
    });
    expect(result.steps).toBe(1);
  });

  it.each([
    ['paused', 'paused', 'paused'],
    ['awaiting_user', 'waiting_approval', 'waiting'],
    ['running', 'waiting_approval', 'waiting'],
    ['cancelled', 'cancelled', 'cancelled'],
    ['failed', 'failed', 'failed'],
  ] as const)('does not animate %s/%s as active work', (status, executionStatus, phase) => {
    const p = projection(status, executionStatus);
    p.executionOrder.push('helper');
    p.executions.helper = {
      executionId: 'helper',
      nodeId: 'helper',
      status: executionStatus,
      modelCallIds: [],
    } as never;
    const result = process(p, [request, toolRequested]);
    expect(result.rows[0]).toMatchObject({ kind: 'model', phase, active: false });
    expect(result.rows.every((row) => !row.active)).toBe(true);
    expect(result.active).toBe(false);
  });

  it('keeps blocked tools and their reason without making them successful or active', () => {
    const result = process(projection('failed', 'failed'), [
      request,
      toolRequested,
      event(
        'tool.blocked',
        { executionId: 'lead', toolCallId: 't1', reason: 'Permission denied' },
        3,
      ),
    ]);
    expect(result.rows[1]).toMatchObject({
      status: 'blocked',
      detail: 'Permission denied',
      active: false,
    });
  });

  it('shows recorded sources and scopes delegate tools to their actual execution', () => {
    const p = projection();
    p.modelCalls.c1!.inputArtifactVersionIds = ['artv_source'];
    p.artifacts.artv_source = {
      artifactVersionId: 'artv_source',
      name: 'Source notes',
      authorExecutionId: 'helper',
    } as never;
    p.executionOrder.push('helper');
    p.executions.helper = {
      executionId: 'helper',
      nodeId: 'researcher',
      status: 'active',
      modelCallIds: [],
    } as never;
    const childTool = event(
      'tool.requested',
      { executionId: 'helper', toolCallId: 'helper_tool', name: 'search', validatedArgs: {} },
      3,
    );
    const result = process(p, [request, toolRequested, childTool]);
    expect(result.rows[0]).toMatchObject({
      sources: [{ id: 'artv_source', label: 'Source notes' }],
    });
    expect(result.rows.find((row) => row.kind === 'agent')).toMatchObject({
      id: 'helper',
      tools: [{ toolCallId: 'helper_tool' }],
      sources: [{ id: 'artv_source', label: 'Source notes' }],
    });
    expect(result.rows.filter((row) => row.kind === 'tool')).toHaveLength(1);
  });

  it('a finished answer-only turn retains request metadata without retaining its text', () => {
    const p = projection('succeeded', 'succeeded');
    p.endedAt = at(8);
    p.modelCalls.c1 = { ...p.modelCalls.c1!, finished: true, responseRef: 'response_c1' };
    const result = process(p, [request], 'Retired response');
    expect(result.rows[0]).toMatchObject({ kind: 'model', phase: 'finished', active: false });
    expect(JSON.stringify(result.rows)).not.toContain('Retired response');
    expect(result.steps).toBe(0);
    expect(result.endedAt).toBe(at(8));
  });
});
