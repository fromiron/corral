import { fileURLToPath } from 'node:url';

export { type PiAdapterOptions, PiAgentAdapter } from './adapter.ts';
export { type Channel, memoryChannelPair, processChannel } from './channel.ts';
export {
  ENDPOINT_DEFAULTS,
  EndpointSpec,
  endpointProvider,
  KEYLESS_PLACEHOLDER,
  requestKeyAuth,
} from './endpoint.ts';
export { HostFrame, PROTOCOL_VERSION, WorkerFrame } from './protocol.ts';
export { normalizeUsage, type UsageObservation } from './usage.ts';
export { runWorker, type WorkerDeps } from './worker.ts';

/** The live worker's entry file, for `processChannel` (one child process per execution). */
export const WORKER_ENTRY = fileURLToPath(new URL('./worker-main.ts', import.meta.url));
