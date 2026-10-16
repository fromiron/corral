import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { endpointProvider } from './endpoint.ts';
import { requestCredentials } from './request-credentials.ts';
import { runWorker } from './worker.ts';
import { processPort } from './worker-process.ts';

// Entry of a live model worker (child process). It has no credential store: the access token
// for each request arrives with that request's permit from the host (ADR-019, C-052 rule 4).
// OAuth-only providers read that token from an in-memory store of this request's token only.
const credentials = requestCredentials();
const models = builtinModels({ credentials: credentials.store });
runWorker(processPort(), {
  streamFn: (model, context, options) => {
    if (options?.apiKey) credentials.use(model.provider, options.apiKey);
    return models.streamSimple(model, context, options);
  },
  resolveModel: (provider, modelId, endpoint) => {
    if (endpoint) {
      // An endpoint never stands in for one of pi-ai's own providers.
      if (models.getProvider(provider)) return undefined;
      models.setProvider(endpointProvider(provider, endpoint));
    }
    return models.getModel(provider, modelId);
  },
});
