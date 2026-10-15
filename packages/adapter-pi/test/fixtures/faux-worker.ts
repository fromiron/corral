import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runWorker } from '../../src/worker.ts';
import { processPort } from '../../src/worker-process.ts';

// A worker process on pi-ai's faux model, for lifecycle tests. CORRAL_FIXTURE picks a script.
const faux = createFauxCore({});
const lastVersion = (context: { messages: unknown[] }) =>
  [...JSON.stringify(context.messages).matchAll(/artv_\d{4}/g)].at(-1)?.[0] ?? 'artv_missing';

if (process.env.CORRAL_FIXTURE === 'crash') {
  faux.setResponses([
    () => {
      process.exit(3);
    },
  ]);
} else {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('write_artifact', {
          text: `env-has-key=${Boolean(process.env.OPENAI_API_KEY)}`,
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    (context) =>
      fauxAssistantMessage(
        [fauxToolCall('submit_result', { artifactVersionIds: [lastVersion(context)] })],
        {
          stopReason: 'toolUse',
        },
      ),
    fauxAssistantMessage('Done.'),
  ]);
}

runWorker(processPort(), { streamFn: faux.streamSimple, resolveModel: () => faux.getModel() });
