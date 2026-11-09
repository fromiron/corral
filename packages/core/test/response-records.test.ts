import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

describe('model and document response lifetimes', () => {
  it('keeps completed response text during execution and releases it after the final result settles', async () => {
    const store = new InMemoryRunStore();
    const secondRequest = new Gate();
    const finish = new Gate();
    const transport = new InProcessTransport(
      new Coordinator({
        store,
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({
          turns: 2,
          beforeReply: async (turn) => {
            if (turn === 2) {
              secondRequest.open();
              await finish.wait();
            }
          },
        }),
      }),
    );
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    if (!runId) throw new Error('run start failed');
    await secondRequest.wait();
    const finished = store.readEvents(runId, 0).find((e) => e.type === 'model.finished');
    const ref = finished?.type === 'model.finished' ? finished.payload.responseRef : null;
    expect(ref).toBeTruthy();
    if (!ref) throw new Error('missing recorded response');
    expect(await transport.getArtifactText(runId, ref)).toContain('turn 1');
    finish.open();
    await waitForProjection(transport, runId, (p) => p.status === 'succeeded');
    const { projection: final } = await transport.getSnapshot(runId);
    expect(Object.values(final.modelCalls)[0]?.responseRef).toBe(ref);
    expect(await transport.getArtifactText(runId, ref)).toBeNull();
    expect(store.getArtifactText(runId, ref)).toBeNull();
    expect(
      await transport.getArtifactText(runId, final.output?.artifactVersionIds[0] ?? ''),
    ).toContain('turn 2');
  });

  it('freezes the fetched response and links only subsequent requests to it', async () => {
    const definition = linearCorral(['writer']);
    const role = definition.roles[0];
    if (!role) throw new Error('missing writer');
    role.allowedWorkTools.push('read_document');
    const store = new InMemoryRunStore();
    const responsesReady = new Gate();
    const finish = new Gate();
    const agents = new ScriptedAgentAdapter({
      turns: 1,
      script: async (_input, host) => {
        const first = await host.prepareModelRequest();
        await host.modelRequestDispatched?.(first.modelCallId);
        await host.observe({
          kind: 'model_completed',
          modelCallId: first.modelCallId,
          text: 'Reading.',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        const read = await host.invokeTool({
          name: 'read_document',
          args: { documentId: 'doc_1' },
        });
        expect(read.ok).toBe(true);
        const second = await host.prepareModelRequest();
        await host.modelRequestDispatched?.(second.modelCallId);
        await host.observe({
          kind: 'model_completed',
          modelCallId: second.modelCallId,
          text: 'Read.',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        responsesReady.open();
        await finish.wait();
        return { outcome: 'failed', error: 'no output submitted' };
      },
    });
    const transport = new InProcessTransport(
      new Coordinator({
        store,
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents,
        tools: {
          execute: async () => ({
            documentId: 'doc_1',
            title: 'Source',
            mimeType: 'text/plain',
            text: 'Immutable source text.',
          }),
        },
      }),
    );
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      definition,
      mode: 'mock',
    });
    if (!runId) throw new Error('run start failed');
    await responsesReady.wait();
    const { projection: active } = await transport.getSnapshot(runId);
    const finished = store.readEvents(runId, 0).find((e) => e.type === 'tool.finished');
    const ref = finished?.type === 'tool.finished' ? finished.payload.resultRef : null;
    expect(ref).toBeTruthy();
    if (!ref) throw new Error('missing recorded response');
    const body = await transport.getArtifactText(runId, ref);
    if (body === null) throw new Error('missing response body');
    expect(JSON.parse(body)).toMatchObject({
      documentId: 'doc_1',
      text: 'Immutable source text.',
    });
    const calls = Object.values(active.modelCalls);
    expect(calls[0]?.inputArtifactVersionIds).not.toContain(ref);
    expect(calls[1]?.inputArtifactVersionIds).toContain(ref);
    finish.open();
    await waitForProjection(transport, runId, (p) => p.status === 'failed');
    expect(await transport.getArtifactText(runId, ref)).toBeNull();
    expect(store.getArtifactText(runId, ref)).toBeNull();
    expect(
      (await transport.getSnapshot(runId)).projection.modelCalls[calls[1]?.modelCallId ?? '']
        ?.inputArtifactVersionIds,
    ).toContain(ref);
  });
});
