import type {
  AgentHost,
  AgentObservation,
  RequestPermit,
  TextDelta,
  ToolOutcome,
  ToolProposal,
} from '@corral/contracts';
import { Coordinator, InProcessTransport, type ModelResolver } from '@corral/core';
import { FakeClock, SequentialIdFactory } from '@corral/testkit';
import { createFauxCore, type FauxResponseStep } from '@earendil-works/pi-ai';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { runWorker } from '../src/worker.ts';

export const ACCESS_TOKEN = 'test-access-token-not-a-secret';

export const liveModels: ModelResolver = {
  resolve: (profile, mode) =>
    mode === 'live'
      ? { ok: true, snapshot: { profile, provider: 'openai', modelId: 'faux-1', auth: 'oauth' } }
      : { ok: true, snapshot: { profile, provider: null, modelId: null, auth: 'mock' } },
};

/** The Coordinator with the Pi adapter; the worker runs Pi in-process on pi-ai's faux model. */
export function liveRuntime(
  responses: FauxResponseStep[],
  options: { tokensPerSecond?: number } = {},
) {
  const faux = createFauxCore(
    options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond } : {},
  );
  faux.setResponses(responses);
  const credentialCalls: string[] = [];
  const adapter = new PiAgentAdapter({
    spawn: () => {
      const { host, worker } = memoryChannelPair();
      runWorker(worker, { streamFn: faux.streamSimple, resolveModel: () => faux.getModel() });
      return host;
    },
    credentials: async (model) => {
      credentialCalls.push(`${model.provider}/${model.modelId}`);
      return ACCESS_TOKEN;
    },
  });
  const transport = new InProcessTransport(
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: adapter,
      models: liveModels,
    }),
  );
  return { transport, faux, credentialCalls };
}

/** A host that records calls, for adapter tests without a Coordinator. */
export function recordingHost(overrides: Partial<AgentHost> = {}) {
  const calls: string[] = [];
  let calls_n = 0;
  const host: AgentHost = {
    prepareModelRequest: async (): Promise<RequestPermit> => {
      calls.push('prepare');
      calls_n += 1;
      return {
        modelCallId: `call_${calls_n}`,
        contextSnapshotId: `ctx_${calls_n}`,
        profile: 'model-a',
        maxOutputTokens: 256,
        directives: [],
      };
    },
    invokeTool: async (p: ToolProposal): Promise<ToolOutcome> => ({
      ok: true,
      toolCallId: 'tool_x',
      result: { name: p.name },
    }),
    authorizeTool: async () => ({ ok: true, toolCallId: 'tool_1' }),
    executeTool: async (toolCallId) => ({ ok: true, toolCallId, result: {} }),
    observe: async (o: AgentObservation) => void calls.push(`observe ${o.modelCallId}`),
    streamText: (d: TextDelta) => void calls.push(`stream ${d.chunkIndex}`),
    ...overrides,
  };
  return { host, calls };
}
