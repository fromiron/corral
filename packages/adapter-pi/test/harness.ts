import type {
  AgentHost,
  AgentObservation,
  ProfileContextPolicy,
  RequestPermit,
  TextDelta,
  ToolOutcome,
  ToolProposal,
} from '@corral/contracts';
import { Coordinator, InProcessTransport, type ModelResolver } from '@corral/core';
import { FakeClock, SequentialIdFactory } from '@corral/testkit';
import type { StreamFn } from '@earendil-works/pi-agent-core';
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
  options: {
    tokensPerSecond?: number;
    contextPolicy?: ProfileContextPolicy;
    /** Wraps the faux stream, e.g. to see each request's signal. */
    wrapStream?: (stream: StreamFn) => StreamFn;
    /** Sees each frame the worker sends, before the host handles it. */
    onWorkerFrame?: (frame: unknown) => void;
    /** The provider wait the Coordinator holds before a model slot. */
    retryAfterMs?: () => number;
  } = {},
) {
  const faux = createFauxCore(
    options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond } : {},
  );
  faux.setResponses(responses);
  const credentialCalls: string[] = [];
  const adapter = new PiAgentAdapter({
    spawn: () => {
      const { host, worker } = memoryChannelPair();
      if (options.onWorkerFrame) host.onFrame(options.onWorkerFrame);
      runWorker(worker, {
        streamFn: options.wrapStream ? options.wrapStream(faux.streamSimple) : faux.streamSimple,
        resolveModel: () => faux.getModel(),
      });
      return host;
    },
    credentials: async (model) => {
      credentialCalls.push(`${model.provider}/${model.modelId}`);
      return ACCESS_TOKEN;
    },
  });
  const clock = new FakeClock();
  const transport = new InProcessTransport(
    new Coordinator({
      clock,
      // A provider wait passes only when the test advances the clock.
      ...(options.retryAfterMs ? { timers: clock } : {}),
      ids: new SequentialIdFactory(),
      agents: adapter,
      models: {
        ...(options.contextPolicy
          ? {
              resolve: (profile, mode) => {
                const resolved = liveModels.resolve(profile, mode);
                if (!resolved.ok || !options.contextPolicy) return resolved;
                return {
                  ok: true,
                  snapshot: {
                    ...resolved.snapshot,
                    contextWindow: options.contextPolicy.contextWindow,
                    contextPolicy: options.contextPolicy,
                  },
                };
              },
            }
          : liveModels),
        ...(options.retryAfterMs ? { retryAfterMs: options.retryAfterMs } : {}),
      },
    }),
  );
  return { transport, faux, credentialCalls, clock };
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
