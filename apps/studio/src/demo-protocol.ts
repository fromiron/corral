import type { RunEvent, StreamFrame } from '@corral/contracts';
import type { RuntimeTransport } from '@corral/core';

export type DemoMethod = Exclude<keyof RuntimeTransport, 'subscribe'>;
export type DemoRequest = {
  [M in DemoMethod]: {
    type: 'request';
    id: number;
    method: M;
    args: Parameters<RuntimeTransport[M]>;
  };
}[DemoMethod];
export type DemoMessage =
  | DemoRequest
  | { type: 'subscribe'; id: number; runId: string; afterSeq: number }
  | { type: 'unsubscribe'; id: number }
  | { type: 'configure'; delayMs: number };
export type DemoResponse =
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string }
  | { type: 'event'; id: number; event: RunEvent }
  | { type: 'frame'; id: number; frame: StreamFrame }
  | { type: 'subscription_error'; id: number; message: string };
