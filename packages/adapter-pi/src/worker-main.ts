import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { runWorker } from './worker.ts';
import { processPort } from './worker-process.ts';

// Entry of a live model worker (child process). It has no credential store: the access token
// for each request arrives with that request's permit from the host (ADR-019, C-052 rule 4).
const models = builtinModels();
runWorker(processPort(), {
  streamFn: (model, context, options) => models.streamSimple(model, context, options),
  resolveModel: (provider, modelId) => models.getModel(provider, modelId),
});
