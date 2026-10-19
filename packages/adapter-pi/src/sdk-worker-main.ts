import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { endpointProvider } from './endpoint.ts';
import { workerModelBridge } from './model-bridge.ts';
import { requestCredentials } from './request-credentials.ts';
import { runSdkWorker } from './sdk-worker.ts';
import { processPort } from './worker-process.ts';

const directory = process.env.CORRAL_WORKER_DIR;
if (!directory || process.env.HOME !== directory)
  throw new Error('SDK worker requires an isolated home');
const port = processPort();
const bridge = process.env.CORRAL_MODEL_BRIDGE === '1' ? workerModelBridge(port) : null;
const credentials = requestCredentials();
const models = builtinModels({ credentials: credentials.store });
runSdkWorker(bridge?.port ?? port, {
  directory,
  workerLeaseDirectory: process.env.CORRAL_WORKER_LEASE_DIR,
  now: () => Date.now(),
  streamFn:
    bridge?.streamFn ??
    ((model, context, options) => {
      if (options?.apiKey) credentials.use(model.provider, options.apiKey);
      return models.streamSimple(model, context, options);
    }),
  resolveModel: (provider, modelId, endpoint) => {
    if (endpoint) {
      if (models.getProvider(provider)) return undefined;
      models.setProvider(endpointProvider(provider, endpoint));
    }
    return models.getModel(provider, modelId);
  },
});
