import type { ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { Clock, Scheduler } from '@corral/contracts';
import { type ToolCancellation, ToolRefusal, ToolTerminationUnconfirmed } from '@corral/core';
import {
  ApplyWorkspaceEditRequest,
  type CancellationToken,
  CancellationTokenSource,
  CompletionRequest,
  createProtocolConnection,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticRequest,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  type Position,
  type ProtocolConnection,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  ShutdownRequest,
  type TextDocumentItem,
  TextDocumentSyncKind,
} from 'vscode-languageserver-protocol/node';
import {
  confirmOwnedProcessCleanup,
  HostProcessCapacityError,
  spawnOwnedProcess,
} from '../processes/owned-process.ts';
import {
  capturePtySession,
  cleanupPtySession,
  type PtySessionIdentity,
} from '../processes/pty-session.ts';
import { killProcessGroup, processGroupGone } from './process-group.ts';

const failure = (message: string) => new ToolRefusal('CAPABILITY_DENIED', message);

/** Validate framing before jsonrpc buffers a body; the budget resets for every message. */
export class BoundedLspFrames extends Transform {
  private readonly header = Buffer.alloc(8192);
  private headerLength = 0;
  private remaining = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining) {
          const length = Math.min(this.remaining, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + length));
          offset += length;
          this.remaining -= length;
          continue;
        }
        if (this.headerLength === this.header.length)
          throw failure('language server header limit exceeded');
        this.header[this.headerLength++] = chunk[offset++] as number;
        if (this.headerLength < 4 || this.header.readUInt32BE(this.headerLength - 4) !== 0x0d0a0d0a)
          continue;
        const lengths = this.header
          .subarray(0, this.headerLength)
          .toString('ascii')
          .split('\r\n')
          .filter((line) => /^content-length:/i.test(line));
        if (
          lengths.length !== 1 ||
          !/^content-length:[ \t]*[1-9]\d*[ \t]*$/i.test(lengths[0] ?? '')
        )
          throw failure('language server framing is invalid');
        const length = Number(lengths[0]?.split(':')[1]?.trim());
        if (!Number.isSafeInteger(length) || length > 8 * 1024 * 1024)
          throw failure('language server message limit exceeded');
        this.push(Buffer.from(this.header.subarray(0, this.headerLength)));
        this.headerLength = 0;
        this.remaining = length;
      }
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  override _flush(done: TransformCallback) {
    done(
      this.headerLength || this.remaining
        ? failure('language server frame is incomplete')
        : undefined,
    );
  }
}

export interface LanguageCapabilities {
  completion: boolean;
  definition: boolean;
  references: boolean;
  diagnostics: boolean;
  diagnosticPull: boolean;
  triggerCharacters: string[];
}
interface LanguageConnectionOptions {
  cwd: string;
  argv: string[];
  timeoutMs: number;
  owner: string;
  clock: Clock;
  timers: Scheduler;
  onDiagnostics(uri: string, version: number | undefined, diagnostics: unknown[]): void;
  onFailure(error: Error): void;
  onSpawn(identity: PtySessionIdentity): void;
  spawn?: (...args: Parameters<typeof spawn>) => ChildProcess;
}

/** Persistent transport only. The broker owns target, launch trust and result validation. */
export class LanguageConnection {
  readonly capabilities: LanguageCapabilities = {
    completion: false,
    definition: false,
    references: false,
    diagnostics: true,
    diagnosticPull: false,
    triggerCharacters: [],
  };
  private readonly options: LanguageConnectionOptions;
  private readonly home: string;
  private readonly frames = new BoundedLspFrames();
  private readonly documents = new Map<string, TextDocumentItem>();
  private readonly pending = new Set<(error: Error) => void>();
  private child: ChildProcess | undefined;
  private identity: PtySessionIdentity | undefined;
  private signalled = false;
  private connection: ProtocolConnection | undefined;
  private exited: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private stopping = false;
  private failed: Error | undefined;
  private initialized = false;
  private syncKind: TextDocumentSyncKind = TextDocumentSyncKind.None;
  private syncQueue: Promise<void> = Promise.resolve();

  private constructor(options: LanguageConnectionOptions, home: string) {
    this.options = options;
    this.home = home;
  }

  static async start(options: LanguageConnectionOptions): Promise<LanguageConnection> {
    if (process.platform !== 'linux')
      throw failure('persistent language server process ownership is unavailable on this host');
    if (
      !options.owner ||
      !options.argv.length ||
      options.argv.some((arg) => !arg || arg.includes('\0')) ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 1800000
    )
      throw failure('language server launch is invalid');
    const instance = new LanguageConnection(
      options,
      await mkdtemp(join(tmpdir(), 'corral-language-home-')),
    );
    try {
      await instance.initialize();
      return instance;
    } catch (error) {
      const reason =
        error instanceof ToolRefusal ? error : failure('language server could not start');
      instance.fail(reason);
      await instance.close();
      throw reason;
    }
  }

  private assertOpen() {
    if (this.failed) throw this.failed;
    if (this.stopping) throw failure('language server is closed');
  }

  private fail(error: Error) {
    if (this.failed || this.stopping) return;
    this.failed = error;
    for (const reject of this.pending) reject(error);
    try {
      this.options.onFailure(error);
    } catch {}
    void this.close().catch(() => {});
  }

  private async request<T>(
    send: (token: CancellationToken) => Promise<T>,
    cancellation?: ToolCancellation,
  ): Promise<T> {
    this.assertOpen();
    if (cancellation?.aborted) throw failure('language server query cancelled');
    const token = new CancellationTokenSource();
    let interrupt!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = (error) => {
        token.cancel();
        reject(error);
      };
    });
    void interrupted.catch(() => {});
    this.pending.add(interrupt);
    const cancelDeadline = this.options.timers.after(this.options.timeoutMs, () =>
      interrupt(failure('language server query timeout')),
    );
    const off = cancellation?.onCancel(() => interrupt(failure('language server query cancelled')));
    try {
      if (cancellation?.aborted) interrupt(failure('language server query cancelled'));
      return await Promise.race([send(token.token), interrupted]);
    } catch (error) {
      throw error instanceof ToolRefusal ? error : failure('language server query failed');
    } finally {
      cancelDeadline();
      off?.();
      this.pending.delete(interrupt);
      token.dispose();
    }
  }

  private async initialize() {
    const spawnProcess = this.options.spawn ?? (spawnOwnedProcess as typeof spawn);
    try {
      this.child = spawnProcess(this.options.argv[0] as string, this.options.argv.slice(1), {
        cwd: this.options.cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: this.home,
          XDG_CONFIG_HOME: this.home,
          LANG: 'C.UTF-8',
          GIT_TERMINAL_PROMPT: '0',
          NPM_CONFIG_USERCONFIG: join(this.home, 'npmrc'),
          NPM_CONFIG_GLOBALCONFIG: join(this.home, 'global-npmrc'),
          CORRAL_PROCESS_OWNER: this.options.owner,
        },
      });
    } catch (error) {
      throw failure(
        error instanceof HostProcessCapacityError
          ? error.message
          : 'language server could not start',
      );
    }
    const child = this.child;
    this.exited = new Promise((resolve) =>
      child.once('close', () => {
        this.fail(failure('language server closed'));
        resolve();
      }),
    );
    child.once('error', () => this.fail(failure('language server could not start')));
    child.once('exit', () => this.fail(failure('language server closed')));
    child.stderr?.on('data', () => {});
    child.stdin?.on('error', () => this.fail(failure('language server input closed')));
    if (!child.pid) throw failure('language server process identity is unavailable');
    this.identity = capturePtySession(child.pid, this.options.owner);
    this.options.onSpawn(this.identity);
    if (!child.stdout || !child.stdin) throw failure('language server pipes unavailable');
    this.frames.on('error', () =>
      this.fail(failure('language server framing limit or protocol error')),
    );
    child.stdout.pipe(this.frames);
    const connection = createProtocolConnection(this.frames, child.stdin, {
      error() {},
      warn() {},
      info() {},
      log() {},
    });
    this.connection = connection;
    connection.onError(() => this.fail(failure('language server protocol error')));
    connection.onClose(() => this.fail(failure('language server connection closed')));
    connection.onRequest(ApplyWorkspaceEditRequest.type, () => ({
      applied: false,
      failureReason: 'Corral requires a separately approved change proposal',
    }));
    connection.onRequest('workspace/configuration', (params: { items: unknown[] }) => {
      if (!Array.isArray(params?.items) || params.items.length > 100)
        throw failure('language server configuration limit');
      return params.items.map(() => null);
    });
    const folders = [{ name: 'workspace', uri: pathToFileURL(this.options.cwd).href }];
    connection.onRequest('workspace/workspaceFolders', () => folders);
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onRequest('window/showMessageRequest', () => null);
    connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      if (this.failed || this.stopping) return;
      if (
        typeof params?.uri !== 'string' ||
        !Array.isArray(params.diagnostics) ||
        (params.version !== undefined && (!Number.isInteger(params.version) || params.version < 0))
      ) {
        this.fail(failure('invalid language server diagnostics'));
        return;
      }
      try {
        this.options.onDiagnostics(params.uri, params.version, params.diagnostics);
      } catch {
        this.fail(failure('invalid language server diagnostics'));
      }
    });
    connection.listen();
    const result = await this.request((token) =>
      connection.sendRequest(
        InitializeRequest.type,
        {
          processId: process.pid,
          rootUri: pathToFileURL(this.options.cwd).href,
          workspaceFolders: folders,
          clientInfo: { name: 'Corral' },
          capabilities: {
            general: { positionEncodings: ['utf-16'] },
            workspace: { applyEdit: false },
            textDocument: {
              synchronization: { dynamicRegistration: false },
              publishDiagnostics: { versionSupport: true },
              completion: { dynamicRegistration: false, completionItem: { snippetSupport: false } },
              definition: { linkSupport: true },
              references: { dynamicRegistration: false },
              diagnostic: { dynamicRegistration: false },
            },
          },
        },
        token,
      ),
    );
    if (result.capabilities.positionEncoding && result.capabilities.positionEncoding !== 'utf-16')
      throw failure('language server must negotiate UTF-16 positions');
    const sync = result.capabilities.textDocumentSync;
    this.syncKind = typeof sync === 'number' ? sync : (sync?.change ?? TextDocumentSyncKind.None);
    if (
      ![TextDocumentSyncKind.Full, TextDocumentSyncKind.Incremental].includes(this.syncKind) ||
      (typeof sync === 'object' && !sync.openClose)
    )
      throw failure('language server must support open documents and changes');
    Object.assign(this.capabilities, {
      completion: Boolean(result.capabilities.completionProvider),
      definition: Boolean(result.capabilities.definitionProvider),
      references: Boolean(result.capabilities.referencesProvider),
      diagnosticPull: Boolean(result.capabilities.diagnosticProvider),
      triggerCharacters: (result.capabilities.completionProvider?.triggerCharacters ?? [])
        .filter((value) => typeof value === 'string' && value.length <= 8)
        .slice(0, 32),
    });
    await this.request(() => connection.sendNotification(InitializedNotification.type, {}));
    this.initialized = true;
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.syncQueue.then(action);
    this.syncQueue = result.catch(() => {});
    return result;
  }

  sync(document: TextDocumentItem): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (
        !Number.isInteger(document.version) ||
        document.version < 1 ||
        Buffer.byteLength(document.text) > 1024 * 1024
      )
        throw failure('language server document exceeds limits');
      const previous = this.documents.get(document.uri);
      if (
        previous?.version === document.version &&
        previous.text === document.text &&
        previous.languageId === document.languageId
      )
        return;
      if (
        previous &&
        (document.version <= previous.version || document.languageId !== previous.languageId)
      )
        throw failure('language server document version changed');
      const connection = this.connection as ProtocolConnection;
      if (previous) {
        const lines = previous.text.split(/\r\n|\r|\n/);
        const range = {
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 },
        };
        await this.request(() =>
          connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri: document.uri, version: document.version },
            contentChanges: [
              this.syncKind === TextDocumentSyncKind.Incremental
                ? { range, text: document.text }
                : { text: document.text },
            ],
          }),
        );
      } else
        await this.request(() =>
          connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: document,
          }),
        );
      this.documents.set(document.uri, { ...document });
    });
  }

  closeDocument(uri: string): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (!this.documents.has(uri)) return;
      await this.request(() =>
        (this.connection as ProtocolConnection).sendNotification(
          DidCloseTextDocumentNotification.type,
          { textDocument: { uri } },
        ),
      );
      this.documents.delete(uri);
    });
  }

  async query(
    operation: 'completion' | 'definition' | 'references' | 'diagnostics',
    uri: string,
    position?: Position,
    cancellation?: ToolCancellation,
  ): Promise<unknown> {
    await this.syncQueue;
    this.assertOpen();
    if (!this.documents.has(uri)) throw failure('language server document is not open');
    const supported =
      operation === 'diagnostics' ? this.capabilities.diagnosticPull : this.capabilities[operation];
    if (!supported) throw failure('language server does not support this query');
    const connection = this.connection as ProtocolConnection;
    if (operation === 'diagnostics')
      return this.request(
        (token) =>
          connection.sendRequest(DocumentDiagnosticRequest.type, { textDocument: { uri } }, token),
        cancellation,
      );
    if (!position) throw failure('language server position is required');
    const params = { textDocument: { uri }, position };
    if (operation === 'completion')
      return this.request(
        (token) => connection.sendRequest(CompletionRequest.type, params, token),
        cancellation,
      );
    if (operation === 'definition')
      return this.request(
        (token) => connection.sendRequest(DefinitionRequest.type, params, token),
        cancellation,
      );
    return this.request(
      (token) =>
        connection.sendRequest(
          ReferencesRequest.type,
          { ...params, context: { includeDeclaration: true } },
          token,
        ),
      cancellation,
    );
  }

  private deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    let cancel = () => {};
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        cancel = this.options.timers.after(ms, () =>
          reject(failure('language server termination timeout')),
        );
      }),
    ]).finally(() => cancel());
  }

  close(): Promise<void> {
    this.stopping = true;
    this.closing ??= this.cleanup().catch((error) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }

  private async cleanup() {
    for (const reject of this.pending) reject(failure('language server is closed'));
    if (this.connection && this.initialized && !this.failed) {
      await this.deadline(this.connection.sendRequest(ShutdownRequest.type), 300).catch(() => {});
      await this.deadline(this.connection.sendNotification(ExitNotification.type), 100).catch(
        () => {},
      );
    }
    if (this.child && !this.identity && !this.signalled) {
      this.signalled = true;
      killProcessGroup(this.child);
    }
    const gone = this.identity
      ? await cleanupPtySession(this.identity, this.options.timers)
      : !this.child?.pid || (await processGroupGone(this.child.pid, this.options.timers));
    this.connection?.dispose();
    this.frames.destroy();
    const closed = await this.deadline(this.exited, 8000).then(
      () => true,
      () => false,
    );
    if (!closed || !gone)
      throw new ToolTerminationUnconfirmed('language server termination unconfirmed');
    if (this.child?.pid) confirmOwnedProcessCleanup(this.child.pid);
    this.documents.clear();
    await rm(this.home, { recursive: true, force: true }).catch(() => {
      throw failure('language server configuration cleanup failed');
    });
  }
}
