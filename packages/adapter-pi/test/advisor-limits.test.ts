import type { CorralDefinition, RunEvent } from '@corral/contracts';
import {
  Coordinator,
  InProcessTransport,
  type RunProjection,
  resolveProfileContext,
  waitForProjection,
} from '@corral/core';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { startCompatibleEndpoint } from '@corral/testkit/endpoint';
import {
  createFauxCore,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair, processChannel } from '../src/channel.ts';
import { WORKER_ENTRY } from '../src/index.ts';
import { runWorker } from '../src/worker.ts';
import { ADVICE_DIRECTIVE_PREFIX } from '../src/worker-tools.ts';
import { ACCESS_TOKEN, liveModels } from './harness.ts';

// An advisor's limits under the Coordinator and the real core worker
// (docs/specs/features/advisor.md): what it is given, its request cap per review, how a cap
// ends a review, and its name. Scripted (faux) models and a local endpoint only.

const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const said = (context: TranscriptContext) => JSON.stringify(context.messages);
const isAdvisor = (context: TranscriptContext) =>
  said(context).includes('You are an advisor in a Corral run');
const isSummary = (context: TranscriptContext) =>
  said(context).includes('internal context-compaction');
const idle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await idle(5);
  }
  return false;
};

function definition(maxRequestsPerReview = 8, name = 'Fact checker'): CorralDefinition {
  const corral = linearCorral(['writer']);
  corral.limits = { ...corral.limits, maxModelConcurrency: 4 };
  corral.roles.push({
    id: 'advisor_role',
    name,
    prompt: 'Flag claims without a source.',
    modelProfile: 'model-a',
    allowedWorkTools: [],
    allowedCollaborationTools: [],
    outputContract: 'notes',
  });
  corral.nodes.push({
    id: 'advisor',
    type: 'agent',
    label: 'advisor',
    roleId: 'advisor_role',
    invocation: 'observer',
    outputName: 'notes',
    review: { interval: 1, maxRequestsPerReview },
  } as CorralDefinition['nodes'][number]);
  corral.capabilityLinks.push({
    id: 'watch_writer',
    kind: 'advise',
    sourceNodeId: 'advisor',
    targetNodeId: 'writer',
  });
  return corral;
}

function lastArtifactVersion(context: TranscriptContext): string {
  for (const message of [...context.messages].reverse()) {
    const result = message as { role?: string; toolName?: string; content?: unknown };
    if (result.role !== 'toolResult' || result.toolName !== 'write_artifact') continue;
    const id = /artifactVersionId\\":\\"([^\\]+)\\"/.exec(JSON.stringify(result.content))?.[1];
    if (id) return id;
  }
  throw new Error('no write_artifact result in the transcript');
}
const advising = (note: string) =>
  fauxAssistantMessage([fauxToolCall('advise', { severity: 'concern', note })], {
    stopReason: 'toolUse',
  });
const writing = (text: string) =>
  fauxAssistantMessage([fauxToolCall('write_artifact', { text })], { stopReason: 'toolUse' });
const submitting = (context: TranscriptContext) =>
  fauxAssistantMessage(
    [fauxToolCall('submit_result', { artifactVersionIds: [lastArtifactVersion(context)] })],
    { stopReason: 'toolUse' },
  );
const failing = () =>
  fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'fetch failed' });

type Frame = { type: string; executionId?: string; [key: string]: unknown };

/** The Coordinator, the Pi adapter and in-process core workers on one faux queue. */
function runtime(
  advisor: FauxResponseStep[],
  writer: FauxResponseStep[],
  onWorkerFrame?: (frame: Frame, advisorId: string | null) => void,
  /** Keeps only this many recent tokens when a compaction runs. */
  keepRecentTokens?: number,
) {
  const faux = createFauxCore({});
  const advisorSeen: TranscriptContext[] = [];
  const step = (list: FauxResponseStep[], fallback: string): FauxResponseStep =>
    list.shift() ?? fauxAssistantMessage(fallback);
  const dispatch: FauxResponseStep = (context, options, state, model) => {
    let next: FauxResponseStep;
    if (isSummary(context)) next = fauxAssistantMessage('SUMMARY of the earlier reviews.');
    else if (isAdvisor(context)) {
      advisorSeen.push(context);
      next = step(advisor, 'Nothing to add.');
    } else next = step(writer, 'Done.');
    return typeof next === 'function' ? next(context, options, state, model) : next;
  };
  faux.setResponses(Array.from({ length: 80 }, () => dispatch));
  const toWorker: Frame[] = [];
  const fromWorker: Frame[] = [];
  let advisorId: string | null = null;
  const adapter = new PiAgentAdapter({
    spawn: () => {
      const { host, worker } = memoryChannelPair();
      const send = host.send.bind(host);
      host.send = (frame) => {
        const f = frame as Frame;
        if (f.type === 'start' && (f.assignment as { kind?: string })?.kind === 'advisor')
          advisorId = f.executionId ?? null;
        toWorker.push(f);
        send(frame);
      };
      host.onFrame((frame) => {
        fromWorker.push(frame as Frame);
        onWorkerFrame?.(frame as Frame, advisorId);
      });
      runWorker(worker, { streamFn: faux.streamSimple, resolveModel: () => faux.getModel() });
      return host;
    },
    credentials: async () => ACCESS_TOKEN,
  });
  const transport = new InProcessTransport(
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: adapter,
      models: keepRecentTokens
        ? {
            resolve: (profile, mode) => {
              const resolved = liveModels.resolve(profile, mode);
              const policy = resolveProfileContext(
                { contextWindow: 64_000, compaction: { reserveTokens: 0, keepRecentTokens } },
                { contextWindow: 64_000, source: 'catalog' },
                'small-recent',
                256,
              ).policy;
              if (!resolved.ok || !policy) return resolved;
              return {
                ok: true,
                snapshot: { ...resolved.snapshot, contextWindow: 64_000, contextPolicy: policy },
              };
            },
          }
        : liveModels,
    }),
  );
  const advisorFrames = (side: Frame[]) =>
    side
      .filter((f) => f.executionId === advisorId)
      .map((f) =>
        f.type === 'prepare_request'
          ? `prepare_request:${(f.record as { purpose?: string } | undefined)?.purpose}`
          : f.type,
      );
  return {
    transport,
    advisorSeen,
    fromAdvisor: () => advisorFrames(fromWorker),
    toAdvisor: () => advisorFrames(toWorker),
  };
}

async function start(r: ReturnType<typeof runtime>, corral: CorralDefinition) {
  const { runId, receipt } = await r.transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_limits',
    definition: corral,
    mode: 'live',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  r.transport.subscribe(runId, 0, { onEvent: (e) => events.push(e), onFrame: () => {} });
  return { runId, events };
}
const executionOf = (p: RunProjection, nodeId: string) =>
  Object.values(p.executions).find((e) => e.nodeId === nodeId);
/** The writer goes on once the advisor rests between reviews, or has ended. */
const advisorRests = (r: ReturnType<typeof runtime>, runId: () => string) => async () => {
  const p = (await r.transport.getSnapshot(runId())).projection;
  const a = executionOf(p, 'advisor');
  return (
    !!a &&
    (['succeeded', 'failed', 'cancelled'].includes(a.status) ||
      (a.status === 'waiting_message' && a.modelCallIds.length > 0))
  );
};
const turnRequests = (final: RunProjection, events: RunEvent[]) => {
  const advisor = executionOf(final, 'advisor')?.executionId;
  return events.filter(
    (e) =>
      e.type === 'model.request_recorded' &&
      e.executionId === advisor &&
      e.payload.purpose !== 'compaction',
  ).length;
};

describe('the request cap of a review', () => {
  it('a cap above 64 is refused when the run starts', async () => {
    const r = runtime([], []);
    const { runId, receipt } = await r.transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_cap65',
      definition: definition(65),
      mode: 'live',
    });
    expect(runId).toBeNull();
    expect(receipt.error?.code).toBe('SCHEMA_INVALID');
  });

  it('a cap of 64 reaches the worker, whose review frame takes it', async () => {
    let runId = '';
    const r = runtime(
      [advising('The cheese claim has no source.')],
      [
        writing('Draft: the moon is made of cheese.'),
        async (context) => {
          await until(advisorRests(r, () => runId));
          return submitting(context);
        },
      ],
    );
    const s = await start(r, definition(64));
    runId = s.runId;
    const final = await waitForProjection(r.transport, runId, settled);
    expect(final.status).toBe('succeeded');
    expect(executionOf(final, 'advisor')?.status).toBe('succeeded');
    expect(r.toAdvisor()).toContain('review');
  });

  for (const cap of [1, 2])
    it(`a person’s directive while the advisor prepares does not use up a cap of ${cap}`, async () => {
      let runId = '';
      let steered = false;
      const r = runtime(
        [advising('The cheese claim has no source.'), advising('The date is missing.')],
        [
          writing('Draft: the moon is made of cheese.'),
          async (context) => {
            await until(advisorRests(r, () => runId));
            return submitting(context);
          },
        ],
        (frame, advisorId) => {
          if (steered || frame.type !== 'prepare_request' || frame.executionId !== advisorId)
            return;
          steered = true;
          void r.transport.sendCommand({
            schemaVersion: '0.1',
            commandId: 'cmd_steer_advisor',
            runId,
            type: 'steer',
            payload: {
              targetExecutionId: advisorId,
              text: 'Check the dates too.',
              delivery: 'next_request',
            },
          });
        },
      );
      const s = await start(r, definition(cap));
      runId = s.runId;
      const final = await waitForProjection(r.transport, runId, settled);
      expect(final.status).toBe('succeeded');
      expect(executionOf(final, 'advisor')?.status).toBe('succeeded');
      expect(r.fromAdvisor()).toContain('prepare_request:turn');
      expect(r.toAdvisor()).not.toContain('refused');
      // The first review made as many requests as its cap allows, the directive's included.
      expect(turnRequests(final, s.events)).toBeGreaterThanOrEqual(cap);
      if (cap === 2)
        expect(r.advisorSeen[1] && said(r.advisorSeen[1])).toContain('Check the dates too.');
    });

  for (const cap of [1, 2])
    it(`a retried request counts against a cap of ${cap}, and the cap is no failure`, async () => {
      let runId = '';
      const r = runtime(
        [failing, advising('The cheese claim has no source.')],
        [
          writing('Draft: the moon is made of cheese.'),
          async (context) => {
            await until(
              advisorRests(r, () => runId),
              8000,
            );
            return submitting(context);
          },
        ],
      );
      const s = await start(r, definition(cap));
      runId = s.runId;
      const final = await waitForProjection(r.transport, runId, settled);
      expect(final.status).toBe('succeeded');
      expect(executionOf(final, 'advisor')?.status).toBe('succeeded');
      expect(r.toAdvisor()).not.toContain('refused');
      const first = r.fromAdvisor().indexOf('next_review', 1);
      const firstReview = r.fromAdvisor().slice(0, first);
      // cap 1: the failed attempt is the review's one request; cap 2: it and its retry.
      expect(firstReview.filter((f) => f.startsWith('prepare_request:')).length).toBe(cap);
    });

  it('a cap of 1 and a compaction: the summary does not count, the review request goes out', async () => {
    let runId = '';
    const r = runtime(
      [
        async () => {
          const p = (await r.transport.getSnapshot(runId)).projection;
          const a = executionOf(p, 'advisor');
          const receipt = await r.transport.sendCommand({
            schemaVersion: '0.1',
            commandId: 'cmd_compact_advisor',
            runId,
            type: 'compact_context',
            expectedControlRevision: p.controlRevision,
            payload: { executionId: a?.executionId ?? '', attemptNo: a?.attemptNo ?? 1 },
          });
          expect(receipt.status).toBe('accepted');
          return advising('The cheese claim has no source.');
        },
        advising('The second claim has no date.'),
      ],
      [
        writing('Draft: the moon is made of cheese.'),
        async () => {
          await until(advisorRests(r, () => runId));
          return writing('Draft two.');
        },
        async (context) => {
          await until(advisorRests(r, () => runId));
          await idle(50);
          return submitting(context);
        },
      ],
      undefined,
      50,
    );
    const s = await start(r, definition(1));
    runId = s.runId;
    const final = await waitForProjection(r.transport, runId, settled);
    expect(final.status).toBe('succeeded');
    expect(executionOf(final, 'advisor')?.status).toBe('succeeded');
    const frames = r.fromAdvisor();
    const summary = frames.indexOf('prepare_request:compaction');
    expect(summary).toBeGreaterThan(0);
    expect(frames.slice(summary + 1)).toContain('prepare_request:turn');
    expect(
      s.events.filter((e) => e.type === 'context.compaction_changed').map((e) => e.payload.phase),
    ).toContain('completed');
    expect(r.toAdvisor()).not.toContain('refused');
  });
});

describe('the advisor’s name', () => {
  it('is the same in its instructions and on its advice', async () => {
    let runId = '';
    let carried = '';
    const r = runtime(
      [advising('The cheese claim has no source.')],
      [
        writing('Draft: the moon is made of cheese.'),
        async () => {
          await until(advisorRests(r, () => runId));
          return writing('Draft two.');
        },
        (context) => {
          carried = said(context);
          return submitting(context);
        },
      ],
    );
    const s = await start(r, definition(8, 'Fact (checker)\nof claims'));
    runId = s.runId;
    const final = await waitForProjection(r.transport, runId, settled);
    expect(final.status).toBe('succeeded');
    const name = 'Fact checker of claims';
    expect(said(r.advisorSeen[0] as TranscriptContext)).toContain(
      `Your name on your advice is ${JSON.stringify(JSON.stringify(name)).slice(1, -1)}.`,
    );
    expect(carried).toContain(`${ADVICE_DIRECTIVE_PREFIX}concern from ${name},`);
  });
});

describe('what the advisor is given, in a real worker process', () => {
  const image = {
    kind: 'image_attachment' as const,
    imageId: 'image_pixel',
    name: 'pixel.png',
    mime: 'image/png' as const,
    bytes: 70,
    sha256: '7d91c846b70d9450a30d1ea73dc15d2e7888dfa3b2a84b297bb5272ae23daf39',
    width: 1,
    height: 1,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==',
  };

  it('a run with an image: the advisor reviews without it and succeeds', async () => {
    const endpoint = await startCompatibleEndpoint();
    const spec = {
      name: 'Local',
      baseUrl: endpoint.baseUrl,
      keyless: true,
      models: [
        { id: 'llama3.2', contextWindow: 8000, maxOutput: 512, reasoning: false, imageInput: true },
      ],
    };
    const asked: { advisor: boolean; image: boolean }[] = [];
    let writerCalls = 0;
    endpoint.setReply((body: unknown) => {
      const text = JSON.stringify(body);
      const advisor = text.includes('You are an advisor in a Corral run');
      asked.push({ advisor, image: text.includes(image.data) });
      if (advisor) return 'Nothing to add.';
      writerCalls += 1;
      const written = [...text.matchAll(/artv_[A-Za-z0-9]+/g)].at(-1)?.[0];
      if (writerCalls === 1)
        return { toolCall: { name: 'write_artifact', args: { text: 'Hi from the endpoint' } } };
      if (writerCalls === 2)
        return { toolCall: { name: 'submit_result', args: { artifactVersionIds: [written] } } };
      return 'Done.';
    });
    try {
      const transport = new InProcessTransport(
        new Coordinator({
          clock: new FakeClock(),
          ids: new SequentialIdFactory(),
          images: { read: () => image },
          agents: new PiAgentAdapter({
            spawn: () => processChannel(WORKER_ENTRY),
            credentials: async () => 'per-request-key',
            endpoint: (model) => (model.provider === 'local' ? spec : null),
          }),
          models: {
            resolve: (profile, mode) =>
              mode === 'live'
                ? {
                    ok: true,
                    snapshot: {
                      profile,
                      provider: 'local',
                      modelId: 'llama3.2',
                      imageInput: true,
                      auth: 'api_key',
                    },
                  }
                : { ok: true, snapshot: { profile, provider: null, modelId: null, auth: 'mock' } },
          },
        }),
      );
      const corral = definition();
      const { data: _data, ...reference } = image;
      corral.input.images = [reference];
      const result = await transport.startRun({
        schemaVersion: '0.1',
        commandId: 'cmd_image',
        sessionId: 'session_images',
        definition: corral,
        mode: 'live',
      });
      if (!result.runId) throw new Error(JSON.stringify(result.receipt.error));
      const final = await waitForProjection(transport, result.runId, settled);
      expect(final.status).toBe('succeeded');
      expect(executionOf(final, 'advisor')?.status).toBe('succeeded');
      expect(asked.some((a) => a.advisor)).toBe(true);
      expect(asked.filter((a) => a.advisor && a.image)).toEqual([]);
      // The writer still got the image.
      expect(asked.some((a) => !a.advisor && a.image)).toBe(true);
    } finally {
      await endpoint.close();
    }
  }, 60_000);
});
