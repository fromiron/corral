import type { WorkspacesApi } from '@corral/client';
import type {
  LanguageInspection,
  LanguageLocation,
  LanguageQuery,
  LanguageQueryResult,
  LanguageRefactor,
  LanguageSession,
  LanguageState,
  TextRange,
  WorkspaceTarget,
} from '@corral/contracts';
import type { editor, languages } from 'monaco-editor/editor';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { loadMonaco, type Monaco } from '../documents/monaco.ts';
import { type DocumentBuffer, type DocumentStore, documentKey } from '../documents/store.ts';

export type LanguageClient = Pick<
  WorkspacesApi,
  | 'languageState'
  | 'inspectLanguage'
  | 'startLanguage'
  | 'syncLanguage'
  | 'queryLanguage'
  | 'stopLanguage'
>;
export interface LanguageCopy {
  state: LanguageState | null;
  inspection: LanguageInspection | null;
  error: string | null;
  busy: boolean;
}
export const languageCopyKey = (target: WorkspaceTarget) => documentKey(target, '');
export type LanguageEditScope = Pick<
  LanguageRefactor,
  'target' | 'generation' | 'clientId' | 'path' | 'version'
>;
export interface LanguageStore extends StoreApi<{ copies: Record<string, LanguageCopy> }> {
  readonly clientId: string;
  retain(target: WorkspaceTarget): () => void;
  refresh(target: WorkspaceTarget): Promise<void>;
  inspect(target: WorkspaceTarget, serverId: string): Promise<void>;
  start(target: WorkspaceTarget, trust: boolean): Promise<void>;
  stop(target: WorkspaceTarget): Promise<void>;
  query(
    key: string,
    operation: LanguageQuery['operation'],
    position?: LanguageQuery['position'],
  ): Promise<LanguageQueryResult | null>;
  openLocation(
    key: string,
    resource: string,
    range: TextRange,
    open: (target: WorkspaceTarget, path: string, range: TextRange) => boolean,
  ): Promise<boolean>;
  editScope(key: string): Promise<LanguageEditScope | null>;
  documentVersion(key: string): number | null;
  dispose(): void;
}
const stores = new WeakMap<LanguageClient, LanguageStore>();
const markerOwner = 'corral-language';
// LSP and Monaco assign different numeric kinds.
const completionKinds = [
  18, 0, 1, 2, 3, 4, 5, 7, 8, 9, 12, 13, 15, 17, 28, 19, 20, 21, 23, 16, 14, 6, 10, 11, 24,
];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const rangeOf = (range: LanguageLocation['range']) => ({
  startLineNumber: range.start.line + 1,
  startColumn: range.start.character + 1,
  endLineNumber: range.end.line + 1,
  endColumn: range.end.character + 1,
});

/** One language owner subscribes to shared documents; views never own processes or buffers. */
export function languageStore(
  client: LanguageClient,
  documents: DocumentStore,
  options: {
    clientId?: string;
    newRequestId?: () => string;
    loadMonaco?: () => Promise<Monaco>;
  } = {},
): LanguageStore {
  const previous = stores.get(client);
  if (previous) return previous;
  const state = createStore<{ copies: Record<string, LanguageCopy> }>(() => ({ copies: {} }));
  const clientId = options.clientId ?? `language_client_${crypto.randomUUID().replaceAll('-', '')}`;
  const newRequestId =
    options.newRequestId ?? (() => `language_start_${crypto.randomUUID().replaceAll('-', '')}`);
  const engine = options.loadMonaco ?? loadMonaco;
  type CopyRuntime = {
    target: WorkspaceTarget;
    refs: number;
    epoch: number;
    timer?: ReturnType<typeof setInterval>;
    read?: Promise<void>;
    pendingStart?: string;
    generation?: string;
    sent: Map<string, { path: string; version: number }>;
    versions: Map<string, { model: DocumentBuffer['model']; editVersion: number; value: number }>;
    syncing?: Promise<void>;
    again: boolean;
  };
  const copies = new Map<string, CopyRuntime>();
  const locations = new Map<
    string,
    {
      target: WorkspaceTarget;
      sourceKey: string;
      sourceVersion: number;
      generation: string;
      location: LanguageLocation;
    }
  >();
  let disposed = false;
  let monaco: Monaco | undefined;
  let providerKey = '';
  let providers: { dispose(): void }[] = [];
  let loadingProviders: Promise<void> | undefined;
  const get = (key: string) => state.getState().copies[key];
  const patch = (key: string, update: Partial<LanguageCopy>) => {
    if (!disposed)
      state.setState({
        copies: {
          ...state.getState().copies,
          [key]: {
            state: null,
            inspection: null,
            error: null,
            busy: false,
            ...get(key),
            ...update,
          },
        },
      });
  };
  const runtime = (target: WorkspaceTarget) => {
    const key = languageCopyKey(target);
    let copy = copies.get(key);
    if (!copy) {
      copy = { target, refs: 0, epoch: 0, sent: new Map(), versions: new Map(), again: false };
      copies.set(key, copy);
      patch(key, {});
    }
    return copy;
  };
  const version = (entry: DocumentBuffer) => {
    const copy = runtime(entry.target);
    const old = copy.versions.get(entry.path);
    if (old?.model === entry.model && old.editVersion === entry.editVersion) return old.value;
    const value = (old?.value ?? 0) + 1;
    copy.versions.set(entry.path, { model: entry.model, editVersion: entry.editVersion, value });
    return value;
  };
  const entryOf = (model: editor.ITextModel) =>
    Object.values(documents.getState().documents).find((entry) => entry.model === model);
  const languageOf = (entry: DocumentBuffer, copy: LanguageCopy) => {
    const server = copy.state?.servers.find(
      (candidate) => candidate.id === copy.state?.session?.serverId,
    );
    if (
      !server?.fileExtensions.some((extension) =>
        entry.path.toLowerCase().endsWith(extension.toLowerCase()),
      )
    )
      return null;
    const languageId = entry.path.endsWith('.tsx')
      ? 'typescriptreact'
      : entry.path.endsWith('.jsx')
        ? 'javascriptreact'
        : entry.model?.getLanguageId();
    return languageId && server.languageIds.includes(languageId) ? languageId : null;
  };
  const supported = (entry: DocumentBuffer, copy: LanguageCopy) => Boolean(languageOf(entry, copy));
  const active = (entry: DocumentBuffer) => {
    const copy = get(languageCopyKey(entry.target));
    const session = copy?.state?.session;
    return copy &&
      session?.state === 'running' &&
      session.clientId === clientId &&
      supported(entry, copy)
      ? session
      : null;
  };
  const markers = () => {
    if (!monaco) return;
    for (const entry of Object.values(documents.getState().documents)) {
      if (!entry.model) continue;
      const session = active(entry);
      const diagnostics =
        session?.diagnostics.find(
          (item) => item.path === entry.path && item.documentVersion === version(entry),
        )?.diagnostics ?? [];
      monaco.editor.setModelMarkers(
        entry.model,
        markerOwner,
        diagnostics.map((diagnostic) => ({
          ...rangeOf(diagnostic.range),
          severity:
            diagnostic.severity === 2
              ? monaco!.MarkerSeverity.Warning
              : diagnostic.severity === 3
                ? monaco!.MarkerSeverity.Info
                : diagnostic.severity === 4
                  ? monaco!.MarkerSeverity.Hint
                  : monaco!.MarkerSeverity.Error,
          message: diagnostic.message,
          ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
          ...(diagnostic.source ? { source: diagnostic.source } : {}),
        })),
      );
    }
  };
  const locationResults = (entry: DocumentBuffer, result: LanguageQueryResult) => {
    const current = documents.getState().documents[entry.key];
    if (
      result.result.kind !== 'locations' ||
      !monaco ||
      !current ||
      version(current) !== result.documentVersion
    )
      return [];
    for (const [uri, location] of locations)
      if (location.sourceKey === entry.key) locations.delete(uri);
    return result.result.locations.map((location) => {
      const uri = monaco!.Uri.from({
        scheme: 'corral-document',
        authority: entry.model!.uri.authority,
        path: `/${location.path}`,
        query: documentKey(entry.target, location.path),
      });
      locations.set(`${entry.key}:${uri.toString()}`, {
        target: entry.target,
        sourceKey: entry.key,
        sourceVersion: result.documentVersion,
        generation: result.generation,
        location,
      });
      return { uri, range: rangeOf(location.range) };
    });
  };
  const installProviders = async () => {
    monaco ??= await engine();
    if (disposed) return;
    const configurations = Object.entries(state.getState().copies).flatMap(([key, copy]) => {
      const session = copy.state?.session;
      const server = copy.state?.servers.find((candidate) => candidate.id === session?.serverId);
      return session?.state === 'running' && session.clientId === clientId && server
        ? [
            {
              key,
              languageIds: server.languageIds.map((id) =>
                id === 'typescriptreact'
                  ? 'typescript'
                  : id === 'javascriptreact'
                    ? 'javascript'
                    : id,
              ),
              capabilities: session.capabilities,
            },
          ]
        : [];
    });
    const nextKey = JSON.stringify(configurations);
    if (nextKey === providerKey) {
      markers();
      return;
    }
    for (const provider of providers) provider.dispose();
    providers = [];
    providerKey = nextKey;
    const selector = (kind: 'completion' | 'definition' | 'references') =>
      [
        ...new Set(
          configurations
            .filter((item) => item.capabilities[kind])
            .flatMap((item) => item.languageIds),
        ),
      ].map((language) => ({ language, scheme: 'corral-document' }));
    if (selector('completion').length)
      providers.push(
        monaco.languages.registerCompletionItemProvider(selector('completion'), {
          triggerCharacters: [
            ...new Set(configurations.flatMap((item) => item.capabilities.triggerCharacters)),
          ],
          async provideCompletionItems(model, position, _context, token) {
            const entry = entryOf(model);
            if (!entry || !active(entry)?.capabilities.completion) return null;
            const result = await owner.query(entry.key, 'completion', {
              line: position.lineNumber - 1,
              character: position.column - 1,
            });
            if (token.isCancellationRequested || result?.result.kind !== 'completion') return null;
            const word = model.getWordUntilPosition(position);
            return {
              suggestions: result.result.items.map((item) => ({
                label: item.label,
                insertText: item.insertText,
                kind: (completionKinds[(item.kind ?? 1) - 1] ?? 18) as languages.CompletionItemKind,
                ...(item.detail ? { detail: item.detail } : {}),
                ...(item.sortText ? { sortText: item.sortText } : {}),
                ...(item.filterText ? { filterText: item.filterText } : {}),
                range: item.range
                  ? rangeOf(item.range)
                  : {
                      startLineNumber: position.lineNumber,
                      endLineNumber: position.lineNumber,
                      startColumn: word.startColumn,
                      endColumn: word.endColumn,
                    },
              })),
            };
          },
        }),
      );
    if (selector('definition').length)
      providers.push(
        monaco.languages.registerDefinitionProvider(selector('definition'), {
          async provideDefinition(model, position, token) {
            const entry = entryOf(model);
            if (!entry || !active(entry)?.capabilities.definition) return null;
            const result = await owner.query(entry.key, 'definition', {
              line: position.lineNumber - 1,
              character: position.column - 1,
            });
            return token.isCancellationRequested || !result ? null : locationResults(entry, result);
          },
        }),
      );
    if (selector('references').length)
      providers.push(
        monaco.languages.registerReferenceProvider(selector('references'), {
          async provideReferences(model, position, _context, token) {
            const entry = entryOf(model);
            if (!entry || !active(entry)?.capabilities.references) return null;
            const result = await owner.query(entry.key, 'references', {
              line: position.lineNumber - 1,
              character: position.column - 1,
            });
            return token.isCancellationRequested || !result ? null : locationResults(entry, result);
          },
        }),
      );
    markers();
  };
  const updateProviders = () => {
    if (!loadingProviders)
      loadingProviders = installProviders()
        .catch((error) => {
          for (const [key] of copies) patch(key, { error: message(error) });
        })
        .finally(() => {
          loadingProviders = undefined;
        });
  };
  const applySession = (copy: CopyRuntime, session: LanguageSession | null) => {
    const key = languageCopyKey(copy.target);
    const current = get(key)?.state;
    if (!current) return;
    if (copy.generation !== session?.generation) {
      copy.generation = session?.generation;
      copy.sent.clear();
      for (const [uri, location] of locations)
        if (languageCopyKey(location.target) === key) locations.delete(uri);
    }
    patch(key, { state: { ...current, session } });
    updateProviders();
  };
  const sync = (copy: CopyRuntime): Promise<void> => {
    copy.again = true;
    if (copy.syncing) return copy.syncing;
    copy.syncing = (async () => {
      while (copy.again && !disposed) {
        copy.again = false;
        const key = languageCopyKey(copy.target);
        const session = get(key)?.state?.session;
        if (session?.state !== 'running' || session.clientId !== clientId) return;
        const current = () => get(key)?.state?.session?.generation === session.generation;
        const entries = Object.values(documents.getState().documents).filter(
          (entry) =>
            languageCopyKey(entry.target) === key && entry.model && supported(entry, get(key)!),
        );
        for (const [document, sent] of copy.sent) {
          if (entries.some((entry) => entry.key === document)) continue;
          const next = await client.syncLanguage(copy.target.sessionId, {
            target: copy.target,
            generation: session.generation,
            clientId,
            path: sent.path,
            version: sent.version,
            kind: 'close',
          });
          if (!current()) return;
          copy.sent.delete(document);
          for (const [uri, location] of locations)
            if (location.sourceKey === document) locations.delete(uri);
          applySession(copy, next);
        }
        for (const entry of entries) {
          if (!current()) return;
          const documentVersion = version(entry);
          if (copy.sent.get(entry.key)?.version === documentVersion) continue;
          const next = await client.syncLanguage(copy.target.sessionId, {
            target: copy.target,
            generation: session.generation,
            clientId,
            path: entry.path,
            version: documentVersion,
            kind: 'sync',
            languageId: languageOf(entry, get(key)!)!,
            text: entry.text.replace(/^\uFEFF/, ''),
          });
          if (!current()) return;
          copy.sent.set(entry.key, { path: entry.path, version: documentVersion });
          applySession(copy, next);
          if (session.capabilities.diagnosticPull) {
            const result = await client.queryLanguage(copy.target.sessionId, {
              target: copy.target,
              generation: session.generation,
              clientId,
              path: entry.path,
              version: documentVersion,
              operation: 'diagnostics',
            });
            const latest = documents.getState().documents[entry.key];
            if (
              current() &&
              latest &&
              version(latest) === result.documentVersion &&
              result.generation === session.generation &&
              result.result.kind === 'diagnostics'
            ) {
              const latestSession = get(key)!.state!.session!;
              applySession(copy, {
                ...latestSession,
                diagnostics: [
                  ...latestSession.diagnostics.filter((item) => item.path !== entry.path),
                  {
                    path: entry.path,
                    documentVersion: result.documentVersion,
                    diagnostics: result.result.diagnostics,
                  },
                ],
              });
            }
          }
        }
      }
    })()
      .catch((error) => patch(languageCopyKey(copy.target), { error: message(error) }))
      .finally(() => {
        copy.syncing = undefined;
        markers();
        if (copy.again && !disposed) void sync(copy);
      });
    return copy.syncing;
  };
  const poll = (copy: CopyRuntime) => {
    if (!copy.timer) copy.timer = setInterval(() => void owner.refresh(copy.target), 2000);
  };
  const work = async (target: WorkspaceTarget, task: (copy: CopyRuntime) => Promise<void>) => {
    const key = languageCopyKey(target);
    const copy = runtime(target);
    if (get(key)?.busy) return;
    ++copy.epoch;
    patch(key, { busy: true, error: null });
    try {
      await task(copy);
    } catch (error) {
      patch(key, { error: message(error) });
    } finally {
      patch(key, { busy: false });
    }
  };
  const owner: LanguageStore = Object.assign(state, {
    clientId,
    retain(target: WorkspaceTarget) {
      const copy = runtime(target);
      if (++copy.refs === 1) {
        void owner.refresh(target);
        poll(copy);
      }
      return () => {
        copy.refs--;
        if (!copy.refs && !get(languageCopyKey(target))?.state?.session && copy.timer) {
          clearInterval(copy.timer);
          copy.timer = undefined;
        }
      };
    },
    async refresh(target: WorkspaceTarget) {
      const copy = runtime(target);
      if (copy.read) return copy.read;
      const epoch = copy.epoch;
      copy.read = (async () => {
        try {
          const result = await client.languageState(target.sessionId);
          if (disposed || epoch !== copy.epoch) return;
          const key = languageCopyKey(target);
          if (languageCopyKey(result.target) !== key) {
            patch(key, {
              state: null,
              error: 'This working copy has changed. Reopen the document.',
            });
            copy.sent.clear();
            updateProviders();
            return;
          }
          const previousGeneration = get(key)?.state?.session?.generation;
          patch(key, { state: { ...result, session: get(key)?.state?.session ?? null } });
          applySession(copy, result.session);
          if (previousGeneration !== result.session?.generation) copy.sent.clear();
          if (result.session) poll(copy);
          void sync(copy);
        } catch (error) {
          if (!disposed && epoch === copy.epoch)
            patch(languageCopyKey(target), { error: message(error) });
        }
      })().finally(() => {
        copy.read = undefined;
      });
      return copy.read;
    },
    inspect(target: WorkspaceTarget, serverId: string) {
      return work(target, async (copy) => {
        const inspection = await client.inspectLanguage(target.sessionId, { target, serverId });
        if (languageCopyKey(inspection.target) !== languageCopyKey(target))
          throw new Error('The language server belongs to another copy');
        copy.pendingStart = undefined;
        patch(languageCopyKey(target), { inspection });
      });
    },
    start(target: WorkspaceTarget, trust: boolean) {
      return work(target, async (copy) => {
        const inspection = get(languageCopyKey(target))?.inspection;
        if (!inspection) return;
        copy.pendingStart ??= newRequestId();
        const session = await client.startLanguage(target.sessionId, {
          target,
          clientId,
          requestId: copy.pendingStart,
          serverId: inspection.server.id,
          configRevision: inspection.configRevision,
          fingerprint: inspection.fingerprint,
          trust,
        });
        applySession(copy, session);
        poll(copy);
        await sync(copy);
      });
    },
    stop(target: WorkspaceTarget) {
      return work(target, async (copy) => {
        const session = get(languageCopyKey(target))?.state?.session;
        if (!session) return;
        await client.stopLanguage(target.sessionId, { target, generation: session.generation });
        applySession(copy, null);
        copy.pendingStart = undefined;
        patch(languageCopyKey(target), { inspection: null });
      });
    },
    async query(
      key: string,
      operation: LanguageQuery['operation'],
      position?: LanguageQuery['position'],
    ) {
      const entry = documents.getState().documents[key];
      const session = entry && active(entry);
      if (!entry || !session || !session.capabilities[operation]) return null;
      const copy = runtime(entry.target);
      const documentVersion = version(entry);
      await sync(copy);
      const latest = documents.getState().documents[key];
      if (
        !latest ||
        version(latest) !== documentVersion ||
        active(latest)?.generation !== session.generation
      )
        return null;
      try {
        const result = await client.queryLanguage(entry.target.sessionId, {
          target: entry.target,
          generation: session.generation,
          clientId,
          path: entry.path,
          version: documentVersion,
          operation,
          ...(position ? { position } : {}),
        });
        const current = documents.getState().documents[key];
        return current &&
          active(current)?.generation === result.generation &&
          version(current) === result.documentVersion
          ? result
          : null;
      } catch (error) {
        patch(languageCopyKey(entry.target), { error: message(error) });
        return null;
      }
    },
    async openLocation(
      key: string,
      resource: string,
      range: TextRange,
      open: (target: WorkspaceTarget, path: string, range: TextRange) => boolean,
    ) {
      const source = documents.getState().documents[key];
      const destination = locations.get(`${key}:${resource}`);
      if (
        !source ||
        !destination ||
        languageCopyKey(source.target) !== languageCopyKey(destination.target) ||
        active(source)?.generation !== destination.generation ||
        version(source) !== destination.sourceVersion
      )
        return false;
      const opened = await documents.open(destination.target.sessionId, destination.location.path);
      const entry = documents.getState().documents[opened];
      const currentSource = documents.getState().documents[key];
      if (
        !currentSource ||
        active(currentSource)?.generation !== destination.generation ||
        version(currentSource) !== destination.sourceVersion ||
        !entry ||
        languageCopyKey(entry.target) !== languageCopyKey(destination.target) ||
        (destination.location.documentVersion !== null
          ? version(entry) !== destination.location.documentVersion
          : entry.dirty || entry.baseHash !== destination.location.sha256)
      )
        return false;
      return open(entry.target, entry.path, range);
    },
    async editScope(key: string) {
      const entry = documents.getState().documents[key];
      const session = entry && active(entry);
      if (!entry || !session || entry.dirty || entry.saving || entry.pendingSave || entry.conflict)
        return null;
      const requestedVersion = version(entry);
      await documents.refresh(key);
      const current = documents.getState().documents[key];
      if (
        !current ||
        current.dirty ||
        current.saving ||
        current.pendingSave ||
        current.conflict ||
        version(current) !== requestedVersion ||
        active(current)?.generation !== session.generation
      )
        return null;
      await sync(runtime(current.target));
      const latest = documents.getState().documents[key];
      if (
        !latest ||
        latest.dirty ||
        latest.saving ||
        latest.pendingSave ||
        latest.conflict ||
        version(latest) !== requestedVersion ||
        active(latest)?.generation !== session.generation
      )
        return null;
      return {
        target: latest.target,
        generation: session.generation,
        clientId,
        path: latest.path,
        version: requestedVersion,
      };
    },
    documentVersion(key: string) {
      const entry = documents.getState().documents[key];
      return entry ? version(entry) : null;
    },
    dispose() {
      disposed = true;
      stopDocuments();
      for (const copy of copies.values()) if (copy.timer) clearInterval(copy.timer);
      for (const provider of providers) provider.dispose();
      if (monaco)
        for (const entry of Object.values(documents.getState().documents))
          if (entry.model) monaco.editor.setModelMarkers(entry.model, markerOwner, []);
      stores.delete(client);
    },
  });
  const stopDocuments = documents.subscribe(() => {
    markers();
    for (const copy of copies.values()) void sync(copy);
  });
  stores.set(client, owner);
  return owner;
}
