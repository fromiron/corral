import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { processPort } from '../../src/worker-process.ts';

const faux = createFauxCore({});
faux.setResponses([
  (context) =>
    fauxAssistantMessage(
      [
        fauxToolCall('write_artifact', {
          text: JSON.stringify({
            hasPonytail: JSON.stringify(
              context.messages.filter((message) => message.role === 'system'),
            )
              .toLowerCase()
              .includes('ponytail'),
          }),
        }),
      ],
      { stopReason: 'toolUse' },
    ),
  (context) =>
    fauxAssistantMessage(
      [
        fauxToolCall('submit_result', {
          artifactVersionIds: [
            [...JSON.stringify(context.messages).matchAll(/artv_[A-Za-z0-9_-]+/g)].at(-1)?.[0] ??
              'artv_missing',
          ],
        }),
      ],
      { stopReason: 'toolUse' },
    ),
  fauxAssistantMessage('Done.'),
]);
const directory = process.env.CORRAL_WORKER_DIR;
if (directory) {
  const { runSdkWorker } = await import('../../src/sdk-worker.ts');
  runSdkWorker(processPort(), {
    directory,
    now: () => Date.now(),
    streamFn: faux.streamSimple,
    resolveModel: () => faux.getModel(),
  });
} else {
  const { runWorker } = await import('../../src/worker.ts');
  runWorker(processPort(), { streamFn: faux.streamSimple, resolveModel: () => faux.getModel() });
}
