import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, type RunEvent } from '@corral/contracts';
import {
  Coordinator,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '@corral/core';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { startCompatibleEndpoint } from '@corral/testkit/endpoint';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { processChannel } from '../src/channel.ts';
import { endpointProvider } from '../src/endpoint.ts';
import { SDK_WORKER_ENTRY, sdkProcessChannel, WORKER_ENTRY } from '../src/index.ts';
import { modelBridgeChannel } from '../src/model-bridge.ts';
import { LEGACY_PROTOCOL_VERSION as PROTOCOL_VERSION } from '../src/protocol.ts';
import { requestCredentials } from '../src/request-credentials.ts';
import { sandboxChannel } from '../src/sandbox-channel.ts';
import { liveModels } from './harness.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'faux-worker.ts');
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
  it.skipIf(process.platform === 'win32').each(['kill', 'exit'])(
    '[TC-HAR-006-N] worker %s also ends its ordinary child processes',
    async (mode) => {
      const channel = processChannel(join(import.meta.dirname, 'fixtures', 'process-group.ts'));
      const ready = new Promise<{ port: number; pid: number }>((resolve) =>
        channel.onFrame((frame) => resolve(frame as { port: number; pid: number })),
      );
      const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));
      const child = await ready;
      const listening = () =>
        new Promise<boolean>((resolve) => {
          const socket = createConnection({ host: '127.0.0.1', port: child.port });
          socket.once('connect', () => {
            socket.destroy();
            resolve(true);
          });
          socket.once('error', () => {
            socket.destroy();
            resolve(false);
          });
        });
      try {
        expect(await listening()).toBe(true);
        if (mode === 'kill') channel.kill();
        else channel.send({ type: 'exit' });
        await exited;
        await expect.poll(listening).toBe(false);
      } finally {
        channel.kill();
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* Already stopped as expected. */
        }
      }
    },
  );
  it('[TC-RUN-007-N] exits when the owning coordinator process disconnects', async () => {
    const child = fork(join(import.meta.dirname, 'fixtures', 'orphan-worker.ts'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      await new Promise<void>((resolve) => child.once('message', () => resolve()));
      child.disconnect();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        exited,
        new Promise<string>((resolve) => {
          timeout = setTimeout(() => resolve('still alive'), 500);
        }),
      ]);
      clearTimeout(timeout);
      expect(result).toBe(1);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });

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
          inputs: [{ name: 'brief', artifactVersionId: null, text: 'Brief.' }],
          criteriaVersionId: 'crit_0001',
          round: null,
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

  it.each([
    ['keyless core', true, 'Bearer no-key', false, false] as const,
    ['keyed core', false, 'Bearer per-request-key', false, false] as const,
    ['keyless SDK', true, 'Bearer no-key', true, false] as const,
    ['keyed SDK', false, 'Bearer per-request-key', true, false] as const,
    ['text-only core', true, 'Bearer no-key', false, false, false] as const,
    ['text-only SDK', true, 'Bearer no-key', true, false, false] as const,
    ...(process.env.CORRAL_SANDBOX_PROBE === '1'
      ? [
          ['sandbox core', false, 'Bearer per-request-key', false, true] as const,
          ['sandbox SDK', false, 'Bearer per-request-key', true, true] as const,
        ]
      : []),
  ])(
    '[TC-RESUME-001-H] [TC-IMAGE-001-H] [TC-QEVAL-002-H] [TC-SEC-002-H] runs a live step on a %s OpenAI-compatible endpoint, with only the right key (CR-005)',
    async (_name, keyless, authorization, sdk, sandbox, withImage: boolean = true) => {
      const endpoint = await startCompatibleEndpoint();
      const resourceRoot = mkdtempSync(join(tmpdir(), 'corral-skill-wire-'));
      const credentials = requestCredentials();
      const hostModels = builtinModels({ credentials: credentials.store });
      hostModels.setProvider(
        endpointProvider('local', {
          name: 'Local',
          baseUrl: endpoint.baseUrl,
          keyless,
          models: [
            {
              id: 'llama3.2',
              contextWindow: 8000,
              maxOutput: 512,
              reasoning: false,
              imageInput: true,
            },
          ],
        }),
      );
      const isolated = (entry: string) =>
        modelBridgeChannel(sandboxChannel(entry, { contentRoots: sdk ? [resourceRoot] : [] }), {
          model: hostModels.getModel('local', 'llama3.2')!,
          streamFn: (model, context, options) => {
            if (options?.apiKey) credentials.use(model.provider, options.apiKey);
            return hostModels.streamSimple(model, context, options);
          },
        });
      const skillText = 'Always cite sources.';
      writeFileSync(join(resourceRoot, 'SKILL.md'), skillText);
      const files = [
        {
          path: 'SKILL.md',
          hash: createHash('sha256').update(skillText).digest('hex'),
          bytes: Buffer.byteLength(skillText),
        },
      ];
      const resourceHash = createHash('sha256').update(canonicalJson(files)).digest('hex');
      try {
        let calls = 0;
        const payloadHashes: string[] = [];
        endpoint.setReply((body) => {
          payloadHashes.push(createHash('sha256').update(canonicalJson(body)).digest('hex'));
          calls += 1;
          if (sdk) expect(JSON.stringify(body)).toContain(skillText);
          expect(JSON.stringify(body)).toContain('Historical result before interruption.');
          expect(JSON.stringify(body)).toContain('Earlier messages are historical context only');
          if (withImage)
            expect(JSON.stringify(body)).toContain(`data:image/png;base64,${image.data}`);
          const written = [...JSON.stringify(body).matchAll(/artv_[A-Za-z0-9]+/g)].at(-1)?.[0];
          if (calls === 1)
            return { toolCall: { name: 'write_artifact', args: { text: 'Hi from the endpoint' } } };
          if (calls === 2)
            return { toolCall: { name: 'submit_result', args: { artifactVersionIds: [written] } } };
          return 'Done.';
        });
        const harness = {
          binding: { profileId: 'empty', revision: 1 },
          snapshotHash: 'a'.repeat(64),
          piVersion: '1.3.0' as const,
          policyRevision: 1,
          policy: 'strict' as const,
          resources: sdk
            ? [
                {
                  hash: resourceHash,
                  name: 'fixture',
                  version: '1',
                  kind: 'skill' as const,
                  entry: 'SKILL.md',
                  required: true,
                  skillName: 'writing',
                  skillMode: 'mandatory' as const,
                },
              ]
            : [],
          allowedTools: ['write_artifact', 'submit_result'],
          tools: [],
          diagnostics: [],
        };
        const transport = new InProcessTransport(
          new Coordinator({
            clock: new FakeClock(),
            ids: new SequentialIdFactory(),
            ...(sdk ? { harnesses: { resolve: () => harness } } : {}),
            images: { read: () => image },
            runtimeRecovery: { confirm: async () => {} },
            agents: {
              start: (input, host) =>
                new PiAgentAdapter({
                  spawn: () => (sandbox ? isolated(WORKER_ENTRY) : processChannel(WORKER_ENTRY)),
                  spawnSdk: () =>
                    sandbox ? isolated(SDK_WORKER_ENTRY) : sdkProcessChannel(SDK_WORKER_ENTRY),
                  harness: async () => ({
                    extensions: [],
                    skills: sdk
                      ? [
                          {
                            name: 'writing',
                            description: 'Fixture',
                            hash: resourceHash,
                            entry: 'SKILL.md',
                            mode: 'mandatory' as const,
                            content: skillText,
                          },
                        ]
                      : [],
                    startupCommands: [],
                    bundles: sdk ? [{ root: resourceRoot, hash: resourceHash, files }] : [],
                  }),
                  // The host never hands a key for a keyless endpoint; the worker drops one anyway.
                  credentials: async () => 'per-request-key',
                  endpoint: (model) =>
                    model.provider === 'local'
                      ? {
                          name: 'Local',
                          baseUrl: endpoint.baseUrl,
                          keyless,
                          models: [
                            {
                              id: 'llama3.2',
                              contextWindow: 8000,
                              maxOutput: 512,
                              reasoning: false,
                              imageInput: true,
                            },
                          ],
                        }
                      : null,
                }).start(
                  {
                    ...input,
                    resumeContext: {
                      version: 1,
                      role: input.role,
                      criteria: 'Cite sources.',
                      protectedContext: {
                        version: 1,
                        text: 'Historical criteria.',
                        hash: createHash('sha256')
                          .update(canonicalJson('Historical criteria.'))
                          .digest('hex'),
                      },
                      context: {
                        version: 1,
                        piVersion: '1.3.0',
                        runtime: sdk ? 'pi-sdk' : 'pi-core',
                        contextHash: 'a'.repeat(64),
                        context: {
                          messages: [
                            { role: 'user', content: 'Historical request.', timestamp: 1 },
                            fauxAssistantMessage(
                              [
                                fauxToolCall(
                                  'write_artifact',
                                  { text: 'Historical result before interruption.' },
                                  { id: 'old_write' },
                                ),
                              ],
                              { stopReason: 'toolUse' },
                            ) as unknown as Record<string, unknown>,
                            {
                              role: 'toolResult',
                              toolCallId: 'old_write',
                              toolName: 'write_artifact',
                              content: [{ type: 'text', text: 'artv_old0001' }],
                              isError: false,
                              timestamp: 2,
                            },
                          ],
                        },
                      },
                    },
                  },
                  host,
                ),
            },
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
                  : {
                      ok: true,
                      snapshot: { profile, provider: null, modelId: null, auth: 'mock' },
                    },
            },
          }),
        );
        const definition = linearCorral(['writer']);
        if (sdk) definition.roles[0]!.harness = harness.binding;
        const { data: _data, ...reference } = image;
        if (withImage) definition.input.images = [reference];
        const result = await transport.startRun({
          schemaVersion: '0.1',
          commandId: 'cmd_process',
          sessionId: 'session_images',
          definition,
          mode: 'live',
        });
        const runId = result.runId!;
        const final = await waitForProjection(transport, runId, settled);
        expect(final.status).toBe('succeeded');
        expect(
          Object.values(final.toolCalls).filter((tool) => tool.name === 'write_artifact'),
        ).toHaveLength(1);
        expect(Object.values(final.runtimeCheckpoints ?? {})).not.toHaveLength(0);
        const output = final.output?.artifactVersionIds[0] ?? '';
        expect(await transport.getArtifactText(runId, output)).toBe('Hi from the endpoint');
        expect(endpoint.models.every((m) => m === 'llama3.2')).toBe(true);
        expect(endpoint.authorizations.length).toBeGreaterThan(1);
        expect(endpoint.authorizations.every((a) => a === authorization)).toBe(true);
        {
          const events: RunEvent[] = [];
          const stop = transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
          await Promise.resolve();
          stop();
          const records = events.filter((event) => event.type === 'model.request_recorded');
          expect(records.length).toBeGreaterThan(0);
          expect(
            records.every((event) => event.payload.contextEstimate?.method === 'pi-1.3.0-messages'),
          ).toBe(true);
          expect(
            events
              .filter((e) => e.type === 'model.payload_recorded')
              .map((e) => e.payload.payloadHash),
          ).toEqual(payloadHashes);
          for (const event of events.filter((event) => event.type === 'model.payload_recorded')) {
            const usage = event.payload.contextUsage;
            expect(usage).toMatchObject({
              coverage: 'request',
              completeness: withImage ? 'partial' : 'complete',
            });
            expect(usage?.usedTokens).toBe(
              usage?.parts.reduce((sum, part) => sum + part.tokens, 0),
            );
            expect(
              usage?.parts.find((part) => part.category === 'system_tools')?.tokens,
            ).toBeGreaterThan(0);
            expect(usage?.parts.find((part) => part.category === 'messages')?.omission).toBe(
              withImage ? 'unmeasured_image' : undefined,
            );
            if (sdk)
              expect(
                usage?.parts.find((part) => part.category === 'skills')?.tokens,
              ).toBeGreaterThan(0);
            expect(JSON.stringify(usage)).not.toContain(skillText);
            expect(JSON.stringify(usage)).not.toContain(resourceRoot);
          }
          expect(
            events
              .filter((event) => event.type === 'model.payload_recorded')
              .map((event) => event.payload.skills),
          ).toEqual(
            payloadHashes.map(() =>
              sdk ? [expect.objectContaining({ name: 'writing', resourceHash })] : [],
            ),
          );
        }
      } finally {
        await endpoint.close();
        rmSync(resourceRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
