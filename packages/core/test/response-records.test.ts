import {
  FakeClock,
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

describe('durable model and document responses', () => {
  it('recovers completed text without replaying transient frames', async () => {
    const store = new InMemoryRunStore();
    const transport = new InProcessTransport(
      new Coordinator({
        store,
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
      }),
    );
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    if (!runId) throw new Error('run start failed');
    const final = await waitForProjection(transport, runId, (p) => p.status === 'succeeded');
    const finished = store.readEvents(runId, 0).find((e) => e.type === 'model.finished');
    const ref = finished?.type === 'model.finished' ? finished.payload.responseRef : null;
    expect(ref).toBeTruthy();
    if (!ref) throw new Error('missing recorded response');
    expect(await transport.getArtifactText(runId, ref)).toContain('turn 1');
    expect(Object.values(final.modelCalls)[0]?.responseRef).toBe(ref);
  });

  it('freezes the fetched response and links only subsequent requests to it', async () => {
    const definition = linearCorral(['writer']);
    const role = definition.roles[0];
    if (!role) throw new Error('missing writer');
    role.allowedWorkTools.push('read_document');
    const store = new InMemoryRunStore();
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
    const final = await waitForProjection(transport, runId, (p) => p.status === 'failed');
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
    const calls = Object.values(final.modelCalls);
    expect(calls[0]?.inputArtifactVersionIds).not.toContain(ref);
    expect(calls[1]?.inputArtifactVersionIds).toContain(ref);
  });
});
