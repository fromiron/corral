import { join } from 'node:path';
import {
  Coordinator,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '@corral/core';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { processChannel } from '../src/channel.ts';
import { WORKER_ENTRY } from '../src/index.ts';
import { PROTOCOL_VERSION } from '../src/protocol.ts';
import { liveModels } from './harness.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'faux-worker.ts');
const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
});

function runtime(fixture: 'complete' | 'crash') {
  const adapter = new PiAgentAdapter({
    spawn: () => processChannel(FIXTURE, { env: { CORRAL_FIXTURE: fixture } }),
    credentials: async () => 'per-request-token',
  });
  return new InProcessTransport(
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: adapter,
      models: liveModels,
    }),
  );
}

async function run(transport: InProcessTransport) {
  const { runId } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_process',
    definition: linearCorral(['writer']),
    mode: 'live',
  });
  return { runId: runId ?? '', final: await waitForProjection(transport, runId ?? '', settled) };
}

describe('worker in a child process (C-017, ADR-017)', () => {
  it('completes a live step over IPC, and the worker gets no secret from the environment', async () => {
    process.env.OPENAI_API_KEY = 'sk-must-not-reach-the-worker';
    const transport = runtime('complete');
    const { runId, final } = await run(transport);
    expect(final.status).toBe('succeeded');
    const output = final.output?.artifactVersionIds[0] ?? '';
    expect(await transport.getArtifactText(runId, output)).toBe('env-has-key=false');
  }, 30_000);

  it('[TC-RUN-007-N] a worker that dies mid-request fails its execution and is not retried', async () => {
    const { final } = await run(runtime('crash'));
    expect(final.status).toBe('failed');
    const execution = Object.values(final.executions)[0];
    expect(execution?.status).toBe('failed');
    expect(execution?.error).toBe('the model worker stopped unexpectedly (exit 3)');
    expect(Object.keys(final.executions)).toHaveLength(1);
    const request = Object.values(final.effects).find((e) => e.kind === 'model_request');
    expect(request?.outcome).toBe('unknown');
  }, 30_000);

  it('the production worker entry loads pi-ai, says ready, and refuses an unknown model', async () => {
    const channel = processChannel(WORKER_ENTRY);
    const frames: { type: string; outcome?: string; error?: string }[] = [];
    const exited = new Promise<number | null>((resolve) => channel.onExit(resolve));
    channel.onFrame((frame) => {
      frames.push(frame as { type: string });
      if ((frame as { type: string }).type === 'ready') {
        channel.send({
          type: 'start',
          protocolVersion: PROTOCOL_VERSION,
          executionId: 'exec_1',
          model: { provider: 'openai', modelId: 'no-such-model' },
          role: { name: 'Writer', prompt: 'Write.', outputContract: 'text' },
          inputs: [{ name: 'brief', text: 'Brief.' }],
          tools: ['write_artifact', 'submit_result'],
          assignment: { kind: 'scheduled' },
          delegateTo: [],
          askTo: [],
        });
      }
    });
    expect(await exited).toBe(0);
    expect(frames.map((f) => f.type)).toEqual(['ready', 'settled']);
    expect(frames[1]).toMatchObject({
      outcome: 'failed',
      error: 'model openai/no-such-model is not available',
    });
  }, 30_000);
});
