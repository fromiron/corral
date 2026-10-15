import type { RuntimeTransport, TransportHandlers } from '@corral/core';
import type { DemoMessage, DemoMethod, DemoResponse } from './demo-protocol.ts';

/** ADR-016: the same Coordinator and transport run in a worker, without a server or keys. */
export function createDemoTransport(): RuntimeTransport {
  const worker = new Worker(new URL('./demo.worker.ts', import.meta.url), { type: 'module' });
  const raw = new URLSearchParams(window.location.search).get('delay');
  const delayMs = raw === null ? 1500 : Number(raw);
  worker.postMessage({ type: 'configure', delayMs } satisfies DemoMessage);
  let nextId = 0;
  let failure: Error | null = null;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const subscriptions = new Map<number, TransportHandlers>();
  worker.addEventListener('message', (event: MessageEvent<DemoResponse>) => {
    const message = event.data;
    if (message.type === 'result' || message.type === 'error') {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.type === 'result') call?.resolve(message.value);
      else call?.reject(new Error(message.message));
    } else {
      const handlers = subscriptions.get(message.id);
      try {
        if (message.type === 'event') handlers?.onEvent(message.event);
        else if (message.type === 'frame') handlers?.onFrame?.(message.frame);
        else handlers?.onError?.(new Error(message.message));
      } catch (error) {
        subscriptions.delete(message.id);
        worker.postMessage({ type: 'unsubscribe', id: message.id } satisfies DemoMessage);
        handlers?.onError?.(error);
      }
    }
  });
  const fail = () => {
    failure = new Error('The simulated runtime stopped. Reload the demo to start again.');
    for (const call of pending.values()) call.reject(failure);
    pending.clear();
    for (const handlers of subscriptions.values()) handlers.onError?.(failure);
    subscriptions.clear();
    worker.terminate();
  };
  worker.addEventListener('error', fail);
  worker.addEventListener('messageerror', fail);
  const request = <M extends DemoMethod>(
    method: M,
    ...args: Parameters<RuntimeTransport[M]>
  ): ReturnType<RuntimeTransport[M]> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'request', id, method, args });
    }) as ReturnType<RuntimeTransport[M]>;
  };
  return {
    startRun: (...args) => request('startRun', ...args),
    sendCommand: (...args) => request('sendCommand', ...args),
    getReceipt: (...args) => request('getReceipt', ...args),
    getSnapshot: (...args) => request('getSnapshot', ...args),
    getArtifactText: (...args) => request('getArtifactText', ...args),
    listRuns: () => request('listRuns'),
    getRunDefinition: (...args) => request('getRunDefinition', ...args),
    subscribe(runId, afterSeq, handlers) {
      const id = ++nextId;
      if (failure) {
        queueMicrotask(() => handlers.onError?.(failure));
        return () => {};
      }
      subscriptions.set(id, handlers);
      worker.postMessage({ type: 'subscribe', id, runId, afterSeq } satisfies DemoMessage);
      return () => {
        subscriptions.delete(id);
        worker.postMessage({ type: 'unsubscribe', id } satisfies DemoMessage);
      };
    },
  };
}
