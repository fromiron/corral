import { ApiError, type WorkspacesApi } from '@corral/client';
import type { DocumentOperation, FileDocument, WorkspaceTarget } from '@corral/contracts';
import type { editor } from 'monaco-editor';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { WORKSPACE_CHANGED } from '../workspaceEvents.ts';
import { loadMonaco } from './monaco.ts';
import {
  indexedDbRecovery,
  type RecoveryDraft,
  type RecoveryScope,
  type RecoveryStorage,
  type SaveCommand,
} from './recovery.ts';

export type DocumentClient = Pick<
  WorkspacesApi,
  'readDocument' | 'changeDocument' | 'documentOperation'
>;
export interface DocumentBuffer {
  key: string;
  target: WorkspaceTarget;
  path: string;
  file: FileDocument;
  model: editor.ITextModel | null;
  text: string;
  baseText: string;
  baseHash: string | null;
  editVersion: number;
  dirty: boolean;
  saving: boolean;
  pendingSave: SaveCommand | null;
  canRetrySave: boolean;
  conflict: FileDocument | null;
  formatBlocked: boolean;
  recoveries: RecoveryDraft[];
  otherRecoveries: RecoveryDraft[];
  recoverySavedVersion: number | null;
  recoveryError: string | null;
  modelError: string | null;
  error: string | null;
  /** The last save was refused because a task, terminal or Run holds the copy's writer (P15). */
  writerBusy?: boolean;
}

export type CloseChoice = 'save' | 'discard' | 'cancel';
export type CloseResult = 'closed' | 'confirm' | 'cancelled' | 'failed';
export interface DocumentStore extends StoreApi<{ documents: Record<string, DocumentBuffer> }> {
  open(sessionId: string, path: string): Promise<string>;
  retainView(key: string, viewId: string): () => void;
  closeView(key: string, viewId: string, choice?: CloseChoice): Promise<CloseResult>;
  save(key: string): Promise<boolean>;
  checkSave(key: string): Promise<boolean>;
  refresh(key: string): Promise<void>;
  resolveConflict(key: string, choice: 'ours' | 'theirs'): boolean;
  restoreRecovery(key: string, recoveryId: string): Promise<void>;
  discardRecovery(key: string, recoveryId: string): Promise<void>;
  sessionRecoveries(scope: RecoveryScope): Promise<RecoveryDraft[]>;
  discardRecoveryCandidate(draft: RecoveryDraft): Promise<void>;
  convertEol(key: string, eol: 'lf' | 'crlf'): void;
  hasUnsaved(): boolean;
  dispose(): void;
}

export interface DocumentStoreOptions {
  loadMonaco?: () => Promise<typeof import('monaco-editor/editor')>;
  recovery?: RecoveryStorage;
  clientId?: string;
  newOperationId?: () => string;
  now?: () => number;
  notifySaved?: () => void;
}

const stores = new WeakMap<DocumentClient, DocumentStore>();
export const documentKey = (target: WorkspaceTarget, path: string) =>
  JSON.stringify([
    target.hostId,
    target.projectId,
    target.bindingId,
    target.sessionId,
    target.copyGeneration,
    path,
  ]);
const textOf = (file: FileDocument) => (file.content.kind === 'text' ? file.content.text : '');
const editable = (file: FileDocument) =>
  file.content.kind === 'text' || file.content.kind === 'absent';
const eolOf = (text: string) => {
  const endings = new Set(text.match(/\r\n|\r|\n/g) ?? []);
  return endings.size > 1
    ? 'mixed'
    : text.includes('\r\n')
      ? 'crlf'
      : text.includes('\r')
        ? 'cr'
        : text.includes('\n')
          ? 'lf'
          : 'none';
};
const blockedFormat = (file: FileDocument) =>
  file.version?.eol === 'mixed' || file.version?.eol === 'cr';
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Document operation failed';

export function documentStore(
  client: DocumentClient,
  options: DocumentStoreOptions = {},
): DocumentStore {
  const previous = stores.get(client);
  if (previous) return previous;
  const state = createStore<{ documents: Record<string, DocumentBuffer> }>(() => ({
    documents: {},
  }));
  const recovery = options.recovery ?? indexedDbRecovery();
  const clientId = options.clientId ?? crypto.randomUUID();
  const newOperationId = options.newOperationId ?? (() => `save_${crypto.randomUUID()}`);
  const now = options.now ?? Date.now;
  const engine = options.loadMonaco ?? loadMonaco;
  const notifySaved =
    options.notifySaved ??
    (() => {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(WORKSPACE_CHANGED));
    });
  const views = new Map<string, Set<string>>();
  const listeners = new Map<string, { dispose(): void }>();
  const models = new Map<string, Promise<void>>();
  const saves = new Map<string, Promise<boolean>>();
  const refreshes = new Map<string, number>();
  const applying = new Set<string>();
  let disposed = false;
  type Persistence = {
    running: boolean;
    serial: number;
    latest?: { serial: number; draft: RecoveryDraft | null };
    written?: RecoveryDraft;
    waiters: { serial: number; resolve(): void }[];
  };
  const persistence = new Map<string, Persistence>();
  const get = (key: string) => state.getState().documents[key];
  const patch = (key: string, change: Partial<DocumentBuffer>) => {
    const entry = get(key);
    if (!entry) return;
    const next = { ...entry, ...change };
    state.setState({ documents: { ...state.getState().documents, [key]: next } });
    return next;
  };
  const persist = (key: string): Promise<void> => {
    const entry = get(key);
    const queue = persistence.get(key) ?? { running: false, serial: 0, waiters: [] };
    persistence.set(key, queue);
    const serial = ++queue.serial;
    queue.latest = {
      serial,
      draft:
        entry && (entry.dirty || entry.pendingSave)
          ? {
              version: 1,
              id: JSON.stringify([clientId, key]),
              clientId,
              documentKey: key,
              target: entry.target,
              path: entry.path,
              text: entry.text,
              baseText: entry.baseText,
              baseHash: entry.baseHash,
              editVersion: entry.editVersion,
              pendingSave: entry.pendingSave,
              formatBlocked: entry.formatBlocked,
              updatedAt: now(),
            }
          : null,
    };
    const done = new Promise<void>((resolve) => queue.waiters.push({ serial, resolve }));
    if (!queue.running) {
      queue.running = true;
      void (async () => {
        while (queue.latest) {
          const next = queue.latest;
          queue.latest = undefined;
          try {
            if (next.draft) {
              await recovery.write(next.draft);
              queue.written = next.draft;
              patch(key, { recoverySavedVersion: next.draft.editVersion, recoveryError: null });
            } else if (queue.written) {
              await recovery.remove(queue.written);
              queue.written = undefined;
              patch(key, { recoverySavedVersion: null, recoveryError: null });
            }
          } catch (error) {
            patch(key, { recoveryError: message(error) });
          }
          for (const waiter of queue.waiters.filter((waiter) => waiter.serial <= next.serial))
            waiter.resolve();
          queue.waiters = queue.waiters.filter((waiter) => waiter.serial > next.serial);
        }
        queue.running = false;
      })();
    }
    return done;
  };
  const loadRecoveries = async (key: string) => {
    const entry = get(key);
    if (!entry) return;
    try {
      const candidates = await store.sessionRecoveries(entry.target);
      patch(key, {
        recoveries: candidates.filter((draft) => draft.documentKey === key),
        otherRecoveries: candidates.filter((draft) => draft.documentKey !== key),
      });
    } catch (error) {
      patch(key, { recoveryError: message(error) });
    }
  };
  const modelText = (key: string, text: string) => {
    const entry = get(key);
    if (!entry?.model) return;
    applying.add(key);
    try {
      entry.model.setValue(text);
    } finally {
      applying.delete(key);
    }
  };
  const ensureModel = (key: string): Promise<void> => {
    const pending = models.get(key);
    if (pending) return pending;
    const entry = get(key);
    if (!entry || entry.model || !editable(entry.file)) return Promise.resolve();
    const work = (async () => {
      try {
        const monaco = await engine();
        const current = get(key);
        if (!current || disposed) return;
        const uri = monaco.Uri.from({
          scheme: 'corral-document',
          authority: clientId,
          path: `/${current.path}`,
          query: key,
        });
        const model = monaco.editor.createModel(current.text, undefined, uri);
        listeners.set(
          key,
          model.onDidChangeContent(() => {
            const latest = get(key);
            if (!latest || latest.formatBlocked || applying.has(key)) return;
            const text = model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);
            patch(key, {
              text,
              editVersion: latest.editVersion + 1,
              dirty: text !== latest.baseText,
              error: null,
            });
            void persist(key);
          }),
        );
        patch(key, { model, modelError: null });
      } catch (error) {
        patch(key, { modelError: message(error) });
      }
    })();
    models.set(key, work);
    void work.finally(() => models.delete(key));
    return work;
  };
  const discard = async (key: string) => {
    listeners.get(key)?.dispose();
    listeners.delete(key);
    get(key)?.model?.dispose();
    const documents = { ...state.getState().documents };
    delete documents[key];
    state.setState({ documents });
    views.delete(key);
    await persist(key);
  };
  const applyFile = (key: string, file: FileDocument, start: DocumentBuffer) => {
    const entry = get(key);
    if (!entry || entry.baseHash !== start.baseHash) return;
    if (entry.writerBusy && file.writable) patch(key, { writerBusy: false, error: null });
    const changed =
      documentKey(file.target, file.path) !== key ||
      (file.version?.sha256 ?? null) !== entry.baseHash;
    if (
      changed &&
      (entry.dirty ||
        entry.pendingSave ||
        entry.editVersion !== start.editVersion ||
        documentKey(file.target, file.path) !== key)
    ) {
      patch(key, { conflict: file });
    } else if (changed) {
      const text = textOf(file);
      modelText(key, text);
      patch(key, {
        file,
        text,
        baseText: text,
        baseHash: file.version?.sha256 ?? null,
        formatBlocked: blockedFormat(file),
        conflict: null,
        dirty: false,
        editVersion: entry.editVersion + 1,
      });
    } else patch(key, { file });
  };
  const consume = async (
    key: string,
    command: SaveCommand,
    receipt: DocumentOperation,
  ): Promise<boolean> => {
    const entry = get(key);
    if (!entry || entry.pendingSave?.operationId !== command.operationId) return false;
    if (
      receipt.operationId !== command.operationId ||
      documentKey(receipt.target, command.path) !== key
    ) {
      patch(key, { error: 'The save receipt belongs to another document', saving: false });
      return false;
    }
    const result = receipt.result;
    if (
      receipt.state === 'succeeded' &&
      result?.kind === 'saved' &&
      result.editVersion === command.editVersion
    ) {
      patch(key, {
        baseText: command.text,
        baseHash: result.sha256,
        dirty: entry.text !== command.text,
        pendingSave: null,
        saving: false,
        canRetrySave: false,
        conflict: null,
        error: null,
        file: {
          ...entry.file,
          content: { kind: 'text', text: command.text },
          version: {
            sha256: result.sha256,
            bytes: result.bytes,
            encoding: 'utf-8',
            bom: command.text.startsWith('\ufeff'),
            eol: eolOf(command.text),
          },
        },
      });
      notifySaved();
      await persist(key);
      return true;
    }
    if (receipt.state === 'failed' || receipt.state === 'cancelled') {
      patch(key, {
        saving: false,
        pendingSave: null,
        canRetrySave: false,
        error: result?.kind === 'error' ? result.message : 'The save did not complete',
      });
      await persist(key);
      if (result?.kind === 'error' && result.code === 'REVISION_CONFLICT') await store.refresh(key);
      return false;
    }
    patch(key, {
      saving: false,
      canRetrySave: false,
      error: 'The save outcome is not confirmed. Check the original operation.',
    });
    await persist(key);
    return false;
  };
  const store: DocumentStore = Object.assign(state, {
    async open(sessionId: string, path: string) {
      const beforeRead = state.getState().documents;
      const file = await client.readDocument(sessionId, path);
      if (disposed) throw new Error('Document store is closed');
      const key = documentKey(file.target, file.path);
      if (!get(key)) {
        const text = textOf(file);
        state.setState({
          documents: {
            ...state.getState().documents,
            [key]: {
              key,
              target: file.target,
              path: file.path,
              file,
              model: null,
              text,
              baseText: text,
              baseHash: file.version?.sha256 ?? null,
              editVersion: 0,
              dirty: false,
              saving: false,
              pendingSave: null,
              canRetrySave: false,
              conflict: null,
              formatBlocked: blockedFormat(file),
              recoveries: [],
              otherRecoveries: [],
              recoverySavedVersion: null,
              recoveryError: null,
              modelError: null,
              error: null,
            },
          },
        });
      } else if (beforeRead[key]) applyFile(key, file, beforeRead[key]);
      await Promise.all([ensureModel(key), loadRecoveries(key)]);
      return key;
    },
    retainView(key: string, viewId: string) {
      const owned = views.get(key) ?? new Set<string>();
      owned.add(viewId);
      views.set(key, owned);
      return () => owned.delete(viewId);
    },
    async closeView(key: string, viewId: string, choice?: CloseChoice): Promise<CloseResult> {
      const entry = get(key);
      if (!entry) return 'closed';
      if (choice === 'cancel') return 'cancelled';
      const owned = views.get(key);
      if (owned && [...owned].some((id) => id !== viewId)) {
        owned.delete(viewId);
        return 'closed';
      }
      if (entry.dirty || entry.pendingSave) {
        if (!choice) return 'confirm';
        if (choice === 'save') {
          if (!(await store.save(key))) return 'failed';
          if (get(key)?.dirty || get(key)?.pendingSave) return 'confirm';
        } else if (entry.pendingSave || entry.saving) {
          patch(key, { error: 'Check the pending save before discarding this draft' });
          return 'failed';
        }
      }
      await discard(key);
      return 'closed';
    },
    save(key: string): Promise<boolean> {
      const running = saves.get(key);
      if (running) return running;
      const entry = get(key);
      if (!entry) return Promise.resolve(false);
      if (entry.pendingSave && !entry.canRetrySave) return Promise.resolve(false);
      if (
        !entry.pendingSave &&
        (!entry.file.writable || !editable(entry.file) || entry.formatBlocked || entry.conflict)
      ) {
        patch(key, { error: 'Resolve the document state before saving' });
        return Promise.resolve(false);
      }
      if (!entry.dirty && !entry.pendingSave && entry.file.content.kind !== 'absent')
        return Promise.resolve(true);
      const command = entry.pendingSave ?? {
        kind: 'save' as const,
        operationId: newOperationId(),
        target: entry.target,
        path: entry.path,
        baseHash: entry.baseHash,
        text: entry.text,
        editVersion: entry.editVersion,
      };
      patch(key, {
        pendingSave: command,
        saving: true,
        canRetrySave: false,
        error: null,
        writerBusy: false,
      });
      const work = (async () => {
        await persist(key);
        if (disposed) return false;
        try {
          return await consume(
            key,
            command,
            await client.changeDocument(entry.target.sessionId, command),
          );
        } catch (error) {
          const rejected = error instanceof ApiError && error.status < 500;
          patch(key, {
            saving: false,
            pendingSave: rejected ? null : command,
            error: message(error),
            writerBusy: error instanceof ApiError && error.code === 'RUN_ALREADY_ACTIVE',
          });
          await persist(key);
          if (error instanceof ApiError && error.code === 'REVISION_CONFLICT')
            await store.refresh(key);
          return false;
        }
      })();
      saves.set(key, work);
      void work.finally(() => saves.delete(key));
      return work;
    },
    async checkSave(key: string) {
      const entry = get(key);
      const command = entry?.pendingSave;
      if (!entry || !command || entry.saving) return false;
      try {
        return await consume(
          key,
          command,
          await client.documentOperation(entry.target.sessionId, command.operationId),
        );
      } catch (error) {
        if (get(key)?.pendingSave?.operationId !== command.operationId) return false;
        patch(key, {
          canRetrySave: error instanceof ApiError && error.status === 404,
          error:
            error instanceof ApiError && error.status === 404
              ? 'The save was not found. Retry the original request explicitly.'
              : message(error),
        });
        return false;
      }
    },
    async refresh(key: string) {
      const start = get(key);
      if (!start) return;
      const sequence = (refreshes.get(key) ?? 0) + 1;
      refreshes.set(key, sequence);
      try {
        const file = await client.readDocument(start.target.sessionId, start.path);
        if (refreshes.get(key) !== sequence) return;
        applyFile(key, file, start);
        await Promise.all([ensureModel(key), loadRecoveries(key)]);
      } catch (error) {
        patch(key, { error: message(error) });
      }
    },
    resolveConflict(key: string, choice: 'ours' | 'theirs') {
      const entry = get(key);
      const file = entry?.conflict;
      if (
        !entry ||
        !file ||
        entry.pendingSave ||
        documentKey(file.target, file.path) !== key ||
        !editable(file)
      ) {
        patch(key, { error: 'This conflict cannot be applied to the current document' });
        return false;
      }
      const baseText = textOf(file);
      const text = choice === 'theirs' ? baseText : entry.text;
      if (choice === 'theirs') modelText(key, text);
      patch(key, {
        file,
        baseText,
        baseHash: file.version?.sha256 ?? null,
        text,
        formatBlocked: choice === 'theirs' ? blockedFormat(file) : entry.formatBlocked,
        dirty: text !== baseText,
        conflict: null,
        error: null,
        editVersion: entry.editVersion + 1,
      });
      void persist(key);
      return true;
    },
    async restoreRecovery(key: string, recoveryId: string) {
      const entry = get(key);
      const draft = entry?.recoveries.find((candidate) => candidate.id === recoveryId);
      if (!entry || !draft) return;
      if (entry.dirty || entry.pendingSave) {
        patch(key, { error: 'Save or discard the current draft before restoring another draft' });
        return;
      }
      if (!editable(entry.file)) {
        patch(key, { error: 'This document cannot be edited' });
        return;
      }
      modelText(key, draft.text);
      patch(key, {
        text: draft.text,
        baseText: draft.baseText,
        baseHash: draft.baseHash,
        editVersion: draft.editVersion,
        dirty: draft.text !== draft.baseText,
        pendingSave: draft.pendingSave,
        canRetrySave: false,
        formatBlocked: draft.formatBlocked,
        conflict: draft.baseHash !== (entry.file.version?.sha256 ?? null) ? entry.file : null,
        error: null,
      });
      // Candidates remain until explicitly discarded; a failed local write cannot consume them.
      await persist(key);
    },
    async discardRecovery(key: string, recoveryId: string) {
      const entry = get(key);
      const draft =
        entry &&
        [...entry.recoveries, ...entry.otherRecoveries].find(
          (candidate) => candidate.id === recoveryId,
        );
      if (!draft) return;
      try {
        await store.discardRecoveryCandidate(draft);
        await loadRecoveries(key);
      } catch (error) {
        patch(key, { recoveryError: message(error) });
      }
    },
    async sessionRecoveries(scope: RecoveryScope) {
      return (await recovery.listSession(scope)).filter(
        (draft) =>
          (draft.clientId !== clientId || !get(draft.documentKey)) &&
          draft.target.hostId === scope.hostId &&
          draft.target.projectId === scope.projectId &&
          draft.target.sessionId === scope.sessionId &&
          documentKey(draft.target, draft.path) === draft.documentKey,
      );
    },
    discardRecoveryCandidate(draft: RecoveryDraft) {
      return recovery.remove(draft);
    },
    convertEol(key: string, eol: 'lf' | 'crlf') {
      const entry = get(key);
      if (!entry?.formatBlocked || !entry.file.writable) return;
      const text = entry.text.replace(/\r\n|\r|\n/g, eol === 'crlf' ? '\r\n' : '\n');
      modelText(key, text);
      patch(key, {
        text,
        formatBlocked: false,
        dirty: text !== entry.baseText,
        editVersion: entry.editVersion + 1,
        error: null,
      });
      void persist(key);
    },
    hasUnsaved() {
      return Object.values(state.getState().documents).some(
        (entry) => entry.dirty || entry.pendingSave !== null,
      );
    },
    dispose() {
      disposed = true;
      for (const listener of listeners.values()) listener.dispose();
      for (const entry of Object.values(state.getState().documents)) entry.model?.dispose();
      listeners.clear();
      views.clear();
      state.setState({ documents: {} });
      stores.delete(client);
    },
  });
  stores.set(client, store);
  return store;
}
