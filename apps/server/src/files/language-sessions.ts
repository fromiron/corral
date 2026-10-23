import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type HostProcessReservation,
  restoreHostProcessGroupReservation,
} from '@corral/adapter-pi/processes';
import {
  type Clock,
  canonicalJson,
  LanguageCompletion,
  LanguageDocumentChange,
  LanguageInspect,
  type LanguageInspection,
  LanguageQuery,
  LanguageQueryResult,
  LanguageScope,
  type LanguageSession,
  LanguageStart,
  type LanguageState,
  LspRange,
  type RegisteredLspServer,
  type Scheduler,
  type WorkspaceTarget,
} from '@corral/contracts';
import { type ToolCancellation, ToolRefusal, ToolTerminationUnconfirmed } from '@corral/core';
import type { SqliteProjectToolStore } from '@corral/storage-sqlite';
import { cleanupPtySession, type PtySessionIdentity } from '../processes/pty-session.ts';
import { redactToolText } from './check-output.ts';
import { LanguageConnection } from './language-connection.ts';
import { launchFingerprint } from './launch-fingerprint.ts';
import { type LspDocument, lspResults, validateLspPosition } from './lsp-results.ts';
import type { WorkbenchOperations } from './workbench-operations.ts';

type Connection = Pick<
  LanguageConnection,
  'capabilities' | 'sync' | 'closeDocument' | 'query' | 'close'
>;
export interface LanguageTransport {
  start(input: Parameters<typeof LanguageConnection.start>[0]): Promise<Connection>;
}
type Document = LspDocument & { uri: string; languageId: string; version: number };
type Entry = {
  target: WorkspaceTarget;
  path: string;
  server: RegisteredLspServer;
  view: LanguageSession;
  documents: Map<string, Document>;
  versions: Map<string, number>;
  revision: number;
  connection?: Connection;
  starting?: Promise<void>;
  closing?: Promise<void>;
  identity?: PtySessionIdentity;
  restored?: HostProcessReservation;
  stopped: boolean;
  cleaned?: boolean;
};
type Stored = {
  kind: 'language';
  session: LanguageSession;
  server: RegisteredLspServer;
  identity?: PtySessionIdentity;
};
interface Options {
  clock: Clock;
  timers: Scheduler;
  tools: SqliteProjectToolStore;
  operations: WorkbenchOperations;
  context(
    sessionId: string,
    expected?: WorkspaceTarget,
  ): { target: WorkspaceTarget; path: string; trusted: boolean; closing: boolean };
  safePath(path: string): string;
  plainPath(root: string, path: string): Promise<'file' | 'missing' | 'other'>;
  read(root: string, path: string): Promise<string>;
  transport?: LanguageTransport;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const emptyCapabilities = () => ({
  completion: false,
  definition: false,
  references: false,
  diagnostics: false,
  diagnosticPull: false,
  triggerCharacters: [],
});
const refusal = (code: ConstructorParameters<typeof ToolRefusal>[0], message: string) =>
  new ToolRefusal(code, message);

/** Human language buffers are passive process owners, never a working-copy writer. */
export class LanguageSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    for (const receipt of options.operations.list('language')) {
      if (receipt.state !== 'uncertain') continue;
      const stored = receipt.result as Stored | null;
      if (stored?.kind !== 'language') continue;
      this.entries.set(receipt.target.sessionId, {
        target: receipt.target,
        path: '',
        server: stored.server,
        view: {
          ...stored.session,
          state: 'uncertain',
          diagnostics: [],
          error:
            'The host restarted; explicitly stop this language session before starting another.',
        },
        documents: new Map(),
        versions: new Map(),
        revision: 0,
        identity: stored.identity,
        restored: restoreHostProcessGroupReservation(),
        stopped: false,
      });
    }
  }
  private stored(entry: Entry): Stored {
    return {
      kind: 'language',
      session: entry.view,
      server: entry.server,
      ...(entry.identity ? { identity: entry.identity } : {}),
    };
  }
  private persist(entry: Entry) {
    this.options.operations.updateRunning(entry.view.generation, this.stored(entry));
  }
  private current(sessionId: string, expected?: WorkspaceTarget) {
    const context = this.options.context(sessionId, expected);
    if (context.closing) throw refusal('TARGET_TERMINAL', 'the working copy is closing');
    if (!context.trusted)
      throw refusal('CAPABILITY_DENIED', 'trust the repository before starting a language server');
    return context;
  }
  private compatible(entry: Entry) {
    const context = this.current(entry.target.sessionId, entry.target);
    const config = this.options.tools.latest(entry.target.projectId);
    if (
      config?.revision !== entry.view.configRevision ||
      !this.options.tools.trust({
        projectId: entry.target.projectId,
        kind: 'lsp',
        id: entry.server.id,
        fingerprint: entry.view.fingerprint,
      })
    )
      throw refusal('REVISION_CONFLICT', 'language server configuration or trust changed');
    return context;
  }
  async state(sessionId: string): Promise<LanguageState> {
    const context = this.options.context(sessionId);
    const config = this.options.tools.latest(context.target.projectId);
    const entry = this.entries.get(sessionId);
    return {
      target: context.target,
      available: process.platform === 'linux' && context.trusted,
      unavailableReason:
        process.platform !== 'linux' ? 'platform' : !context.trusted ? 'untrusted' : null,
      servers: (config?.lspServers ?? []).map(({ id, name, languageIds, fileExtensions }) => ({
        id,
        name,
        languageIds,
        fileExtensions,
      })),
      session: entry ? structuredClone(entry.view) : null,
    };
  }
  async inspect(sessionId: string, raw: LanguageInspect): Promise<LanguageInspection> {
    const input = LanguageInspect.parse(raw),
      context = this.current(sessionId, input.target);
    const config = this.options.tools.latest(input.target.projectId);
    const server = config?.lspServers.find((server) => server.id === input.serverId);
    if (!config || !server) throw refusal('TARGET_NOT_FOUND', 'language server is not registered');
    const launch = await launchFingerprint(context.path, config.revision, server);
    this.current(sessionId, input.target);
    if (this.options.tools.latest(input.target.projectId)?.revision !== config.revision)
      throw refusal('REVISION_CONFLICT', 'language server configuration changed');
    return {
      target: context.target,
      server,
      configRevision: config.revision,
      fingerprint: launch.fingerprint,
      trusted: Boolean(
        this.options.tools.trust({
          projectId: input.target.projectId,
          kind: 'lsp',
          id: server.id,
          fingerprint: launch.fingerprint,
        }),
      ),
    };
  }
  async start(sessionId: string, raw: LanguageStart): Promise<LanguageSession> {
    const input = LanguageStart.parse(raw),
      context = this.current(sessionId, input.target);
    if (process.platform !== 'linux')
      throw refusal(
        'CAPABILITY_DENIED',
        'Persistent language session cleanup is currently qualified on Linux only',
      );
    const requestHash = hash(canonicalJson(input));
    const prior = this.options.operations.get(input.requestId);
    if (prior) {
      if (prior.kind !== 'language' || prior.requestHash !== requestHash)
        throw refusal('REVISION_CONFLICT', 'language start request changed');
      const entry = this.entries.get(sessionId);
      if (!entry || entry.view.generation !== input.requestId)
        throw refusal('TARGET_TERMINAL', 'this language start already ended');
      await entry.starting;
      return structuredClone(entry.view);
    }
    if (this.entries.has(sessionId))
      throw refusal('RUN_ALREADY_ACTIVE', 'stop the current language session first');
    const config = this.options.tools.latest(input.target.projectId);
    const server = config?.lspServers.find((server) => server.id === input.serverId);
    if (!config || !server) throw refusal('TARGET_NOT_FOUND', 'language server is not registered');
    if (config.revision !== input.configRevision)
      throw refusal('REVISION_CONFLICT', 'language server configuration changed');
    const entry: Entry = {
      target: input.target,
      path: context.path,
      server,
      documents: new Map(),
      versions: new Map(),
      revision: 0,
      stopped: false,
      view: {
        generation: input.requestId,
        clientId: input.clientId,
        serverId: server.id,
        configRevision: config.revision,
        fingerprint: input.fingerprint,
        state: 'starting',
        capabilities: emptyCapabilities(),
        diagnostics: [],
        error: null,
      },
    };
    this.options.operations.admit(
      { operationId: input.requestId, target: input.target, kind: 'language', requestHash },
      context.path,
      this.stored(entry),
    );
    this.entries.set(sessionId, entry);
    entry.starting = this.launch(entry, input);
    await entry.starting;
    return structuredClone(entry.view);
  }
  private async launch(entry: Entry, input: LanguageStart) {
    try {
      const launch = await launchFingerprint(entry.path, entry.view.configRevision, entry.server);
      this.current(entry.target.sessionId, entry.target);
      if (
        this.options.tools.latest(entry.target.projectId)?.revision !== input.configRevision ||
        launch.fingerprint !== input.fingerprint
      )
        throw refusal('REVISION_CONFLICT', 'language server launch changed');
      const trust = {
        projectId: entry.target.projectId,
        kind: 'lsp' as const,
        id: entry.server.id,
        fingerprint: launch.fingerprint,
      };
      if (input.trust) this.options.tools.setTrust(trust, true);
      if (!this.options.tools.trust(trust))
        throw refusal('CAPABILITY_DENIED', 'inspect and trust this language server launch first');
      if (entry.stopped) throw refusal('TARGET_TERMINAL', 'language server start was cancelled');
      entry.connection = await (this.options.transport ?? LanguageConnection).start({
        cwd: entry.path,
        argv: [launch.executable, ...entry.server.argv.slice(1)],
        timeoutMs: entry.server.timeoutMs,
        clock: this.options.clock,
        timers: this.options.timers,
        owner: entry.view.generation,
        onSpawn: (identity) => {
          entry.identity = identity;
          if (!this.options.operations.updateRunning(entry.view.generation, this.stored(entry)))
            throw refusal('REVISION_CONFLICT', 'language process ownership changed before launch');
        },
        onDiagnostics: (uri, version, diagnostics) => {
          void this.diagnostics(entry, uri, version, diagnostics).catch(() => {});
        },
        onFailure: () =>
          this.fail(
            entry,
            'The language server stopped. Stop this session before starting it again.',
          ),
      });
      this.compatible(entry);
      if (entry.stopped || entry.view.state === 'failed')
        throw refusal('TARGET_TERMINAL', 'language server start was cancelled');
      entry.view.state = 'running';
      entry.view.capabilities = entry.connection.capabilities;
      this.persist(entry);
    } catch (error) {
      entry.view.state = error instanceof ToolTerminationUnconfirmed ? 'uncertain' : 'failed';
      entry.view.error =
        error instanceof ToolRefusal ? error.message : 'The language server could not start.';
      if (error instanceof ToolTerminationUnconfirmed)
        this.options.operations.finish(entry.view.generation, 'uncertain', this.stored(entry));
      else if (!entry.connection) {
        entry.cleaned = true;
        entry.stopped = true;
        this.options.operations.finish(entry.view.generation, 'failed', this.stored(entry));
      } else this.persist(entry);
      throw error;
    }
  }
  private fail(entry: Entry, message: string) {
    if (entry.stopped) return;
    entry.view.state = 'failed';
    entry.view.error = message;
    entry.view.diagnostics = [];
    this.persist(entry);
    void this.close(entry).catch(() => {});
  }
  invalidate(projectId: string, serverId?: string, fingerprint?: string) {
    for (const entry of this.entries.values())
      if (
        entry.target.projectId === projectId &&
        (!serverId || entry.server.id === serverId) &&
        (!fingerprint || entry.view.fingerprint === fingerprint)
      )
        this.fail(
          entry,
          'Language server configuration or trust changed. Start a new session after reviewing it.',
        );
  }
  private async active(sessionId: string, scope: LanguageScope & { clientId?: string }) {
    this.current(sessionId, scope.target);
    const entry = this.entries.get(sessionId);
    if (
      !entry ||
      entry.view.generation !== scope.generation ||
      canonicalJson(entry.target) !== canonicalJson(scope.target) ||
      ('clientId' in scope && entry.view.clientId !== scope.clientId)
    )
      throw refusal('REVISION_CONFLICT', 'language session target or controller changed');
    await entry.starting;
    if (entry.view.state !== 'running' || entry.stopped || !entry.connection)
      throw refusal('TARGET_TERMINAL', 'language session is not running');
    try {
      this.compatible(entry);
    } catch (error) {
      this.fail(entry, 'Language server configuration or trust changed.');
      throw error;
    }
    return entry;
  }
  private async path(entry: Entry, raw: string) {
    const path = this.options.safePath(raw);
    const kind = await this.options.plainPath(entry.path, path);
    if (kind === 'other')
      throw refusal('CAPABILITY_DENIED', 'language documents must be plain files');
    if (kind === 'missing') {
      const parent = dirname(path);
      if (parent !== '.' && (await this.options.plainPath(entry.path, parent)) !== 'other')
        throw refusal('TARGET_NOT_FOUND', 'the document parent is unavailable');
    }
    return path;
  }
  async sync(sessionId: string, raw: LanguageDocumentChange): Promise<LanguageSession> {
    const input = LanguageDocumentChange.parse(raw),
      entry = await this.active(sessionId, input);
    const path = await this.path(entry, input.path),
      prior = entry.documents.get(path);
    if (input.kind === 'close') {
      if (prior && prior.version !== input.version)
        throw refusal('REVISION_CONFLICT', 'document version changed');
      if (prior) {
        entry.documents.delete(path);
        entry.revision++;
        entry.view.diagnostics = entry.view.diagnostics.filter((d) => d.path !== path);
        await entry.connection?.closeDocument(prior.uri);
      }
    } else {
      if (!prior && input.version <= (entry.versions.get(path) ?? 0))
        throw refusal('REVISION_CONFLICT', 'reopened document version must advance');
      if (
        !entry.server.languageIds.includes(input.languageId) ||
        !entry.server.fileExtensions.some((ext) => path.toLowerCase().endsWith(ext.toLowerCase()))
      )
        throw refusal(
          'CAPABILITY_DENIED',
          'the registered language server does not support this document',
        );
      if (
        prior &&
        (input.version < prior.version ||
          (input.version === prior.version &&
            (input.text !== prior.text || input.languageId !== prior.languageId)))
      )
        throw refusal('REVISION_CONFLICT', 'document version changed');
      if (!prior || prior.version !== input.version) {
        if (
          (!prior && entry.documents.size >= 64) ||
          Buffer.byteLength(input.text) > 1024 * 1024 ||
          [...entry.documents.values()].reduce(
            (size, d) => size + (d.path === path ? 0 : Buffer.byteLength(d.text)),
            Buffer.byteLength(input.text),
          ) >
            8 * 1024 * 1024
        )
          throw refusal('LIMIT_REACHED', 'language document limit exceeded');
        const document = {
          path,
          uri: pathToFileURL(join(entry.path, path)).href,
          text: input.text,
          sha256: hash(input.text),
          languageId: input.languageId,
          version: input.version,
        };
        entry.documents.set(path, document);
        entry.versions.set(path, input.version);
        entry.revision++;
        entry.view.diagnostics = entry.view.diagnostics.filter((d) => d.path !== path);
        try {
          await entry.connection?.sync(document);
        } catch (error) {
          this.fail(entry, 'The language server could not synchronize this document.');
          throw error;
        }
      }
    }
    await this.active(sessionId, input);
    return structuredClone(entry.view);
  }
  private async readUri(entry: Entry, uri: string): Promise<Document> {
    let path: string;
    try {
      path = this.options.safePath(relative(entry.path, fileURLToPath(uri)).split(sep).join('/'));
    } catch {
      throw refusal(
        'CAPABILITY_DENIED',
        'language server returned a location outside the working copy',
      );
    }
    await this.path(entry, path);
    const opened = entry.documents.get(path);
    if (opened) return opened;
    const text = await this.options.read(entry.path, path);
    return { path, uri, text, sha256: hash(text), languageId: '', version: 0 };
  }
  private async diagnostics(
    entry: Entry,
    uri: string,
    version: number | undefined,
    values: unknown[],
  ) {
    if (entry.stopped || entry.view.state !== 'running') return;
    const document = [...entry.documents.values()].find((document) => document.uri === uri);
    if (!document || (version !== undefined && version !== document.version)) return;
    const revision = entry.revision;
    const result = await lspResults(
      {
        kind: 'diagnostics',
        diagnostics: values.slice(0, 256) as never,
        durationMs: 0,
        truncated: false,
      },
      document,
      (uri) => this.readUri(entry, uri),
      entry.path,
    );
    if (entry.stopped || entry.revision !== revision || result.kind !== 'diagnostics') return;
    entry.view.diagnostics = entry.view.diagnostics.filter((d) => d.path !== document.path);
    entry.view.diagnostics.push({
      path: document.path,
      documentVersion: version ?? null,
      diagnostics: result.diagnostics,
    });
  }
  async query(
    sessionId: string,
    raw: LanguageQuery,
    cancellation?: ToolCancellation,
  ): Promise<LanguageQueryResult> {
    const input = LanguageQuery.parse(raw),
      entry = await this.active(sessionId, input),
      path = this.options.safePath(input.path),
      document = entry.documents.get(path);
    if (!document || document.version !== input.version)
      throw refusal('REVISION_CONFLICT', 'synchronize the current document before querying');
    if (input.operation !== 'diagnostics') validateLspPosition(input.position, document.text);
    const revision = entry.revision;
    const value = await entry.connection?.query(
      input.operation,
      document.uri,
      input.position,
      cancellation,
    );
    let result: LanguageQueryResult['result'];
    if (input.operation === 'completion')
      result = {
        kind: 'completion',
        items: this.completions(value, document, entry.path, input.position),
      };
    else if (input.operation === 'diagnostics') {
      const raw = value as { kind?: string; items?: unknown[] };
      if (raw?.kind !== 'full' || !Array.isArray(raw.items))
        throw refusal(
          'SCHEMA_INVALID',
          'language server returned diagnostics without a current document result',
        );
      const normalized = await lspResults(
        {
          kind: 'diagnostics',
          diagnostics: raw.items.slice(0, 256) as never,
          durationMs: 0,
          truncated: false,
        },
        document,
        (uri) => this.readUri(entry, uri),
        entry.path,
      );
      if (normalized.kind !== 'diagnostics')
        throw refusal('SCHEMA_INVALID', 'invalid diagnostic result');
      result = normalized;
    } else {
      const locations = value === null ? [] : Array.isArray(value) ? value : [value];
      const normalized = await lspResults(
        {
          kind: 'locations',
          locations: locations.slice(0, 256) as never,
          durationMs: 0,
          truncated: false,
        },
        document,
        (uri) => this.readUri(entry, uri),
        entry.path,
      );
      if (normalized.kind !== 'locations')
        throw refusal('SCHEMA_INVALID', 'invalid location result');
      result = {
        kind: 'locations',
        locations: normalized.locations.map((location) => ({
          ...location,
          documentVersion: entry.documents.get(location.path)?.version ?? null,
        })),
      };
    }
    await this.active(sessionId, input);
    if (cancellation?.aborted) throw refusal('TARGET_TERMINAL', 'language query cancelled');
    if (revision !== entry.revision)
      throw refusal('REVISION_CONFLICT', 'language documents changed while the query was running');
    if (result.kind === 'diagnostics') {
      entry.view.diagnostics = entry.view.diagnostics.filter((d) => d.path !== path);
      entry.view.diagnostics.push({
        path,
        documentVersion: document.version,
        diagnostics: result.diagnostics,
      });
    }
    return LanguageQueryResult.parse({
      generation: entry.view.generation,
      documentVersion: document.version,
      result,
    });
  }
  private completions(
    raw: unknown,
    document: Document,
    root: string,
    position: LanguageQuery['position'],
  ) {
    const items = Array.isArray(raw) ? raw : (raw as { items?: unknown[] } | null)?.items;
    if (!Array.isArray(items)) return [];
    const result = [];
    for (const item of items.slice(0, 200)) {
      if (!item || typeof item !== 'object') continue;
      const value = item as Record<string, unknown>;
      if (
        value.command ||
        value.insertTextFormat === 2 ||
        (value.additionalTextEdits !== undefined &&
          (!Array.isArray(value.additionalTextEdits) || value.additionalTextEdits.length > 0))
      )
        continue;
      const edit = value.textEdit as { range?: unknown; newText?: unknown } | undefined;
      if (edit && !edit.range) continue;
      const parsed = LanguageCompletion.safeParse({
        label: typeof value.label === 'string' ? redactToolText(value.label, [root]) : value.label,
        insertText: edit?.newText ?? value.insertText ?? value.label,
        ...(value.kind ? { kind: value.kind } : {}),
        ...(typeof value.detail === 'string'
          ? { detail: redactToolText(value.detail, [root]).slice(0, 2000) }
          : {}),
        ...(typeof value.sortText === 'string' ? { sortText: value.sortText.slice(0, 500) } : {}),
        ...(typeof value.filterText === 'string'
          ? { filterText: value.filterText.slice(0, 500) }
          : {}),
        ...(edit ? { range: edit.range } : {}),
      });
      if (!parsed.success) continue;
      if (parsed.data.range) {
        const range = LspRange.parse(parsed.data.range);
        if (
          !position ||
          range.start.line !== position.line ||
          range.end.line !== position.line ||
          range.start.character > position.character ||
          range.end.character < position.character
        )
          continue;
        try {
          validateLspPosition(range.start, document.text);
          validateLspPosition(range.end, document.text);
        } catch {
          continue;
        }
      }
      result.push(parsed.data);
    }
    return result;
  }
  private close(entry: Entry): Promise<void> {
    if (entry.cleaned) return Promise.resolve();
    if (entry.closing) return entry.closing;
    entry.stopped = true;
    entry.closing = (async () => {
      await entry.starting?.catch(() => {});
      try {
        if (entry.connection) await entry.connection.close();
        else if (
          (entry.restored || entry.view.state === 'uncertain') &&
          (!entry.identity || !(await cleanupPtySession(entry.identity, this.options.timers)))
        )
          throw new ToolTerminationUnconfirmed();
        entry.cleaned = true;
        entry.restored?.releaseConfirmed();
        entry.restored = undefined;
        this.options.operations.reconcile(
          entry.view.generation,
          ['language'],
          'cancelled',
          this.stored(entry),
        );
      } catch (error) {
        entry.view.state = 'uncertain';
        entry.view.error = 'Language server cleanup is unconfirmed.';
        this.options.operations.finish(entry.view.generation, 'uncertain', this.stored(entry));
        throw error;
      }
    })().finally(() => {
      entry.closing = undefined;
    });
    return entry.closing;
  }
  async stop(sessionId: string, raw: LanguageScope): Promise<{ stopped: true }> {
    const input = LanguageScope.parse(raw);
    this.options.context(sessionId, input.target);
    const entry = this.entries.get(sessionId);
    if (!entry) {
      const prior = this.options.operations.get(input.generation);
      if (
        prior?.kind === 'language' &&
        canonicalJson(prior.target) === canonicalJson(input.target) &&
        !['running', 'uncertain'].includes(prior.state)
      )
        return { stopped: true };
      throw refusal('TARGET_NOT_FOUND', 'language session is unavailable');
    }
    if (
      entry.view.generation !== input.generation ||
      canonicalJson(entry.target) !== canonicalJson(input.target)
    )
      throw refusal('REVISION_CONFLICT', 'language session generation changed');
    await this.close(entry);
    this.entries.delete(sessionId);
    return { stopped: true };
  }
  async stopCopy(sessionId: string) {
    const entry = this.entries.get(sessionId);
    if (entry) {
      await this.close(entry);
      this.entries.delete(sessionId);
    }
  }
  async dispose() {
    const results = await Promise.allSettled(
      [...this.entries.values()].map((entry) => this.close(entry)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    this.entries.clear();
  }
  hasPending() {
    return [...this.entries.values()].some(
      (entry) => !entry.stopped || entry.closing || entry.view.state === 'uncertain',
    );
  }
}
