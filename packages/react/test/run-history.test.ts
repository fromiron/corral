import { type EventOf, type ExecutionStatus, RunEvent } from '@corral/contracts';
import {
  applyEvent,
  Coordinator,
  emptyProjection,
  InProcessTransport,
  waitForProjection,
} from '@corral/core';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  executionIntervals,
  historicalStreams,
  reconstructRunHistory,
} from '../src/run/history.ts';
import type { StreamText } from '../src/run/session.ts';

const RUN = 'run_history';
const clock = new FakeClock();
const at = (ms: number) => new Date(Date.parse(clock.nowIso()) + ms).toISOString();

function event<K extends RunEvent['type']>(
  seq: number,
  type: K,
  payload: EventOf<K>['payload'],
  ms = 0,
): EventOf<K> {
  return RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `evt_${seq}`,
    runId: RUN,
    runSeq: seq,
    recordedAt: at(ms),
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type,
    payload,
  }) as EventOf<K>;
}

function created(seq = 1, id = 'exec_first', attempt = 1, ms = 0) {
  return event(
    seq,
    'execution.created',
    {
      executionId: id,
      nodeId: 'worker',
      taskId: 'task_work',
      attemptNo: attempt,
      previousExecutionId: attempt > 1 ? 'exec_first' : undefined,
      parentExecutionId: null,
      depth: 0,
      iterationId: `iter_${attempt}`,
      modelProfile: 'model-a',
    },
    ms,
  );
}

function changed(
  seq: number,
  from: ExecutionStatus,
  to: ExecutionStatus,
  ms: number,
  activity: 'model' | 'tool' | null = null,
  executionId = 'exec_first',
) {
  return event(
    seq,
    'execution.state_changed',
    { executionId, from, to, activity, waitingOn: null },
    ms,
  );
}

describe('historical Run projection', () => {
  it('uses the existing reducer for a real coordinator log without changing live records', async () => {
    const transport = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
      }),
    );
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_history',
      definition: linearCorral(['worker']),
      mode: 'mock',
    });
    if (!runId) throw new Error('run missing');
    const records: RunEvent[] = [];
    const stop = transport.subscribe(runId, 0, { onEvent: (item) => records.push(item) });
    const live = await waitForProjection(transport, runId, (p) => p.status === 'succeeded');
    await Promise.resolve();
    stop();
    const before = JSON.stringify(records);
    const history = reconstructRunHistory(runId, records, live.lastSeq);
    expect(history.status).toBe('ready');
    expect(history.projection).toEqual(live);
    expect(history.projection).not.toBe(live);
    expect(JSON.stringify(records)).toBe(before);
  });

  it('uses runSeq for equal timestamps and keeps a chosen prefix when newer events arrive', () => {
    const records = [
      created(),
      changed(2, 'queued', 'active', 0, 'model'),
      changed(3, 'active', 'succeeded', 0),
    ];
    const before = reconstructRunHistory(RUN, records.slice(0, 2), 2);
    const after = reconstructRunHistory(RUN, records, 2);
    expect(after.projection).toEqual(before.projection);
    expect(after.projection.executions.exec_first?.status).toBe('active');
    expect(after.events).toEqual(records.slice(0, 2));
    expect(reconstructRunHistory(RUN, records, 0)).toMatchObject({
      status: 'ready',
      events: [],
      projection: { lastSeq: 0 },
    });
  });

  it('stops at an observed gap while distinguishing records that have not arrived', () => {
    const records = [created(), changed(2, 'queued', 'active', 0, 'model')];
    expect(reconstructRunHistory(RUN, records, 4)).toMatchObject({
      status: 'loading',
      projection: { lastSeq: 2 },
      gap: null,
    });
    const skipped = changed(4, 'active', 'succeeded', 100);
    const history = reconstructRunHistory(RUN, [...records, skipped], 3);
    expect(history).toMatchObject({
      status: 'gap',
      projection: { lastSeq: 2 },
      gap: { expectedSeq: 3, receivedSeq: 4 },
    });
    expect(history.events).toEqual(records);
    expect(reconstructRunHistory(RUN, [...records, skipped], 2).status).toBe('ready');
  });

  it('rejects an invalid cursor or a different Run instead of mixing owners', () => {
    for (const seq of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => reconstructRunHistory(RUN, [], seq)).toThrow(RangeError);
    }
    expect(() => reconstructRunHistory('run_other', [created()], 1)).toThrow('another run');
  });
});

describe('observed execution time', () => {
  it('keeps retries and iterations separate and clips open state segments to the prefix horizon', () => {
    const records: RunEvent[] = [
      created(),
      changed(2, 'queued', 'active', 10, 'model'),
      changed(3, 'active', 'waiting_message', 20),
      changed(4, 'waiting_message', 'active', 40, 'tool'),
      changed(5, 'active', 'failed', 50),
      created(6, 'exec_retry', 2, 60),
      changed(7, 'queued', 'active', 70, 'model', 'exec_retry'),
      event(
        8,
        'tool.requested',
        {
          executionId: 'exec_retry',
          toolCallId: 'tool_open',
          name: 'read_file',
          validatedArgs: {},
        },
        100,
      ),
    ];
    const intervals = executionIntervals(records);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toMatchObject({
      executionId: 'exec_first',
      attemptNo: 1,
      iterationId: 'iter_1',
      startedAt: at(0),
      endedAt: at(50),
      finished: true,
    });
    expect(
      intervals[0]?.segments.map((part) => [
        part.status,
        part.activity,
        part.startedAt,
        part.endedAt,
      ]),
    ).toEqual([
      ['queued', null, at(0), at(10)],
      ['active', 'model', at(10), at(20)],
      ['waiting_message', null, at(20), at(40)],
      ['active', 'tool', at(40), at(50)],
    ]);
    expect(intervals[1]).toMatchObject({
      executionId: 'exec_retry',
      attemptNo: 2,
      iterationId: 'iter_2',
      startedAt: at(60),
      endedAt: at(100),
      endSeq: 8,
      finished: false,
    });
    expect(executionIntervals(records.slice(0, 7))[1]?.endedAt).toBe(at(70));
  });

  it('measures only observed dispatch/finish pairs and started/finished tools', () => {
    const records: RunEvent[] = [
      created(),
      event(
        2,
        'model.request_prepared',
        {
          executionId: 'exec_first',
          modelCallId: 'call_one',
          contextSnapshotId: 'ctx_one',
          profile: 'model-a',
          configRevision: 0,
          directiveIds: [],
          inputArtifactVersionIds: [],
        },
        1,
      ),
      event(
        3,
        'budget.reserved',
        {
          reservationId: 'call_one',
          modelCallId: 'call_one',
          amount: { outputTokens: 100, modelCalls: 1 },
          scope: 'exec_first',
        },
        2,
      ),
      event(
        4,
        'effect.admitted',
        {
          effectId: 'eff_one',
          kind: 'model_request',
          scope: 'exec_first',
          epoch: 1,
          reservationId: 'call_one',
        },
        3,
      ),
      event(5, 'effect.dispatch_observed', { effectId: 'eff_one', providerRequestId: null }, 10),
      event(
        6,
        'model.finished',
        {
          executionId: 'exec_first',
          modelCallId: 'call_one',
          responseRef: 'artv_reply',
          rawUsage: null,
          normalizedUsage: {
            inputTokens: 2,
            outputTokens: 3,
            cachedInputTokens: null,
            reasoningTokens: null,
          },
          certainty: 'reported',
        },
        40,
      ),
      event(
        7,
        'tool.started',
        { executionId: 'exec_first', toolCallId: 'tool_one', effectId: 'eff_tool' },
        50,
      ),
      event(
        8,
        'tool.finished',
        { executionId: 'exec_first', toolCallId: 'tool_one', resultRef: null, error: null },
        70,
      ),
      event(
        9,
        'tool.finished',
        { executionId: 'exec_first', toolCallId: 'tool_missing', resultRef: null, error: null },
        80,
      ),
      event(
        10,
        'model.finished',
        {
          executionId: 'exec_first',
          modelCallId: 'call_no_dispatch',
          responseRef: null,
          rawUsage: null,
          normalizedUsage: {
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            reasoningTokens: null,
          },
          certainty: 'unknown',
        },
        90,
      ),
    ];
    expect(executionIntervals(records.slice(0, 5))[0]?.calls).toEqual([]);
    expect(executionIntervals(records)[0]?.calls).toEqual([
      { kind: 'model', callId: 'call_one', startedAt: at(10), endedAt: at(40), durationMs: 30 },
      { kind: 'tool', callId: 'tool_one', startedAt: at(50), endedAt: at(70), durationMs: 20 },
    ]);
  });

  it('handles 10,000 committed activity changes without collapsing observation order', () => {
    const records: RunEvent[] = [created()];
    for (let seq = 2; seq <= 10_000; seq++) {
      records.push(
        changed(
          seq,
          seq === 2 ? 'queued' : 'active',
          'active',
          seq - 1,
          seq % 2 ? 'tool' : 'model',
        ),
      );
    }
    const snapshot = reconstructRunHistory(RUN, records, 5_000);
    expect(snapshot.status).toBe('ready');
    expect(snapshot.projection.lastSeq).toBe(5_000);
    const intervals = executionIntervals(snapshot.events);
    expect(intervals[0]?.endSeq).toBe(5_000);
    expect(intervals[0]?.endedAt).toBe(at(4_999));
    expect(intervals[0]?.segments).toHaveLength(5_000);
    expect(records).toHaveLength(10_000);
  });
});

it('shows only immutable responses that had already completed at the chosen prefix', () => {
  const prepared = event(1, 'model.request_prepared', {
    executionId: 'exec_first',
    modelCallId: 'call_one',
    contextSnapshotId: 'ctx_one',
    profile: 'model-a',
    configRevision: 0,
    directiveIds: [],
    inputArtifactVersionIds: [],
  });
  const finished = event(2, 'model.finished', {
    executionId: 'exec_first',
    modelCallId: 'call_one',
    responseRef: 'artv_reply',
    rawUsage: null,
    normalizedUsage: {
      inputTokens: 2,
      outputTokens: 3,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
    certainty: 'reported',
  });
  const streams: Record<string, StreamText> = {
    call_one: { text: 'Committed answer', next: 1, broken: false, completed: true },
    call_future: { text: 'Future answer', next: 1, broken: false, completed: true },
  };
  const before = applyEvent(emptyProjection(RUN), prepared);
  const after = applyEvent(before, finished);
  expect(historicalStreams(before, streams)).toEqual({});
  expect(historicalStreams(after, streams)).toEqual({ call_one: streams.call_one });
  expect(
    historicalStreams(after, { call_one: { text: 'Still streaming', next: 1, broken: false } }),
  ).toEqual({});
  const call = after.modelCalls.call_one;
  if (!call) throw new Error('fixture call missing');
  expect(
    historicalStreams(
      { ...after, modelCalls: { call_one: { ...call, responseRef: null } } },
      streams,
    ),
  ).toEqual({});
  expect(streams.call_future?.text).toBe('Future answer');
});
