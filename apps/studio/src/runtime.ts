import type {
  CorralRepository,
  RunArchive,
  RuntimeTransport,
  TransportHandlers,
} from '@corral/core';
import type {
  DemoMessage,
  DemoMethod,
  DemoResponse,
  DemoTeamRevision,
  DemoWorkspaceMethod,
} from './demo-protocol.ts';

export type DemoWorkspaceCall = (
  method: DemoWorkspaceMethod,
  ...args: unknown[]
) => Promise<unknown>;

/** the same Coordinator and transport run in a worker, without a server or keys. */
export function createDemoTransport(): RuntimeTransport {
  return createDemoRuntime().transport;
}

/** The demo worker's transport and its work folder. */
export function createDemoRuntime(repository?: Pick<CorralRepository, 'getRevision'>): {
  transport: RuntimeTransport;
  workspace: DemoWorkspaceCall;
  readHistory: (runId: string) => Promise<RunArchive>;
} {
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
    args: Parameters<NonNullable<RuntimeTransport[M]>>,
    revisions?: DemoTeamRevision[],
  ): ReturnType<NonNullable<RuntimeTransport[M]>> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'request', id, method, args, revisions });
    }) as ReturnType<NonNullable<RuntimeTransport[M]>>;
  };
  const workspace: DemoWorkspaceCall = (method, ...args) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'workspace', id, method, args } satisfies DemoMessage);
    });
  };
  const transport: RuntimeTransport = {
    async startRun(input) {
      const revisions: DemoTeamRevision[] = [];
      if (repository && 'definition' in input) {
        // The worker has no localStorage. Give its Coordinator the original pinned definitions
        // so reference expansion and Loop policy are identical to a saved-revision server run.
        const seen = new Set<string>();
        const queue = [input.definition];
        for (const team of queue) {
          for (const node of team.nodes) {
            if (node.type !== 'team' || node.source.kind !== 'reference') continue;
            const { corralId, definitionRevision: revision } = node.source;
            const key = JSON.stringify([corralId, revision]);
            if (seen.has(key)) continue;
            seen.add(key);
            const definition = await repository.getRevision(corralId, revision);
            if (definition) {
              revisions.push({ corralId, revision, definition });
              queue.push(definition);
            }
          }
        }
      }
      return request('startRun', [input], revisions);
    },
    sendCommand: (...args) => request('sendCommand', args),
    getReceipt: (...args) => request('getReceipt', args),
    getSnapshot: (...args) => request('getSnapshot', args),
    getArtifactText: (...args) => request('getArtifactText', args),
    getConversationTurn: (...args) => request('getConversationTurn', args),
    getMeetingAnswer: (...args) => request('getMeetingAnswer', args),
    listRuns: () => request('listRuns', []),
    getRunDefinition: (...args) => request('getRunDefinition', args),
    getRunSource: (...args) => request('getRunSource', args),
    getRunStats: (...args) => request('getRunStats', args),
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
  const readHistory = (runId: string) =>
    new Promise<RunArchive>((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++nextId;
      pending.set(id, { resolve: (value) => resolve(value as RunArchive), reject });
      worker.postMessage({ type: 'history', id, runId } satisfies DemoMessage);
    });
  return { transport, workspace, readHistory };
}
