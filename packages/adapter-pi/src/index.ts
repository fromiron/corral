import { fileURLToPath } from 'node:url';

export { type PiAdapterOptions, PiAgentAdapter } from './adapter.ts';
export { type Channel, memoryChannelPair, processChannel, sdkProcessChannel } from './channel.ts';
export { editText, PiEditError } from './edit.ts';
export {
  ENDPOINT_DEFAULTS,
  EndpointSpec,
  endpointProvider,
  KEYLESS_PLACEHOLDER,
  requestKeyAuth,
} from './endpoint.ts';
export { downloadPiPackage, inspectPiPackage } from './packages.ts';
export {
  HostFrame,
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SdkHostFrame,
  type SdkResources,
  SdkWorkerFrame,
  WorkerFrame,
} from './protocol.ts';
export { normalizeUsage, type UsageObservation } from './usage.ts';
export { runWorker, type WorkerDeps } from './worker.ts';
export { recoverSdkWorkers } from './worker-leases.ts';

/** The live worker's entry file, for `processChannel` (one child process per execution). */
export const WORKER_ENTRY = fileURLToPath(new URL('./worker-main.ts', import.meta.url));
export const SDK_WORKER_ENTRY = fileURLToPath(new URL('./sdk-worker-main.ts', import.meta.url));
