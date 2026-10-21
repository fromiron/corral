import { fileURLToPath } from 'node:url';

export { type PiAdapterOptions, PiAgentAdapter } from './adapter.ts';
export { type Channel, memoryChannelPair, processChannel, sdkProcessChannel } from './channel.ts';
export { editText, PiEditError } from './edit.ts';
export {
  ENDPOINT_DEFAULTS,
  EndpointSpec,
  endpointModelDefaults,
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

export type { PreviewBrowserTarget } from './browser-policy.ts';
export { assertBrowserCall, BROWSER_TOOLS } from './browser-policy.ts';
export { type McpProbeTool, probeMcp } from './mcp-probe.ts';
export { createPreviewBrowserTransport, type PreviewBrowserOptions } from './mcp-transport.ts';
export { type ModelBroker, modelBridgeChannel } from './model-bridge.ts';
export { modelReasoningCapabilities, reasoningRequest } from './reasoning.ts';

export { linuxSystemMounts, sandboxChannel } from './sandbox-channel.ts';
export { staticToolDescriptors } from './static-tools.ts';
