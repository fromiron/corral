import { createHash } from 'node:crypto';
import { linearCorral } from '@corral/testkit';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { runWorker } from '../src/worker.ts';
import { ACCESS_TOKEN, recordingHost } from './harness.ts';

it('[TC-ABS-010-H] core worker supplies image read pixels to its next model request', async () => {
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZxkAAAAASUVORK5CYII=';
  const bytes = Buffer.from(data, 'base64');
  const faux = createFauxCore({});
  let seen = false;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read_artifact', { artifactVersionId: 'artv_image' })], {
      stopReason: 'toolUse',
    }),
    (context) => {
      seen = context.messages.some(
        (message) =>
          message.role === 'toolResult' &&
          message.content.some((part) => part.type === 'image' && part.data === data),
      );
      return fauxAssistantMessage('Image observed.');
    },
  ]);
  const adapter = new PiAgentAdapter({
    spawn: () => {
      const pair = memoryChannelPair();
      runWorker(pair.worker, { streamFn: faux.streamSimple, resolveModel: () => faux.getModel() });
      return pair.host;
    },
    credentials: async () => ACCESS_TOKEN,
  });
  const { host } = recordingHost({
    executeTool: async (toolCallId) => ({
      ok: true,
      toolCallId,
      result: {
        artifactVersionId: 'artv_image',
        images: [
          {
            kind: 'image_attachment',
            imageId: 'artv_image',
            name: 'image.png',
            mime: 'image/png',
            bytes: bytes.length,
            width: 1,
            height: 1,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            data,
          },
        ],
      },
    }),
  });
  const role = linearCorral(['writer']).roles[0];
  if (!role) throw new Error('missing role');
  const handle = await adapter.start(
    {
      runId: 'run_1',
      executionId: 'exec_1',
      taskId: 'task_1',
      nodeId: 'writer',
      attemptNo: 1,
      role: { ...role, allowedCollaborationTools: ['read_artifact'] },
      modelProfile: 'model-a',
      mode: 'live',
      model: {
        profile: 'model-a',
        provider: 'openai',
        modelId: 'faux-1',
        auth: 'api_key',
        imageInput: true,
      },
      depth: 0,
      round: null,
      criteriaVersionId: 'crit_1',
      assignment: { kind: 'scheduled' },
      capabilities: { delegateTo: [], askTo: [] },
      inputs: [
        { name: 'brief', kind: 'run_input', artifactVersionId: null, text: 'Read the image.' },
      ],
    },
    host,
  );
  await handle.waitForSettlement();
  expect(seen).toBe(true);
});
