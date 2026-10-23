import type { AgentStartInput } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { PROTOCOL_VERSION, type SdkResources } from '../src/protocol.ts';
import { recordingHost } from './harness.ts';

function candidateRuntime() {
  const binding = { profileId: 'strict', revision: 1 };
  const input: AgentStartInput = {
    candidateComparison: true,
    runId: 'run_1',
    executionId: 'exec_1',
    taskId: 'task_1',
    nodeId: 'writer',
    attemptNo: 1,
    role: { ...linearCorral(['writer']).roles[0]!, harness: binding },
    harness: {
      binding,
      snapshotHash: 'a'.repeat(64),
      piVersion: '1.3.0',
      policyRevision: 1,
      policy: 'strict',
      resources: [],
      allowedTools: ['run_check'],
      tools: [],
      diagnostics: [],
      projectTools: {
        projectId: 'default',
        revision: 1,
        hash: 'b'.repeat(64),
        checkIds: ['types'],
        lspServerIds: [],
      },
    },
    modelProfile: 'model-a',
    mode: 'live',
    model: {
      profile: 'model-a',
      provider: 'openai',
      modelId: 'fixture',
      auth: 'api_key',
      workerIsolation: 'linux-bwrap',
    },
    depth: 0,
    round: null,
    criteriaVersionId: 'criteria_1',
    assignment: { kind: 'scheduled' },
    capabilities: { delegateTo: [], askTo: [] },
    inputs: [],
  };
  const resources: SdkResources = {
    extensions: [],
    skills: [],
    bundles: [],
    startupCommands: [],
  };
  const channel = memoryChannelPair();
  const frames: Record<string, unknown>[] = [];
  channel.worker.onFrame((frame) => frames.push(frame as Record<string, unknown>));
  const spawnSdk = vi.fn(() => channel.host);
  const authorizeTool = vi.fn(async () => ({ ok: true as const, toolCallId: 'tool_check' }));
  const executeTool = vi.fn(async (toolCallId: string) => ({
    ok: true as const,
    toolCallId,
    result: { verdict: 'pass', resultRef: 'report_1' },
  }));
  const { host } = recordingHost({
    reportHarness: async () => {},
    pendingDirectives: () => [],
    beginNativeTool: async () => {},
    finishNativeTool: async () => {},
    authorizeTool,
    executeTool,
  });
  const adapter = new PiAgentAdapter({
    spawn: () => {
      throw new Error('SDK required');
    },
    spawnSdk,
    harness: async () => resources,
    credentials: async () => null,
  });
  return { input, resources, channel, frames, spawnSdk, authorizeTool, executeTool, host, adapter };
}

it('[TC-ULTRA-002-H] isolated comparison executions advertise registered checks and execute them only through the host', async () => {
  const run = candidateRuntime();
  const handle = await run.adapter.start(run.input, run.host);
  try {
    expect(run.spawnSdk).toHaveBeenCalledWith(run.input, {
      ...run.resources,
      cwd: '/home/worker',
    });
    run.channel.worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    await expect.poll(() => run.frames.find((frame) => frame.type === 'start')).toBeDefined();
    expect(run.frames.find((frame) => frame.type === 'start')).toMatchObject({
      tools: ['run_check'],
    });
    const head = { protocolVersion: PROTOCOL_VERSION, executionId: run.input.executionId };
    run.channel.worker.send({
      ...head,
      type: 'authorize_tool',
      requestId: 'req_1',
      name: 'run_check',
      args: { commandId: 'types' },
    });
    await expect
      .poll(() => run.frames.find((frame) => frame.type === 'tool_authorization'))
      .toBeDefined();
    expect(run.executeTool).not.toHaveBeenCalled();
    run.channel.worker.send({
      ...head,
      type: 'execute_tool',
      requestId: 'req_2',
      toolCallId: 'tool_check',
    });
    await expect.poll(() => run.frames.find((frame) => frame.type === 'tool_result')).toBeDefined();
    expect(run.authorizeTool).toHaveBeenCalledExactlyOnceWith({
      name: 'run_check',
      args: { commandId: 'types' },
    });
    expect(run.executeTool).toHaveBeenCalledExactlyOnceWith('tool_check');
    expect(run.frames.find((frame) => frame.type === 'tool_result')).toMatchObject({
      ok: true,
      result: { verdict: 'pass', resultRef: 'report_1' },
    });
  } finally {
    run.channel.host.kill();
    await handle.waitForSettlement();
  }
});

it('[TC-ULTRA-002-N] a candidate ID alone grants no check exception and isolated comparisons still reject native resources and LSP', async () => {
  const cases: ((run: ReturnType<typeof candidateRuntime>) => void)[] = [
    ({ input }) => {
      delete input.candidateComparison;
      input.candidateId = 'candidate_1';
    },
    ({ input }) => {
      input.harness!.policy = 'trusted-native';
    },
    ({ resources }) => {
      resources.extensions = [{ path: '/fixture.ts', hash: 'a'.repeat(64), source: 'fixture' }];
    },
    ({ resources }) => {
      resources.startupCommands = ['/fixture'];
    },
    ({ resources }) => {
      resources.mcp = [
        {
          fingerprint: 'a'.repeat(64),
          server: {
            id: 'fixture',
            name: 'Fixture',
            transport: 'stdio',
            argv: ['fixture'],
            timeoutMs: 1000,
            exposure: 'direct',
          },
        },
      ];
    },
    ({ input }) => {
      input.harness!.projectTools!.lspServerIds = ['typescript'];
    },
  ];
  for (const mutate of cases) {
    const run = candidateRuntime();
    mutate(run);
    await expect(run.adapter.start(run.input, run.host)).rejects.toThrow(
      'native execution is unavailable',
    );
    expect(run.spawnSdk).not.toHaveBeenCalled();
  }
});
