import type { EventOf, ModelProfileSnapshot, RunEvent } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { expect, it } from 'vitest';
import { contextCalls } from './contextCalls.ts';
import { presentContext } from './selectors.ts';

const initial: ModelProfileSnapshot = {
  profile: 'shared',
  provider: 'test',
  modelId: 'initial',
  auth: 'mock',
  contextWindow: 1000,
};
const rebound: ModelProfileSnapshot = {
  ...initial,
  modelId: 'replacement',
  contextWindow: 8000,
};
const call = (executionId: string, modelCallId: string): RunProjection['modelCalls'][string] => ({
  executionId,
  modelCallId,
  profile: 'shared',
  contextSnapshotId: 'ctx',
  configRevision: 0,
  directiveIds: [],
  inputArtifactVersionIds: [],
  finished: true,
  usage: null,
  rawUsage: null,
  certainty: null,
});
function event<T extends RunEvent['type']>(type: T, payload: EventOf<T>['payload']) {
  return { type, payload, recordedAt: '2026-10-20T00:00:00.000Z' } as EventOf<T>;
}
const request = (modelCallId: string) =>
  event('model.request_recorded', {
    modelCallId,
    purpose: 'turn',
    directiveIds: [],
    contextHash: 'a'.repeat(64),
    contextBytes: 1,
    sections: [],
    contextUsage: {
      version: 1,
      coverage: 'request',
      completeness: 'complete',
      method: 'pi-1.3.0-chars4',
      usedTokens: 400,
      parts: [{ category: 'messages', tokens: 400 }],
    },
  });
const payload = (modelCallId: string) =>
  event('model.payload_recorded', {
    modelCallId,
    payloadHash: 'b'.repeat(64),
    payloadBytes: 1,
    contextUsage: {
      version: 1,
      coverage: 'request',
      completeness: 'complete',
      method: 'pi-1.3.0-chars4',
      usedTokens: 400,
      parts: [{ category: 'messages', tokens: 400 }],
    },
  });

it('[TC-WIDGET-002-N] CTX-06 binds each request to its activated model snapshot, including inherited prompt patches', () => {
  const events: RunEvent[] = [
    request('call_initial'),
    event('patch.committed', {
      patchId: 'patch_model',
      kind: 'node_future',
      scope: { nodeId: 'writer' },
      before: {},
      after: { modelProfile: 'shared', modelSnapshot: rebound },
      controlRevision: 1,
    }),
    event('patch.activated', { patchId: 'patch_model', executionId: 'exec_new' }),
    request('call_new'),
    event('patch.committed', {
      patchId: 'patch_prompt',
      kind: 'node_future',
      scope: { nodeId: 'writer' },
      before: {},
      after: { modelProfile: 'shared', prompt: 'Changed instructions' },
      controlRevision: 2,
    }),
    event('patch.activated', { patchId: 'patch_prompt', executionId: 'exec_later' }),
    request('call_later'),
    request('call_still_initial'),
  ];
  const calls = contextCalls(
    events,
    {
      call_initial: call('exec_old', 'call_initial'),
      call_new: call('exec_new', 'call_new'),
      call_later: call('exec_later', 'call_later'),
      call_still_initial: call('exec_old', 'call_still_initial'),
    },
    { shared: initial },
    [],
  );
  expect(calls.map(({ windowTokens, modelLabel }) => ({ windowTokens, modelLabel }))).toEqual([
    { windowTokens: 1000, modelLabel: 'initial' },
    { windowTokens: 8000, modelLabel: 'replacement' },
    { windowTokens: 8000, modelLabel: 'replacement' },
    { windowTokens: 1000, modelLabel: 'initial' },
  ]);
});

it('[TC-WIDGET-002-N] CTX-06 includes executions before their first request in the unmeasured count', () => {
  const calls = contextCalls(
    [request('call_initial'), payload('call_initial')],
    {
      call_initial: call('exec_old', 'call_initial'),
    },
    { shared: initial },
    [],
  );
  const result = presentContext({
    calls,
    compactions: [],
    selectedExecutionId: null,
    executionIds: ['exec_old', 'exec_waiting'],
  });
  expect(result).toMatchObject({ kind: 'highest', percent: 40, unmeasuredExecutions: 1 });
});

it('[TC-WIDGET-002-N] CTX-04 does not report a complete window ratio before final payload reconciliation', () => {
  const calls = contextCalls(
    [request('call_initial')],
    {
      call_initial: call('exec_old', 'call_initial'),
    },
    { shared: initial },
    [],
  );
  const result = presentContext({ calls, compactions: [], selectedExecutionId: 'exec_old' });
  expect(result).toMatchObject({
    kind: 'partial',
    tokens: 400,
    percent: null,
    freeTokens: null,
    measurementStage: 'assembled',
  });
});
