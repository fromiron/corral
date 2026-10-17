import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { Clock, Scheduler } from '@corral/contracts';
import { type ToolCancellation, ToolRefusal, ToolTerminationUnconfirmed } from '@corral/core';
import {
  ApplyWorkspaceEditRequest,
  CancellationTokenSource,
  createProtocolConnection,
  DefinitionRequest,
  type Diagnostic,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticRequest,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  type Location,
  type LocationLink,
  type Position,
  type ProtocolConnection,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  ShutdownRequest,
} from 'vscode-languageserver-protocol/node';
import { killProcessGroup, processGroupGone } from './process-group.ts';

class LspFailure extends ToolRefusal {
  constructor(message: string) {
    super('CAPABILITY_DENIED', message);
  }
}

interface LspInput {
  cwd: string;
  argv: string[];
  timeoutMs: number;
  document: { uri: string; text: string; languageId: string; version: number };
  operation: 'definition' | 'references' | 'diagnostics';
  position?: Position;
}
type LspBody =
  | { kind: 'locations'; locations: (Location | LocationLink)[] }
  | { kind: 'diagnostics'; diagnostics: Diagnostic[] };
export type LspResponse = LspBody & { durationMs: number; truncated: boolean };

/** Transport only: the owning workspace broker supplies/validates documents and URI scope. */
export class LspRunner {
  private readonly clock: Clock;
  private readonly timers: Scheduler;
  private readonly spawn: (...args: Parameters<typeof spawn>) => ChildProcess;
  constructor(options: {
    clock: Clock;
    timers: Scheduler;
    spawn?: (...args: Parameters<typeof spawn>) => ChildProcess;
  }) {
    this.clock = options.clock;
    this.timers = options.timers;
    this.spawn = options.spawn ?? spawn;
  }

  private deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    let cancel = () => {};
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        cancel = this.timers.after(ms, () =>
          reject(new LspFailure('language server termination timeout')),
        );
      }),
    ]).finally(() => cancel());
  }

  async query(input: LspInput, cancellation: ToolCancellation): Promise<LspResponse> {
    if (cancellation.aborted) throw new LspFailure('language server query cancelled');
    if (
      !input.argv.length ||
      input.argv.some((arg) => arg.includes('\0')) ||
      input.document.version < 1 ||
      Buffer.byteLength(input.document.text) > 1024 * 1024 ||
      !Number.isInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 1800000
    )
      throw new LspFailure('language server input exceeds limits');
    if (input.operation !== 'diagnostics' && !input.position)
      throw new LspFailure('language server position is required');
    const home = await mkdtemp(join(tmpdir(), 'corral-lsp-home-'));
    const started = this.clock.monotonicMs();
    let child: ChildProcess | undefined, connection: ProtocolConnection | undefined;
    let closed: Promise<void> = Promise.resolve(),
      cancelDeadline = () => {},
      off = () => {};
    let finishing = false,
      opened = false,
      stopped = false;
    const token = new CancellationTokenSource();
    let rejectStop!: (error: Error) => void;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectStop = reject;
    });
    void interruption.catch(() => {});
    const stop = (message: string) => {
      if (stopped || finishing) return;
      stopped = true;
      rejectStop(new LspFailure(message));
      token.cancel();
      if (child) killProcessGroup(child);
    };
    let total = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        total += chunk.length;
        if (total > 8 * 1024 * 1024) {
          stop('language server response limit exceeded');
          done(new LspFailure('language server response limit exceeded'));
        } else done(null, chunk);
      },
    });
    bounded.on('error', () => stop('language server response limit exceeded'));
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, interruption]);
    let response: LspBody | undefined;
    let failure: Error | undefined;
    let truncated = false;
    try {
      if (cancellation.aborted) throw new LspFailure('language server query cancelled');
      child = this.spawn(input.argv[0] as string, input.argv.slice(1), {
        cwd: input.cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          XDG_CONFIG_HOME: home,
          LANG: 'C.UTF-8',
          GIT_TERMINAL_PROMPT: '0',
          NPM_CONFIG_USERCONFIG: join(home, 'npmrc'),
          NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc'),
        },
      });
      closed = new Promise((resolve) =>
        child?.once('close', () => {
          if (!finishing) stop('language server closed before the query completed');
          resolve();
        }),
      );
      child.once('error', () => stop('language server could not start'));
      child.once('exit', () => {
        if (child) killProcessGroup(child);
      });
      child.stderr?.on('data', () => {});
      if (!child.stdout || !child.stdin) throw new LspFailure('language server pipes unavailable');
      child.stdout.pipe(bounded);
      connection = createProtocolConnection(bounded, child.stdin, {
        error: () => {},
        warn: () => {},
        info: () => {},
        log: () => {},
      });
      connection.onError(() => stop('language server protocol error'));
      connection.onClose(() => {
        if (!finishing) stop('language server connection closed');
      });
      connection.onRequest(ApplyWorkspaceEditRequest.type, () => ({
        applied: false,
        failureReason: 'Corral requires a separately approved change proposal',
      }));
      connection.onRequest('workspace/configuration', (params: { items: unknown[] }) => {
        if (!Array.isArray(params.items) || params.items.length > 100)
          throw new LspFailure('configuration request limit');
        return params.items.map(() => null);
      });
      connection.onRequest('workspace/workspaceFolders', () => [
        { name: 'workspace', uri: pathToFileURL(input.cwd).href },
      ]);
      connection.onRequest('window/workDoneProgress/create', () => null);
      connection.onRequest('window/showMessageRequest', () => null);
      let publish!: (diagnostics: Diagnostic[]) => void;
      const diagnostics = new Promise<Diagnostic[]>((resolve) => {
        publish = resolve;
      });
      connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
        if (!opened || params.uri !== input.document.uri) return;
        if (params.version !== undefined && params.version !== input.document.version) {
          stop('diagnostic document version changed');
          return;
        }
        if (!Array.isArray(params.diagnostics)) {
          stop('invalid language server diagnostics');
          return;
        }
        publish(params.diagnostics);
      });
      connection.listen();
      off = cancellation.onCancel(() => stop('language server query cancelled'));
      cancelDeadline = this.timers.after(input.timeoutMs, () =>
        stop(
          input.operation === 'diagnostics'
            ? 'language server diagnostic timeout; no diagnostic result was established'
            : 'language server query timeout',
        ),
      );
      if (cancellation.aborted) stop('language server query cancelled');
      const initialized = await wait(
        connection.sendRequest(
          InitializeRequest.type,
          {
            processId: process.pid,
            rootUri: pathToFileURL(input.cwd).href,
            clientInfo: { name: 'Corral' },
            capabilities: {
              general: { positionEncodings: ['utf-16'] },
              workspace: { applyEdit: false },
              textDocument: {
                publishDiagnostics: { versionSupport: true },
                definition: { linkSupport: true },
                diagnostic: { dynamicRegistration: false },
              },
            },
            workspaceFolders: [{ uri: pathToFileURL(input.cwd).href, name: 'workspace' }],
          },
          token.token,
        ),
      );
      if (
        initialized.capabilities.positionEncoding &&
        initialized.capabilities.positionEncoding !== 'utf-16'
      )
        throw new LspFailure('language server must negotiate UTF-16 positions');
      await wait(connection.sendNotification(InitializedNotification.type, {}));
      opened = true;
      await wait(
        connection.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: input.document,
        }),
      );
      if (input.operation === 'diagnostics') {
        let items: Diagnostic[];
        if (initialized.capabilities.diagnosticProvider) {
          const result = await wait(
            connection.sendRequest(
              DocumentDiagnosticRequest.type,
              { textDocument: { uri: input.document.uri } },
              token.token,
            ),
          );
          if (result.kind !== 'full')
            throw new LspFailure(
              'language server returned unchanged diagnostics without a baseline',
            );
          items = result.items;
        } else items = await wait(diagnostics);
        if (!Array.isArray(items)) throw new LspFailure('invalid language server diagnostics');
        truncated = items.length > 256;
        response = { kind: 'diagnostics', diagnostics: items.slice(0, 256) };
      } else {
        const params = {
          textDocument: { uri: input.document.uri },
          position: input.position as Position,
        };
        if (
          (input.operation === 'definition' && !initialized.capabilities.definitionProvider) ||
          (input.operation === 'references' && !initialized.capabilities.referencesProvider)
        )
          throw new LspFailure('language server does not support this query');
        const result =
          input.operation === 'definition'
            ? await wait(connection.sendRequest(DefinitionRequest.type, params, token.token))
            : await wait(
                connection.sendRequest(
                  ReferencesRequest.type,
                  { ...params, context: { includeDeclaration: true } },
                  token.token,
                ),
              );
        const items = result === null ? [] : Array.isArray(result) ? result : [result];
        truncated = items.length > 256;
        response = { kind: 'locations', locations: items.slice(0, 256) };
      }
    } catch (error) {
      failure =
        error instanceof LspFailure ? error : new LspFailure('language server query failed');
    } finally {
      finishing = true;
      cancelDeadline();
      off();
      if (connection && !stopped) {
        await this.deadline(connection.sendRequest(ShutdownRequest.type), 300).catch(() => {});
        await this.deadline(connection.sendNotification(ExitNotification.type), 100).catch(
          () => {},
        );
      }
      if (child) killProcessGroup(child);
      connection?.dispose();
      token.dispose();
      bounded.destroy();
      const processClosed = await this.deadline(closed, 3000).then(
        () => true,
        () => false,
      );
      const groupClosed = !child?.pid || (await processGroupGone(child.pid, this.timers));
      if (processClosed && groupClosed)
        await rm(home, { recursive: true, force: true }).catch(() => {
          failure = new LspFailure('language server configuration cleanup failed');
        });
      else failure = new ToolTerminationUnconfirmed('language server termination unconfirmed');
    }
    if (failure) throw failure;
    if (cancellation.aborted) throw new LspFailure('language server query cancelled');
    if (!response) throw new LspFailure('language server returned no response');
    return {
      ...response,
      durationMs: Math.max(0, Math.round(this.clock.monotonicMs() - started)),
      truncated,
    };
  }
}
