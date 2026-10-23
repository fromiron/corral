import { ApiError, type WorkspacesApi } from '@corral/client';
import {
  canonicalJson,
  type DebugBreakpoints,
  type DebugCommand,
  type DebugCommandResult,
  DebugInspect,
  type DebugInspection,
  type DebugQuery,
  type DebugQueryResult,
  type DebugStart,
  type DebugState,
  ResourcePath,
  type TextRange,
  type WorkspaceTarget,
} from '@corral/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { type DocumentBuffer, type DocumentStore, documentKey } from '../documents/store.ts';

export type DebugClient = Pick<
  WorkspacesApi,
  | 'debugState'
  | 'inspectDebug'
  | 'startDebug'
  | 'setDebugBreakpoints'
  | 'queryDebug'
  | 'commandDebug'
  | 'debugCommand'
  | 'readDocument'
>;
export type DebugPauseScope = Pick<DebugQueryResult, 'generation' | 'pauseId' | 'revision'>;
export type DebugFrame = NonNullable<DebugQueryResult['frames']>[number];
export interface DebugCopy {
  state: DebugState | null;
  inspection: DebugInspection | null;
  inspectionInput: DebugInspect | null;
  error: string | null;
  busy: boolean;
  pendingCommandId: string | null;
  interruptedCommandId: string | null;
  commandResult: DebugCommandResult | null;
  frame: (DebugFrame & DebugPauseScope) | null;
}
export interface DebugStore extends StoreApi<{ copies: Record<string, DebugCopy> }> {
  readonly clientId: string;
  retain(target: WorkspaceTarget): () => void;
  refresh(target: WorkspaceTarget): Promise<void>;
  inspect(
    target: WorkspaceTarget,
    configId: string,
    options?: Pick<DebugInspect, 'attach' | 'preview'>,
  ): Promise<void>;
  start(target: WorkspaceTarget, trust: boolean): Promise<void>;
  command(
    target: WorkspaceTarget,
    input: Omit<DebugCommand, 'target' | 'commandId'>,
  ): Promise<DebugCommandResult | null>;
  checkCommand(target: WorkspaceTarget): Promise<DebugCommandResult | null>;
  query(
    target: WorkspaceTarget,
    input: Omit<DebugQuery, 'target'>,
  ): Promise<DebugQueryResult | null>;
  setBreakpoints(
    target: WorkspaceTarget,
    input: Omit<DebugBreakpoints, 'target' | 'commandId'>,
  ): Promise<DebugCommandResult | null>;
  toggleBreakpoint(
    key: string,
    line: number,
    generation: string,
  ): Promise<DebugCommandResult | null>;
  openFrame(
    target: WorkspaceTarget,
    frame: DebugFrame,
    scope: DebugPauseScope,
    open: (target: WorkspaceTarget, path: string, range: TextRange) => boolean,
  ): Promise<boolean>;
  dispose(): void;
}
export const debugCopyKey = (target: WorkspaceTarget) => documentKey(target, '');
const stores = new WeakMap<DebugClient, DebugStore>();
const unsafe = (entry: DocumentBuffer | undefined) =>
  Boolean(entry && (entry.dirty || entry.saving || entry.pendingSave || entry.conflict));
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Views retain polling only; the explicit server-owned debugger outlives them. */
export function debugStore(
  client: DebugClient,
  documents: DocumentStore,
  options: { clientId?: string; newId?: () => string } = {},
): DebugStore {
  const previous = stores.get(client);
  if (previous) return previous;
  const state = createStore<{ copies: Record<string, DebugCopy> }>(() => ({ copies: {} }));
  const clientId = options.clientId ?? `debug_client_${crypto.randomUUID().replaceAll('-', '')}`;
  const newId = options.newId ?? (() => `debug_${crypto.randomUUID().replaceAll('-', '')}`);
  type Runtime = {
    target: WorkspaceTarget;
    refs: number;
    epoch: number;
    query: number;
    timer?: ReturnType<typeof setInterval>;
    read?: { epoch: number; promise: Promise<void> };
    start?: DebugStart;
    pending?: { id: string; generation: string };
    cleaning?: boolean;
  };
  const runtimes = new Map<string, Runtime>();
  let disposed = false;
  const get = (target: WorkspaceTarget) => state.getState().copies[debugCopyKey(target)];
  const patch = (target: WorkspaceTarget, update: Partial<DebugCopy>) => {
    if (!disposed)
      state.setState({
        copies: {
          ...state.getState().copies,
          [debugCopyKey(target)]: {
            state: null,
            inspection: null,
            inspectionInput: null,
            error: null,
            busy: false,
            pendingCommandId: null,
            interruptedCommandId: null,
            commandResult: null,
            frame: null,
            ...get(target),
            ...update,
          },
        },
      });
  };
  const runtime = (target: WorkspaceTarget) => {
    const key = debugCopyKey(target);
    let copy = runtimes.get(key);
    if (!copy) {
      copy = { target, refs: 0, epoch: 0, query: 0 };
      runtimes.set(key, copy);
      patch(target, {});
    }
    return copy;
  };
  const matches = (
    target: WorkspaceTarget,
    scope: { generation: string; pauseId?: number; revision?: number },
  ) => {
    const copy = get(target)?.state,
      session = copy?.session;
    return Boolean(
      !disposed &&
        copy &&
        same(copy.target, target) &&
        session?.generation === scope.generation &&
        (scope.pauseId === undefined || session.pauseId === scope.pauseId) &&
        (scope.revision === undefined || session.revision === scope.revision),
    );
  };
  const publish = (target: WorkspaceTarget, value: DebugState) => {
    if (!same(value.target, target))
      throw new Error('The debugger belongs to another working copy.');
    const old = get(target),
      before = old?.state?.session,
      after = value.session;
    if (before && after?.generation === before.generation && after.revision < before.revision)
      return;
    const frame = old?.frame;
    patch(target, {
      state: value,
      frame:
        frame &&
        after?.state === 'paused' &&
        after.generation === frame.generation &&
        after.pauseId === frame.pauseId &&
        after.revision === frame.revision
          ? frame
          : null,
    });
  };
  const refresh = (target: WorkspaceTarget): Promise<void> => {
    if (disposed) return Promise.resolve();
    const copy = runtime(target),
      epoch = copy.epoch;
    if (copy.read?.epoch === epoch) return copy.read.promise;
    const promise = (async () => {
      try {
        const value = await client.debugState(target.sessionId);
        if (!disposed && copy.epoch === epoch) publish(target, value);
      } catch (error) {
        if (!disposed && copy.epoch === epoch) patch(target, { error: message(error) });
      }
    })();
    copy.read = { epoch, promise };
    void promise.finally(() => {
      if (copy.read?.promise === promise) copy.read = undefined;
    });
    return promise;
  };
  const perform = async <T>(
    target: WorkspaceTarget,
    action: (copy: Runtime) => Promise<T>,
    mode: 'normal' | 'check' | 'cleanup' = 'normal',
  ): Promise<T | null> => {
    if (disposed) return null;
    const copy = runtime(target);
    if (copy.cleaning || (get(target)?.busy && mode !== 'cleanup')) return null;
    if (copy.pending && mode === 'normal') {
      patch(target, { error: 'Check the previous debugger command before sending another.' });
      return null;
    }
    const epoch = ++copy.epoch;
    if (mode === 'cleanup') {
      copy.cleaning = true;
      if (copy.pending) patch(target, { interruptedCommandId: copy.pending.id });
    }
    patch(target, { busy: true, error: null });
    try {
      return await action(copy);
    } catch (error) {
      if (!disposed && copy.epoch === epoch) patch(target, { error: message(error) });
      return null;
    } finally {
      if (!disposed && copy.epoch === epoch) {
        copy.cleaning = false;
        patch(target, { busy: false });
      }
    }
  };
  const consume = (
    target: WorkspaceTarget,
    pending: { id: string; generation: string },
    result: DebugCommandResult,
    epoch: number,
  ) => {
    const copy = runtime(target);
    if (disposed || copy.epoch !== epoch || copy.pending?.id !== pending.id) return null;
    if (result.commandId !== pending.id || result.session.generation !== pending.generation)
      throw new Error('The debugger command result belongs to another session.');
    const current = get(target)?.state;
    if (current?.session?.generation === pending.generation)
      publish(target, { ...current, session: result.session });
    const unfinished = result.state === 'running' || result.state === 'uncertain';
    if (!unfinished) copy.pending = undefined;
    patch(target, {
      pendingCommandId: unfinished ? pending.id : null,
      commandResult: result,
      error: result.error ?? null,
    });
    return result;
  };
  const send = async (
    target: WorkspaceTarget,
    copy: Runtime,
    generation: string,
    action: (id: string) => Promise<DebugCommandResult>,
  ) => {
    const epoch = copy.epoch;
    const pending = { id: newId(), generation };
    copy.pending = pending;
    patch(target, { pendingCommandId: pending.id, commandResult: null });
    try {
      return consume(target, pending, await action(pending.id), epoch);
    } catch (error) {
      if (
        copy.epoch === epoch &&
        copy.pending?.id === pending.id &&
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        copy.pending = undefined;
        patch(target, { pendingCommandId: null });
      }
      throw error;
    }
  };
  const sourceFile = async (target: WorkspaceTarget, path: string, sha256: string) => {
    if (!ResourcePath.safeParse(path).success)
      throw new Error('The debugger source is not a working-copy file.');
    const key = documentKey(target, path);
    if (unsafe(documents.getState().documents[key]))
      throw new Error('Save or discard this draft before using its debugger source.');
    const file = await client.readDocument(target.sessionId, path);
    const entry = documents.getState().documents[key];
    if (
      !same(file.target, target) ||
      file.path !== path ||
      file.content.kind !== 'text' ||
      file.version?.sha256 !== sha256 ||
      unsafe(entry) ||
      (entry && entry.baseHash !== sha256)
    )
      throw new Error('The debugger source has changed.');
    return { key, file };
  };
  const owner: DebugStore = Object.assign(state, {
    clientId,
    retain(target: WorkspaceTarget) {
      const copy = runtime(target);
      if (++copy.refs === 1) {
        void refresh(target);
        copy.timer = setInterval(() => void refresh(target), 3000);
      }
      let retained = true;
      return () => {
        if (!retained) return;
        retained = false;
        if (--copy.refs === 0 && copy.timer) {
          clearInterval(copy.timer);
          copy.timer = undefined;
        }
      };
    },
    refresh,
    async inspect(
      target: WorkspaceTarget,
      configId: string,
      options?: Pick<DebugInspect, 'attach' | 'preview'>,
    ) {
      await perform(target, async (copy) => {
        const epoch = copy.epoch;
        const input = DebugInspect.parse({ ...options, target, configId });
        copy.start = undefined;
        patch(target, { inspection: null, inspectionInput: null });
        const value = await client.inspectDebug(target.sessionId, input);
        if (copy.epoch !== epoch) return;
        if (!same(value.target, target) || value.configuration.id !== input.configId)
          throw new Error('The inspected debugger configuration changed.');
        patch(target, { inspection: value, inspectionInput: input });
      });
    },
    async start(target: WorkspaceTarget, trust: boolean) {
      await perform(target, async (copy) => {
        const epoch = copy.epoch;
        const value = get(target),
          inspection = value?.inspection,
          inspected = value?.inspectionInput;
        if (
          !inspection ||
          !inspected ||
          !same(inspection.target, target) ||
          !value.state?.available
        )
          throw new Error('Review this debugger configuration before starting it.');
        if (value.state.session && !['stopped', 'failed'].includes(value.state.session.state))
          throw new Error('Stop the current debugger before starting another.');
        const input = {
          ...inspected,
          clientId,
          configRevision: inspection.configRevision,
          fingerprint: inspection.fingerprint,
          trust,
        };
        const { requestId: _id, ...previous } = copy.start ?? {};
        if (!copy.start || !same(input, previous)) copy.start = { ...input, requestId: newId() };
        const session = await client.startDebug(target.sessionId, copy.start);
        if (copy.epoch !== epoch) return;
        if (
          session.clientId !== clientId ||
          session.configId !== input.configId ||
          session.configRevision !== input.configRevision ||
          session.fingerprint !== input.fingerprint
        )
          throw new Error('The started debugger does not match the reviewed configuration.');
        copy.start = undefined;
        publish(target, { ...value.state, session });
        await refresh(target);
      });
    },
    command(target: WorkspaceTarget, input: Omit<DebugCommand, 'target' | 'commandId'>) {
      const cleanup = input.kind === 'stop' || input.kind === 'disconnect';
      if (cleanup && !matches(target, input)) return Promise.resolve(null);
      return perform(
        target,
        async (copy) => {
          if (!matches(target, input))
            throw new Error('The debugger state changed. Review it before sending this command.');
          return send(target, copy, input.generation, (commandId) =>
            client.commandDebug(target.sessionId, { ...input, target, commandId }),
          );
        },
        cleanup ? 'cleanup' : 'normal',
      );
    },
    checkCommand(target: WorkspaceTarget) {
      return perform(
        target,
        async (copy) => {
          const pending = copy.pending;
          const epoch = copy.epoch;
          if (!pending) return null;
          return consume(
            target,
            pending,
            await client.debugCommand(target.sessionId, pending.generation, pending.id),
            epoch,
          );
        },
        'check',
      );
    },
    async query(target: WorkspaceTarget, input: Omit<DebugQuery, 'target'>) {
      const copy = runtime(target),
        epoch = copy.epoch,
        query = ++copy.query;
      const session = get(target)?.state?.session;
      if (
        !session ||
        !matches(target, input) ||
        (input.kind !== 'threads' && session.state !== 'paused')
      )
        return null;
      const scope = {
        generation: session.generation,
        pauseId: session.pauseId,
        revision: session.revision,
      };
      try {
        const result = await client.queryDebug(target.sessionId, { ...input, target });
        if (
          disposed ||
          copy.epoch !== epoch ||
          copy.query !== query ||
          !matches(target, scope) ||
          result.generation !== scope.generation ||
          result.pauseId !== scope.pauseId ||
          result.revision !== scope.revision
        )
          return null;
        return result;
      } catch (error) {
        if (!disposed && copy.epoch === epoch && copy.query === query)
          patch(target, { error: message(error) });
        return null;
      }
    },
    setBreakpoints(target: WorkspaceTarget, input: Omit<DebugBreakpoints, 'target' | 'commandId'>) {
      return perform(target, async (copy) => {
        const epoch = copy.epoch;
        if (!matches(target, input)) throw new Error('The debugger session changed.');
        await sourceFile(target, input.path, input.sha256);
        if (copy.epoch !== epoch) return null;
        if (!matches(target, input)) throw new Error('The debugger session changed.');
        return send(target, copy, input.generation, (commandId) =>
          client.setDebugBreakpoints(target.sessionId, { ...input, target, commandId }),
        );
      });
    },
    async toggleBreakpoint(key: string, line: number, generation: string) {
      const entry = documents.getState().documents[key];
      if (!entry) return null;
      const session = get(entry.target)?.state?.session;
      if (
        !entry.baseHash ||
        unsafe(entry) ||
        !matches(entry.target, { generation }) ||
        !session ||
        !['running', 'paused'].includes(session.state)
      ) {
        patch(entry.target, {
          error:
            'Save or discard this draft and check the debugger session before setting a breakpoint.',
        });
        return null;
      }
      if (!Number.isInteger(line) || line < 1 || line > entry.text.split(/\r\n|\r|\n/).length)
        return null;
      const current = session.breakpoints
        .filter((point) => point.path === entry.path && point.sha256 === entry.baseHash)
        .map((point) => point.requestedLine);
      const lines = current.includes(line)
        ? current.filter((value) => value !== line)
        : [...current, line].sort((left, right) => left - right);
      return owner.setBreakpoints(entry.target, {
        generation,
        path: entry.path,
        sha256: entry.baseHash,
        lines,
      });
    },
    async openFrame(
      target: WorkspaceTarget,
      frame: DebugFrame,
      scope: DebugPauseScope,
      open: (target: WorkspaceTarget, path: string, range: TextRange) => boolean,
    ) {
      const source = frame.source;
      if (
        !source.mapped ||
        source.reason !== null ||
        !source.path ||
        !source.sha256 ||
        !matches(target, scope) ||
        get(target)?.state?.session?.state !== 'paused'
      )
        return false;
      try {
        const { key } = await sourceFile(target, source.path, source.sha256);
        if (!matches(target, scope)) return false;
        if (
          !documents.getState().documents[key] &&
          (await documents.open(target.sessionId, source.path)) !== key
        )
          return false;
        const entry = documents.getState().documents[key];
        const line = entry?.text.split(/\r\n|\r|\n/)[source.line - 1];
        if (
          !entry ||
          unsafe(entry) ||
          entry.baseHash !== source.sha256 ||
          !matches(target, scope) ||
          !Number.isInteger(source.line) ||
          !Number.isInteger(source.column) ||
          source.column < 1 ||
          line === undefined ||
          source.column > line.length + 1
        )
          return false;
        const opened = open(target, source.path, {
          startLine: source.line,
          startColumn: source.column,
          endLine: source.line,
          endColumn: source.column,
        });
        if (opened) patch(target, { frame: { ...frame, ...scope } });
        return opened;
      } catch (error) {
        if (matches(target, scope)) patch(target, { error: message(error) });
        return false;
      }
    },
    dispose() {
      disposed = true;
      for (const copy of runtimes.values()) {
        ++copy.epoch;
        if (copy.timer) clearInterval(copy.timer);
      }
      stores.delete(client);
    },
  });
  stores.set(client, owner);
  return owner;
}
