import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentHost, AgentStartInput, EffectiveHarnessSnapshot } from '@corral/contracts';
import { Gate, linearCorral } from '@corral/testkit';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { runSdkWorker } from '../src/sdk-worker.ts';
import { ACCESS_TOKEN, recordingHost } from './harness.ts';

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const hash = 'a'.repeat(64);
const snapshot: EffectiveHarnessSnapshot = {
  binding: { profileId: 'writing', revision: 1 }, snapshotHash: hash,
  piVersion: '1.3.0', policyRevision: 1, policy: 'trusted-native',
  resources: [{ hash, name: 'fixture', version: '1.0.0', kind: 'extension', required: true }],
  allowedTools: ['echo'], tools: [], diagnostics: [],
};
function input(): AgentStartInput {
  const role = linearCorral(['writer']).roles[0]!;
  return {
    runId: 'run_1', executionId: 'exec_1', taskId: 'task_1', nodeId: 'writer', attemptNo: 1,
    role: { ...role, harness: snapshot.binding }, harness: snapshot,
    modelProfile: 'model-a', mode: 'live',
    model: { profile: 'model-a', provider: 'openai', modelId: 'faux-1', auth: 'oauth' },
    depth: 0, round: null, criteriaVersionId: 'criteria_1', assignment: { kind: 'scheduled' },
    capabilities: { delegateTo: [], askTo: [] },
    inputs: [{ name: 'brief', kind: 'run_input', artifactVersionId: null, text: 'Private brief.' }],
  };
}

function runtime(responses: FauxResponseStep[], extension = '', overrides: Partial<AgentHost> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'corral-sdk-test-'));
  scratch.push(directory);
  const path = join(directory, 'fixture.ts');
  writeFileSync(path, extension || 'export default () => {}');
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const frames: unknown[] = [];
  const reports: unknown[] = [];
  const requests: unknown[] = [];
  const { host, calls } = recordingHost({
    reportHarness: async (report) => { reports.push(report); },
    pendingDirectives: () => [],
    prepareModelRequest: async (record) => {
      requests.push(record);
      calls.push('prepare');
      return { modelCallId: `call_${requests.length}`, contextSnapshotId: `ctx_${requests.length}`, profile: 'model-a', maxOutputTokens: 256, directives: [] };
    },
    beginNativeTool: async () => {}, finishNativeTool: async () => {},
    ...overrides,
  });
  const credentials = vi.fn(async () => ACCESS_TOKEN);
  const adapter = new PiAgentAdapter({
    spawn: () => { throw new Error('SDK must not start the core worker'); },
    spawnSdk: () => {
      const pair = memoryChannelPair();
      pair.host.onFrame((frame) => frames.push(frame));
      runSdkWorker(pair.worker, {
        streamFn: faux.streamSimple, resolveModel: () => faux.getModel(), now: () => 1000,
        directory,
      });
      return pair.host;
    },
    harness: async () => ({ extensions: [{ path, hash, source: 'extension:fixture@1.0.0' }], skills: [], startupCommands: [] }),
    credentials, cancelGraceMs: 200,
  });
  return { adapter, host, calls, frames, reports, requests, credentials, directory };
}

describe('SDK worker through the product adapter (H2)', () => {
  it('[TC-HAR-009-N] refuses a binding without a resolved snapshot before spawning or looking up credentials', async () => {
    const spawn = vi.fn();
    const credentials = vi.fn();
    const adapter = new PiAgentAdapter({ spawn, credentials });
    const start = input();
    delete start.harness;
    await expect(adapter.start(start, recordingHost().host)).rejects.toThrow(/harness/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });

  it('[TC-HAR-001-H] [TC-HAR-003-H] records and permits the real context for each request and retry', async () => {
    const run = runtime([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'The service is temporarily unavailable' }),
      fauxAssistantMessage('Recovered.'),
    ]);
    const handle = await run.adapter.start(input(), run.host);
    expect(await handle.waitForSettlement()).toMatchObject({ outcome: 'succeeded' });
    expect(run.credentials).toHaveBeenCalledTimes(2);
    expect(run.requests).toMatchObject([{ purpose: 'turn', directiveIds: [] }, { purpose: 'retry', directiveIds: [] }]);
    expect(run.calls.filter(c => c.startsWith('observe'))).toEqual(['observe call_1', 'observe call_2']);
    expect(run.reports).toMatchObject([{ ok: true, snapshotHash: hash }]);
    for (const request of run.requests) expect(request).toMatchObject({ contextHash: expect.stringMatching(/^[a-f0-9]{64}$/), contextBytes: expect.any(Number) });
    expect(JSON.stringify(run.requests)).not.toContain('Private brief.');
    expect(JSON.stringify(run.requests)).not.toContain(run.directory);
    expect(JSON.stringify(run.frames)).not.toContain(ACCESS_TOKEN);
  });

  it('[TC-HAR-002-H] authorizes final extension arguments, then starts and settles the unmanaged effect', async () => {
    const order: string[] = [];
    const run = runtime([
      fauxAssistantMessage([fauxToolCall('echo', { text: 'before' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ], `export default pi => {
      pi.registerTool({name:'echo',label:'Echo',description:'Echo text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:true,openWorldHint:false},execute:async (_id,args) => ({content:[{type:'text',text:args.text}],details:{}})});
      pi.on('tool_call', event => { if(event.toolName==='echo') event.input.text='after'; });
    }`, {
      authorizeTool: async proposal => { expect(proposal.args).toEqual({ text: 'after' }); order.push('authorized'); return { ok: true, toolCallId: 'tool_1' }; },
      beginNativeTool: async (_id, argsHash) => { expect(argsHash).toMatch(/^[a-f0-9]{64}$/); order.push('started'); },
      finishNativeTool: async (_id, outcome) => { expect(outcome).toBe('succeeded'); order.push('finished'); },
    });
    expect(await (await run.adapter.start(input(), run.host)).waitForSettlement()).toMatchObject({ outcome: 'succeeded' });
    expect(order).toEqual(['authorized', 'started', 'finished']);
  });

  it('[TC-HAR-001-N] a refused permit makes no provider request', async () => {
    let dispatched = 0;
    const run = runtime([() => { dispatched++; return fauxAssistantMessage('Must not run'); }], '', {
      prepareModelRequest: async () => { throw new Error('budget exhausted'); },
    });
    expect(await (await run.adapter.start(input(), run.host)).waitForSettlement()).toMatchObject({ outcome: 'failed' });
    expect(dispatched).toBe(0);
    expect(run.credentials).not.toHaveBeenCalled();
  });

  it('[TC-HAR-006-N] a required extension that fails to load fails without a model request or fallback', async () => {
    const run = runtime([fauxAssistantMessage('Must not run')], 'throw new Error("private path/body");');
    expect(await (await run.adapter.start(input(), run.host)).waitForSettlement()).toMatchObject({ outcome: 'failed' });
    expect(run.credentials).not.toHaveBeenCalled();
    expect(run.reports).toMatchObject([{ ok: false, code: 'extension_load_failed' }]);
    expect(JSON.stringify(run.reports)).not.toContain('private path/body');
  });

  it('[TC-HAR-002-N] a denied native tool never starts', async () => {
    const begin = vi.fn();
    const run = runtime([
      fauxAssistantMessage([fauxToolCall('echo', {})], { stopReason: 'toolUse' }), fauxAssistantMessage('Denied.'),
    ], `export default pi => pi.registerTool({name:'echo',label:'Echo',description:'Echo',parameters:{type:'object',properties:{}},execute:async () => { throw new Error('must not execute'); }});`, {
      authorizeTool: async () => ({ ok: false, toolCallId: 'tool_no', error: { code: 'CAPABILITY_DENIED', message: 'denied' } }),
      beginNativeTool: begin,
    });
    await (await run.adapter.start(input(), run.host)).waitForSettlement();
    expect(begin).not.toHaveBeenCalled();
  });

  it('[TC-HAR-006-H] cancellation ends the SDK execution and fences a late answer', async () => {
    const gate = new Gate();
    const entered = new Gate();
    const run = runtime([async () => { entered.open(); await gate.wait(); return fauxAssistantMessage('Late'); }]);
    const handle = await run.adapter.start(input(), run.host);
    await entered.wait();
    await handle.cancel('user cancelled');
    gate.open();
    expect(await handle.waitForSettlement()).toMatchObject({ outcome: 'cancelled' });
  });
});
