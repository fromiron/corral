import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  type HostProcessReservation,
  restoreHostProcessGroupReservation,
} from '@corral/adapter-pi/processes';
import {
  type Clock,
  canonicalJson,
  DebugBreakpoints,
  DebugCommand,
  type DebugCommandResult,
  DebugInspect,
  type DebugInspection,
  DebugQuery,
  type DebugQueryResult,
  type DebugScope,
  type DebugSession,
  type DebugSource,
  DebugStart,
  type DebugState,
  type RegisteredDebugAdapter,
  type RegisteredDebugConfiguration,
  type Scheduler,
  type WorkspaceTarget,
} from '@corral/contracts';
import { type ToolCancellation, ToolRefusal, ToolTerminationUnconfirmed } from '@corral/core';
import type { SqliteProjectToolStore } from '@corral/storage-sqlite';
import type { ConnectionAttestation } from '../preview/proxy.ts';
import { confirmOwnedProcessCleanup } from '../processes/owned-process.ts';
import { cleanupPtySession, type PtySessionIdentity } from '../processes/pty-session.ts';
import { CheckOutput, redactToolText } from './check-output.ts';
import { DebugConnection } from './debug-connection.ts';
import { debugLaunch, debugSourceMapLocations } from './debug-launch.ts';
import {
  DebugProcessStartError,
  InspectorBridge,
  launchChromium,
  launchNode,
  type OwnedDebuggee,
} from './debug-processes.ts';
import type { WorkbenchOperations } from './workbench-operations.ts';

type Connection = Pick<DebugConnection, 'sessions' | 'attach' | 'request' | 'close'>;
export interface DebugTransport {
  start(input: Parameters<typeof DebugConnection.start>[0]): Promise<Connection>;
}
export interface DebugOptions {
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
  sources(root: string): Promise<{ hashes: Record<string, string>; complete: boolean }>;
  task(sessionId: string, operationId: string, target: WorkspaceTarget): boolean;
  attest: (
    sessionId: string,
    operationId: string,
    port: number,
    peerPort: number,
  ) => Promise<boolean>;
  preview?(
    sessionId: string,
    leaseId: string,
    target: WorkspaceTarget,
    open: boolean,
  ): Promise<{ url: string; prepare?: (endpoint: string) => Promise<() => Promise<void>> }>;
  transport?: DebugTransport;
  bridge?: Pick<typeof InspectorBridge, 'start'>;
}
type SavedCommand = { hash: string; result: DebugCommandResult };
type Stored = {
  kind: 'debug';
  view: DebugSession;
  configuration: RegisteredDebugConfiguration;
  adapter: RegisteredDebugAdapter;
  identities: PtySessionIdentity[];
  profiles: string[];
  commands: Record<string, SavedCommand>;
  input: DebugInspect;
};
type Entry = Stored & {
  target: WorkspaceTarget;
  root: string;
  sources: Record<string, string>;
  sourcesComplete?: boolean;
  connection?: Connection;
  debuggee?: OwnedDebuggee;
  bridge?: InspectorBridge;
  previewClose?: () => Promise<void>;
  restored: HostProcessReservation[];
  starting?: Promise<void>;
  closing?: Promise<void>;
  cleaned: boolean;
  secrets: string[];
  output?: CheckOutput;
  busy?: string;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const refusal = (code: ConstructorParameters<typeof ToolRefusal>[0], message: string) =>
  new ToolRefusal(code, message);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const objects = (value: unknown) => (Array.isArray(value) ? value.slice(0, 200).map(record) : []);
const number = (value: unknown, fallback = 1) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 4000) : '');

/** Debugging is an explicit human execution owner, with a durable receipt for every command. */
export class DebugSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly options: DebugOptions;
  constructor(options: DebugOptions) {
    this.options = options;
    for (const receipt of options.operations.list('debug')) {
      if (receipt.state !== 'uncertain') continue;
      const stored = receipt.result as Stored | null;
      if (stored?.kind !== 'debug') continue;
      for (const command of Object.values(stored.commands))
        if (command.result.state === 'running') {
          command.result.state = 'uncertain';
          command.result.error = 'The host restarted before this command was confirmed.';
        }
      this.entries.set(receipt.target.sessionId, {
        ...stored,
        view: {
          ...stored.view,
          state: 'uncertain',
          output: '',
          error: 'The host restarted. Explicitly stop this debugger before starting another.',
        },
        target: receipt.target,
        root: '',
        sources: {},
        restored: stored.identities.map(() => restoreHostProcessGroupReservation()),
        cleaned: false,
        secrets: [],
      });
    }
  }
  private stored(entry: Entry): Stored {
    return {
      kind: 'debug',
      view: entry.view,
      configuration: entry.configuration,
      adapter: entry.adapter,
      identities: entry.identities,
      profiles: entry.profiles,
      commands: entry.commands,
      input: entry.input,
    };
  }
  private persist(entry: Entry) {
    return this.options.operations.updateRunning(entry.view.generation, this.stored(entry));
  }
  private cleanText(entry: Entry, input: unknown) {
    let value = typeof input === 'string' ? input : '';
    for (const secret of entry.secrets.flatMap((value) => value.split(/\r?\n/)))
      if (secret) value = value.replaceAll(secret, '[redacted]');
    return redactToolText(value, [entry.root]).slice(0, 4000);
  }
  private current(sessionId: string, expected?: WorkspaceTarget) {
    const context = this.options.context(sessionId, expected);
    if (context.closing) throw refusal('TARGET_TERMINAL', 'the working copy is closing');
    if (!context.trusted)
      throw refusal('CAPABILITY_DENIED', 'trust the repository before debugging');
    return context;
  }
  private matching(sessionId: string, scope: DebugScope) {
    this.options.context(sessionId, scope.target);
    const entry = this.entries.get(sessionId);
    if (
      !entry ||
      entry.view.generation !== scope.generation ||
      canonicalJson(entry.target) !== canonicalJson(scope.target)
    )
      throw refusal('REVISION_CONFLICT', 'debugger target or generation changed');
    return entry;
  }
  private active(entry: Entry) {
    this.compatible(entry);
    if (!entry.connection || !['running', 'paused'].includes(entry.view.state))
      throw refusal('TARGET_TERMINAL', 'debugger is not active');
  }
  private compatible(entry: Entry) {
    this.current(entry.target.sessionId, entry.target);
    if (
      this.options.tools.latest(entry.target.projectId)?.revision !== entry.view.configRevision ||
      !this.options.tools.trust({
        projectId: entry.target.projectId,
        kind: 'debug',
        id: entry.configuration.id,
        fingerprint: entry.view.fingerprint,
      })
    )
      throw refusal('REVISION_CONFLICT', 'debugger configuration or trust changed');
    if (entry.closing || entry.cleaned) throw refusal('TARGET_TERMINAL', 'debugger is closing');
  }
  async state(sessionId: string): Promise<DebugState> {
    const context = this.options.context(sessionId);
    return {
      target: context.target,
      available: process.platform === 'linux' && context.trusted,
      unavailableReason:
        process.platform !== 'linux' ? 'platform' : !context.trusted ? 'untrusted' : null,
      configurations:
        this.options.tools.latest(context.target.projectId)?.debugConfigurations ?? [],
      session: structuredClone(this.entries.get(sessionId)?.view ?? null),
    };
  }
  private async inspectInput(sessionId: string, input: DebugInspect) {
    const context = this.current(sessionId, input.target),
      config = this.options.tools.latest(input.target.projectId);
    const configuration = config?.debugConfigurations?.find((item) => item.id === input.configId),
      adapter = config?.debugAdapters?.find((item) => item.id === configuration?.adapterId);
    if (!configuration || !adapter || !config)
      throw refusal('TARGET_NOT_FOUND', 'debug configuration is unavailable');
    const cwd =
      configuration.cwd === '.'
        ? context.path
        : join(context.path, this.options.safePath(configuration.cwd));
    if (
      configuration.cwd !== '.' &&
      (await this.options.plainPath(context.path, this.options.safePath(configuration.cwd))) !==
        'other'
    )
      throw refusal('TARGET_NOT_FOUND', 'debug working directory is unavailable');
    for (const glob of configuration.outFiles ?? []) this.options.safePath(glob);
    if (configuration.request === 'attach') {
      if (
        !input.attach ||
        input.preview ||
        !this.options.task(sessionId, input.attach.operationId, input.target)
      )
        throw refusal('CAPABILITY_DENIED', 'attach requires a running task in this working copy');
    } else if (configuration.runtime === 'node') {
      if (input.attach || input.preview)
        throw refusal('SCHEMA_INVALID', 'Node launch does not accept an external target');
      const program = this.options.safePath(configuration.program);
      if (
        (await this.options.plainPath(
          context.path,
          this.options.safePath(relative(context.path, resolve(cwd, program))),
        )) !== 'file'
      )
        throw refusal('TARGET_NOT_FOUND', 'debug program is unavailable');
    } else {
      if (!input.preview || input.attach || !this.options.preview)
        throw refusal('CAPABILITY_DENIED', 'Chromium launch requires a managed preview');
      await this.options.preview(sessionId, input.preview.leaseId, input.target, false);
    }
    const launch = await debugLaunch(context.path, config.revision, adapter, configuration, input);
    this.current(sessionId, input.target);
    if (this.options.tools.latest(input.target.projectId)?.revision !== config.revision)
      throw refusal('REVISION_CONFLICT', 'debug configuration changed');
    return { context, config, configuration, adapter, launch, cwd };
  }
  async inspect(sessionId: string, raw: DebugInspect): Promise<DebugInspection> {
    const input = DebugInspect.parse(raw),
      inspected = await this.inspectInput(sessionId, input);
    return {
      target: input.target,
      configuration: inspected.configuration,
      adapter: inspected.adapter,
      configRevision: inspected.config.revision,
      fingerprint: inspected.launch.fingerprint,
      trusted: !!this.options.tools.trust({
        projectId: input.target.projectId,
        kind: 'debug',
        id: input.configId,
        fingerprint: inspected.launch.fingerprint,
      }),
    };
  }
  async start(sessionId: string, raw: DebugStart): Promise<DebugSession> {
    const input = DebugStart.parse(raw),
      context = this.current(sessionId, input.target),
      requestHash = digest(canonicalJson(input));
    if (process.platform !== 'linux')
      throw refusal(
        'CAPABILITY_DENIED',
        'debugger process cleanup is currently qualified on Linux only',
      );
    const prior = this.options.operations.get(input.requestId);
    if (prior) {
      if (
        prior.kind !== 'debug' ||
        prior.requestHash !== requestHash ||
        canonicalJson(prior.target) !== canonicalJson(input.target)
      )
        throw refusal('REVISION_CONFLICT', 'debug start request changed');
      const existing = this.entries.get(sessionId);
      if (existing?.view.generation === input.requestId) {
        await existing.starting;
        return structuredClone(existing.view);
      }
      return structuredClone((prior.result as Stored).view);
    }
    const existing = this.entries.get(sessionId);
    if (existing && !existing.cleaned)
      throw refusal('RUN_ALREADY_ACTIVE', 'stop the current debugger first');
    const inspected = await this.inspectInput(
      sessionId,
      DebugInspect.parse({
        target: input.target,
        configId: input.configId,
        ...(input.attach ? { attach: input.attach } : {}),
        ...(input.preview ? { preview: input.preview } : {}),
      }),
    );
    if (
      inspected.config.revision !== input.configRevision ||
      inspected.launch.fingerprint !== input.fingerprint
    )
      throw refusal('REVISION_CONFLICT', 'debug launch changed since inspection');
    const trust = {
      projectId: input.target.projectId,
      kind: 'debug' as const,
      id: input.configId,
      fingerprint: input.fingerprint,
    };
    if (input.trust) this.options.tools.setTrust(trust, true);
    if (!this.options.tools.trust(trust))
      throw refusal('CAPABILITY_DENIED', 'inspect and trust this debug configuration first');
    // Inspection awaited disk reads. Another request may have claimed this copy in the meantime.
    if (this.options.operations.get(input.requestId)) return this.start(sessionId, input);
    if (this.entries.get(sessionId) && !this.entries.get(sessionId)?.cleaned)
      throw refusal('RUN_ALREADY_ACTIVE', 'stop the current debugger first');
    const entry: Entry = {
      kind: 'debug',
      target: input.target,
      root: context.path,
      configuration: inspected.configuration,
      adapter: inspected.adapter,
      input: DebugInspect.parse({
        target: input.target,
        configId: input.configId,
        ...(input.attach ? { attach: input.attach } : {}),
        ...(input.preview ? { preview: input.preview } : {}),
      }),
      identities: [],
      profiles: [],
      commands: {},
      sources: {},
      restored: [],
      cleaned: false,
      secrets: Object.values(inspected.launch.environment),
      view: {
        generation: input.requestId,
        clientId: input.clientId,
        configId: input.configId,
        configRevision: input.configRevision,
        fingerprint: input.fingerprint,
        runtime: inspected.configuration.runtime,
        ownership: inspected.configuration.request === 'launch' ? 'launched' : 'attached',
        state: 'starting',
        revision: 0,
        pauseId: 0,
        pausedThreadId: null,
        canDisconnect: inspected.configuration.request === 'attach',
        canStop: inspected.configuration.request === 'launch',
        breakpoints: [],
        output: '',
        error: null,
      },
    };
    const admitted = this.options.operations.admit(
      { operationId: input.requestId, requestHash, target: input.target, kind: 'debug' },
      context.path,
      this.stored(entry),
    );
    if (!admitted.admitted) return this.start(sessionId, input);
    this.entries.set(sessionId, entry);
    entry.starting = this.launch(entry, inspected);
    await entry.starting;
    return structuredClone(entry.view);
  }
  private async launch(
    entry: Entry,
    inspected: Awaited<ReturnType<DebugSessions['inspectInput']>>,
  ) {
    const onSpawn = (identity: PtySessionIdentity, profilePath?: string) => {
      entry.identities.push(identity);
      if (profilePath) entry.profiles.push(profilePath);
      if (!this.persist(entry))
        throw refusal('REVISION_CONFLICT', 'debugger ownership changed before launch');
      this.compatible(entry);
    };
    try {
      const sources = await this.options.sources(entry.root);
      entry.sources = sources.hashes;
      entry.sourcesComplete = sources.complete;
      this.compatible(entry);
      let port: number, attest: ConnectionAttestation;
      let preparePreview: ((endpoint: string) => Promise<() => Promise<void>>) | undefined;
      let previewUrl: string | undefined;
      if (entry.configuration.request === 'launch') {
        const common = {
          root: entry.root,
          cwd: inspected.cwd,
          executable: inspected.launch.runtimeExecutable as string,
          env: inspected.launch.environment,
          owner: entry.view.generation,
          onSpawn,
          timers: this.options.timers,
        };
        if (entry.configuration.runtime === 'node')
          entry.debuggee = await launchNode({
            ...common,
            program: entry.configuration.program,
            args: entry.configuration.args ?? [],
          });
        else {
          const preview = await this.options.preview?.(
            entry.target.sessionId,
            entry.input.preview?.leaseId as string,
            entry.target,
            true,
          );
          if (!preview) throw refusal('CAPABILITY_DENIED', 'managed preview is unavailable');
          if (!preview.prepare)
            throw refusal('CAPABILITY_DENIED', 'managed browser preview policy is unavailable');
          preparePreview = preview.prepare;
          previewUrl = preview.url;
          entry.debuggee = await launchChromium({ ...common, url: 'about:blank' });
        }
        port = entry.debuggee.port;
        attest = entry.debuggee.attestConnection.bind(entry.debuggee);
        void entry.debuggee.exited.then(() => {
          if (!entry.closing && !entry.cleaned) void this.close(entry).catch(() => {});
        });
      } else {
        const attach = entry.input.attach as NonNullable<DebugInspect['attach']>;
        port = attach.port;
        attest = (operationId, targetPort, peerPort) =>
          this.options.task(entry.target.sessionId, attach.operationId, entry.target)
            ? this.options.attest(entry.target.sessionId, operationId, targetPort, peerPort)
            : Promise.resolve(false);
      }
      entry.bridge = await (this.options.bridge ?? InspectorBridge).start({
        kind: entry.configuration.runtime,
        operationId: entry.input.attach?.operationId ?? entry.view.generation,
        port,
        attest,
      });
      if (preparePreview) entry.previewClose = await preparePreview(entry.bridge.websocketAddress);
      this.compatible(entry);
      entry.connection = await (this.options.transport ?? DebugConnection).start({
        cwd: entry.root,
        argv: [inspected.launch.executable, ...entry.adapter.argv.slice(1)],
        owner: entry.view.generation,
        timeoutMs: entry.adapter.timeoutMs,
        clock: this.options.clock,
        timers: this.options.timers,
        onSpawn,
        onEvent: (event, body, connectionId) => this.event(entry, event, body, connectionId),
        onFailure: () => this.fail(entry, 'The debug adapter stopped unexpectedly.'),
      });
      const sourceMaps = entry.configuration.sourceMaps !== false;
      await entry.connection.attach({
        type: entry.configuration.runtime === 'node' ? 'pwa-node' : 'pwa-chrome',
        request: 'attach',
        name: entry.configuration.name,
        __workspaceFolder: entry.root,
        cwd: inspected.cwd,
        webRoot: entry.root,
        sourceMaps,
        outFiles: (entry.configuration.outFiles ?? ['**/*.js']).map((glob) =>
          join(entry.root, glob),
        ),
        resolveSourceMapLocations: debugSourceMapLocations(
          entry.root,
          Object.keys(entry.sources),
          previewUrl,
        ),
        autoAttachChildProcesses: false,
        attachExistingChildren: false,
        restart: false,
        address: entry.bridge.address,
        port: entry.bridge.port,
        ...(entry.configuration.runtime === 'node'
          ? { websocketAddress: entry.bridge.websocketAddress }
          : {}),
      });
      this.current(entry.target.sessionId, entry.target);
      if (entry.view.state === 'failed' || entry.closing)
        throw refusal('TARGET_TERMINAL', 'debugger start was cancelled');
      if (entry.view.state === 'starting') entry.view.state = 'running';
      this.persist(entry);
    } catch (error) {
      if (error instanceof DebugProcessStartError && error.debuggee)
        entry.debuggee = error.debuggee;
      entry.view.state = 'failed';
      entry.view.error =
        'The debugger could not start. Inspect its configuration and target again.';
      // A failed start must settle after its own promise, never wait recursively on itself.
      queueMicrotask(() => {
        void this.close(entry, true).catch(() => {});
      });
      throw error;
    }
  }
  private event(entry: Entry, event: string, raw: unknown, connectionId: string) {
    if (
      entry.cleaned ||
      entry.closing ||
      entry.view.state === 'uncertain' ||
      this.entries.get(entry.target.sessionId) !== entry
    )
      return;
    const body = record(raw);
    if (event === 'stopped') {
      entry.view.state = 'paused';
      entry.view.pauseId++;
      entry.view.pausedThreadId = `${connectionId}:${number(body.threadId)}`;
      entry.view.revision++;
    } else if (event === 'continued') {
      entry.view.state = 'running';
      entry.view.pauseId++;
      entry.view.pausedThreadId = null;
      entry.view.revision++;
    } else if (event === 'output') {
      entry.output ??= new CheckOutput([entry.root], entry.secrets);
      entry.output.add(
        connectionId,
        Buffer.from(typeof body.output === 'string' ? body.output : ''),
      );
      entry.view.output = entry.output.snapshot().text;
    } else if (event === 'terminated' && connectionId !== 'root') {
      if ((entry.connection?.sessions.size ?? 0) <= 2) {
        void this.close(entry).catch(() => {});
        return;
      }
      if (entry.view.pausedThreadId?.startsWith(`${connectionId}:`)) {
        entry.view.pausedThreadId = null;
        entry.view.pauseId++;
        entry.view.state = 'running';
      }
    }
    this.persist(entry);
  }
  private fail(entry: Entry, error: string) {
    if (entry.cleaned || entry.closing) return;
    entry.view.state = 'failed';
    entry.view.error = error;
    this.persist(entry);
    void this.close(entry, true).catch(() => {});
  }
  invalidate(projectId: string) {
    for (const entry of this.entries.values())
      if (entry.target.projectId === projectId && !entry.cleaned)
        this.fail(entry, 'Debugger configuration or trust changed.');
  }
  private reference(entry: Entry, reference: string | undefined) {
    const match = /^(root|child-[0-9]+):([0-9]+)$/.exec(reference ?? '');
    if (!match || !entry.connection?.sessions.has(match[1] as string))
      throw refusal('REVISION_CONFLICT', 'debugger reference is stale');
    return { connectionId: match[1] as string, id: Number(match[2]) };
  }
  private async source(
    entry: Entry,
    frame: Record<string, unknown>,
    snapshot: { hashes: Record<string, string>; complete: boolean },
  ): Promise<DebugSource> {
    const source = record(frame.source),
      value = text(source.path),
      base = {
        name: this.cleanText(entry, source.name),
        line: Math.max(1, number(frame.line)),
        column: Math.max(1, number(frame.column)),
      };
    try {
      if (!value || number(source.sourceReference, 0) > 0)
        return { ...base, path: null, sha256: null, mapped: false, reason: 'virtual' };
      const path = this.options.safePath(isAbsolute(value) ? relative(entry.root, value) : value);
      if ((await this.options.plainPath(entry.root, path)) !== 'file')
        throw new Error('unavailable');
      const sha256 = digest(await this.options.read(entry.root, path));
      if (!entry.sourcesComplete || !snapshot.complete)
        return { ...base, path, sha256, mapped: false, reason: 'unavailable' };
      const current = snapshot.hashes;
      const mapChanged =
        Object.entries(entry.sources).some(
          ([name, hash]) => name.endsWith('.map') && current[name] !== hash,
        ) || Object.keys(current).some((name) => name.endsWith('.map') && !(name in entry.sources));
      if (entry.sources[path] !== sha256 || mapChanged)
        return { ...base, path, sha256, mapped: false, reason: 'changed' };
      return { ...base, path, sha256, mapped: true, reason: null };
    } catch {
      return { ...base, path: null, sha256: null, mapped: false, reason: 'outside' };
    }
  }
  async query(
    sessionId: string,
    raw: DebugQuery,
    cancellation?: ToolCancellation,
  ): Promise<DebugQueryResult> {
    const input = DebugQuery.parse(raw),
      entry = this.matching(sessionId, input);
    await entry.starting;
    this.active(entry);
    const revision = entry.view.revision,
      pauseId = entry.view.pauseId;
    if (input.pauseId !== pauseId || (input.kind !== 'threads' && entry.view.state !== 'paused'))
      throw refusal('REVISION_CONFLICT', 'debugger pause changed');
    const result: DebugQueryResult = { generation: entry.view.generation, pauseId, revision };
    const connection = entry.connection as Connection;
    if (input.kind === 'threads') {
      result.threads = [];
      for (const [id] of connection.sessions) {
        const response = record(await connection.request(id, 'threads', {}, cancellation));
        result.threads.push(
          ...objects(response.threads).map((thread) => ({
            id: `${id}:${number(thread.id)}`,
            name: this.cleanText(entry, thread.name),
          })),
        );
      }
    } else {
      const reference = this.reference(
        entry,
        input.threadId ?? input.frameId ?? input.variablesReference,
      );
      const command = input.kind === 'stack' ? 'stackTrace' : input.kind;
      const args =
        input.kind === 'stack'
          ? { threadId: reference.id, startFrame: 0, levels: 100 }
          : input.kind === 'scopes'
            ? { frameId: reference.id }
            : { variablesReference: reference.id, start: 0, count: 200 };
      const response = record(
        await connection.request(reference.connectionId, command, args, cancellation),
      );
      if (input.kind === 'stack') {
        const current = await this.options.sources(entry.root);
        result.frames = await Promise.all(
          objects(response.stackFrames).map(async (frame) => ({
            id: `${reference.connectionId}:${number(frame.id)}`,
            name: this.cleanText(entry, frame.name),
            source: await this.source(entry, frame, current),
          })),
        );
      } else if (input.kind === 'scopes')
        result.scopes = objects(response.scopes).map((scope) => ({
          name: this.cleanText(entry, scope.name),
          variablesReference: `${reference.connectionId}:${number(scope.variablesReference)}`,
          expensive: scope.expensive === true,
        }));
      else
        result.variables = objects(response.variables).map((variable) => ({
          name: this.cleanText(entry, variable.name),
          value: this.cleanText(entry, variable.value),
          type: typeof variable.type === 'string' ? this.cleanText(entry, variable.type) : null,
          variablesReference:
            number(variable.variablesReference, 0) > 0
              ? `${reference.connectionId}:${number(variable.variablesReference)}`
              : null,
        }));
    }
    this.active(entry);
    if (entry.view.pauseId !== pauseId || entry.view.revision !== revision)
      throw refusal('REVISION_CONFLICT', 'debugger changed while reading');
    return result;
  }
  private beginCommand(entry: Entry, commandId: string, input: unknown, interrupt = false) {
    const hash = digest(canonicalJson(input)),
      prior = entry.commands[commandId];
    if (prior) {
      if (prior.hash !== hash) throw refusal('REVISION_CONFLICT', 'debug command changed');
      return { prior: structuredClone(prior.result) };
    }
    if (entry.busy && !interrupt)
      throw refusal('RUN_ALREADY_ACTIVE', 'another debug command is in progress');
    if (entry.busy && interrupt) {
      const interrupted = entry.commands[entry.busy];
      if (interrupted) {
        interrupted.result.state = 'uncertain';
        interrupted.result.error = 'The debugger was stopped before this command was confirmed.';
      }
    }
    if (Object.keys(entry.commands).length >= 256 && !interrupt)
      throw refusal('LIMIT_REACHED', 'debug command history is full; start a new debugger');
    const result: DebugCommandResult = {
      commandId,
      state: 'running',
      session: structuredClone(entry.view),
    };
    entry.commands[commandId] = { hash, result };
    entry.busy = commandId;
    this.persist(entry);
    return { result };
  }
  private finishCommand(entry: Entry, result: DebugCommandResult) {
    result.session = structuredClone(entry.view);
    entry.commands[result.commandId]!.result = structuredClone(result);
    if (entry.busy === result.commandId) entry.busy = undefined;
    this.options.operations.updateDebugResult(entry.view.generation, this.stored(entry));
    return result;
  }
  async breakpoints(sessionId: string, raw: DebugBreakpoints): Promise<DebugCommandResult> {
    const input = DebugBreakpoints.parse(raw),
      entry = this.matching(sessionId, input),
      begun = this.beginCommand(entry, input.commandId, input);
    if (begun.prior) return begun.prior;
    const result = begun.result as DebugCommandResult;
    let sent = false;
    try {
      await entry.starting;
      this.active(entry);
      const path = this.options.safePath(input.path),
        source = await this.options.read(entry.root, path);
      if (
        (await this.options.plainPath(entry.root, path)) !== 'file' ||
        digest(source) !== input.sha256 ||
        entry.sources[path] !== input.sha256
      )
        throw refusal('REVISION_CONFLICT', 'breakpoint source changed');
      if (
        entry.view.breakpoints.filter((item) => item.path !== path).length + input.lines.length >
        256
      )
        throw refusal('LIMIT_REACHED', 'breakpoint limit exceeded');
      const lines = [...new Set(input.lines)];
      let responses: Record<string, unknown>[] = [];
      for (const [id] of (entry.connection as Connection).sessions) {
        sent = true;
        const response = record(
          await entry.connection?.request(id, 'setBreakpoints', {
            source: { path: join(entry.root, path) },
            breakpoints: lines.map((line) => ({ line })),
            sourceModified: false,
          }),
        );
        if (id !== 'root') responses = objects(response.breakpoints);
      }
      this.active(entry);
      if (digest(await this.options.read(entry.root, path)) !== input.sha256)
        throw refusal('REVISION_CONFLICT', 'breakpoint source changed');
      entry.view.breakpoints = [
        ...entry.view.breakpoints.filter((item) => item.path !== path),
        ...lines.map((line, index) => ({
          path,
          sha256: input.sha256,
          requestedLine: line,
          line: Math.max(1, number(responses[index]?.line, line)),
          verified: responses[index]?.verified === true,
          message: responses[index]?.message
            ? this.cleanText(entry, responses[index]?.message)
            : null,
        })),
      ];
      entry.view.revision++;
      result.state = 'succeeded';
    } catch (error) {
      result.state = sent ? 'uncertain' : 'failed';
      result.error =
        error instanceof ToolRefusal ? error.message : 'Breakpoints could not be updated.';
      if (sent && !entry.cleaned && !entry.closing) {
        entry.view.state = 'uncertain';
        entry.view.error = result.error;
        this.options.operations.finish(entry.view.generation, 'uncertain', this.stored(entry));
      }
    }
    return this.finishCommand(entry, result);
  }
  async command(sessionId: string, raw: DebugCommand): Promise<DebugCommandResult> {
    const input = DebugCommand.parse(raw),
      entry = this.matching(sessionId, input);
    if (
      (input.kind === 'stop' || input.kind === 'disconnect') &&
      (input.kind === 'disconnect') !== (entry.view.ownership === 'attached')
    )
      throw refusal(
        'CAPABILITY_DENIED',
        'use Stop for a launched target and Disconnect for an attached task',
      );
    const begun = this.beginCommand(
      entry,
      input.commandId,
      input,
      input.kind === 'stop' || input.kind === 'disconnect',
    );
    if (begun.prior) return begun.prior;
    const result = begun.result as DebugCommandResult;
    let sent = false;
    try {
      if (input.kind === 'stop' || input.kind === 'disconnect') {
        if ((input.kind === 'disconnect') !== (entry.view.ownership === 'attached'))
          throw refusal(
            'CAPABILITY_DENIED',
            'use Stop for a launched target and Disconnect for an attached task',
          );
        await this.close(entry);
        result.state = 'succeeded';
      } else {
        await entry.starting;
        this.active(entry);
        if (input.revision !== entry.view.revision || input.pauseId !== entry.view.pauseId)
          throw refusal('REVISION_CONFLICT', 'debugger pause or revision changed');
        if (input.kind !== 'pause' && entry.view.state !== 'paused')
          throw refusal('REVISION_CONFLICT', 'pause the debugger first');
        let requestedReference =
          input.kind === 'evaluate'
            ? input.frameId
            : (input.threadId ?? entry.view.pausedThreadId ?? undefined);
        if (input.kind === 'pause' && !requestedReference) {
          for (const [connectionId] of (entry.connection as Connection).sessions) {
            const response = record(await entry.connection?.request(connectionId, 'threads', {}));
            const thread = objects(response.threads).find(
              (item) => typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id > 0,
            );
            if (thread) {
              requestedReference = `${connectionId}:${thread.id}`;
              break;
            }
          }
          this.active(entry);
          if (input.revision !== entry.view.revision || input.pauseId !== entry.view.pauseId)
            throw refusal('REVISION_CONFLICT', 'debugger changed while locating a running thread');
          if (!requestedReference)
            throw refusal('TARGET_NOT_FOUND', 'no running debug thread is available to pause');
        }
        const reference = this.reference(entry, requestedReference);
        if (input.kind === 'evaluate' && !input.expression)
          throw refusal('SCHEMA_INVALID', 'enter an expression to evaluate');
        sent = true;
        const response = record(
          await entry.connection?.request(
            reference.connectionId,
            input.kind,
            input.kind === 'evaluate'
              ? { frameId: reference.id, expression: input.expression, context: 'repl' }
              : { threadId: reference.id, singleThread: false },
          ),
        );
        this.active(entry);
        if (input.kind === 'evaluate') {
          if (input.pauseId !== entry.view.pauseId)
            throw refusal('REVISION_CONFLICT', 'debugger resumed during evaluation');
          result.value = this.cleanText(entry, response.result);
          result.variablesReference =
            number(response.variablesReference, 0) > 0
              ? `${reference.connectionId}:${number(response.variablesReference)}`
              : null;
        } else if (
          input.kind !== 'pause' &&
          entry.view.state === 'paused' &&
          entry.view.pauseId === input.pauseId
        ) {
          entry.view.state = 'running';
          entry.view.pauseId++;
          entry.view.pausedThreadId = null;
        }
        entry.view.revision++;
        result.state = 'succeeded';
      }
    } catch (error) {
      result.state =
        sent || error instanceof ToolTerminationUnconfirmed || entry.view.state === 'uncertain'
          ? 'uncertain'
          : 'failed';
      result.error =
        error instanceof ToolRefusal
          ? error.message
          : 'The debugger could not confirm this command.';
      if (sent && !entry.cleaned && !entry.closing) {
        entry.view.state = 'uncertain';
        entry.view.error = result.error;
        this.options.operations.finish(entry.view.generation, 'uncertain', this.stored(entry));
      }
    }
    return this.finishCommand(entry, result);
  }
  commandReceipt(sessionId: string, generation: string, commandId: string) {
    const entry = this.entries.get(sessionId);
    if (entry?.view.generation === generation && entry.commands[commandId])
      return structuredClone(entry.commands[commandId]!.result);
    const prior = this.options.operations.get(generation),
      stored = prior?.result as Stored | undefined;
    if (
      prior?.kind !== 'debug' ||
      prior.target.sessionId !== sessionId ||
      !stored?.commands[commandId]
    )
      throw refusal('TARGET_NOT_FOUND', 'debug command receipt is unavailable');
    return structuredClone(stored.commands[commandId]!.result);
  }
  private close(entry: Entry, failed = false): Promise<void> {
    if (entry.cleaned) return Promise.resolve();
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      await entry.starting?.catch(() => {});
      try {
        const cleanup = await Promise.allSettled([
          entry.connection?.close(),
          entry.debuggee?.close(),
        ]);
        let confirmed = cleanup.every(
          (result) => result.status === 'fulfilled' && result.value !== false,
        );
        for (const identity of entry.identities) {
          if (!(await cleanupPtySession(identity, this.options.timers))) confirmed = false;
          else confirmOwnedProcessCleanup(identity.pid);
        }
        if (!confirmed) throw new ToolTerminationUnconfirmed();
        for (const profile of entry.profiles) await rm(profile, { recursive: true, force: true });
        await entry.bridge?.close();
        await entry.previewClose?.();
        entry.cleaned = true;
        if (entry.output) entry.view.output = entry.output.finish().text;
        for (const reservation of entry.restored) reservation.releaseConfirmed();
        entry.restored = [];
        entry.view.state = failed ? 'failed' : 'stopped';
        entry.view.pauseId++;
        entry.view.revision++;
        entry.view.pausedThreadId = null;
        this.options.operations.reconcile(
          entry.view.generation,
          ['debug'],
          failed ? 'failed' : 'cancelled',
          this.stored(entry),
        );
      } catch (error) {
        entry.view.state = 'uncertain';
        entry.view.error = 'Debugger process cleanup is unconfirmed.';
        this.options.operations.finish(entry.view.generation, 'uncertain', this.stored(entry));
        throw error;
      }
    })().finally(() => {
      entry.closing = undefined;
    });
    return entry.closing;
  }
  async stopCopy(sessionId: string) {
    const entry = this.entries.get(sessionId);
    if (entry) await this.close(entry);
  }
  async previewStopped(leaseId: string) {
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => !entry.cleaned && entry.input.preview?.leaseId === leaseId)
        .map((entry) => {
          entry.view.error = 'The preview target stopped.';
          return this.close(entry, true);
        }),
    );
  }
  async dispose() {
    const results = await Promise.allSettled(
      [...this.entries.values()].map((entry) => this.close(entry)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  hasPending() {
    return [...this.entries.values()].some((entry) => !entry.cleaned);
  }
}
