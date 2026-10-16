import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  applyEvent,
  compileDefinition,
  exportRunArchive,
  InProcessTransport,
  openRunArchive,
  type RunProjection,
  type RuntimeTransport,
} from '@corral/core';
import { openReadOnlyDatabase, SqliteRunStore } from '@corral/storage-sqlite';
import { executeOnce, loadSuite, runSuite, summaryTable } from './exec.ts';

const terminal = (p: RunProjection) =>
  ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.status);
const commandId = () => `cmd_${randomUUID()}`;

export interface WatchOptions {
  write(line: string): void;
  signal: AbortSignal;
  commandId(): string;
  /** Only connected for an interactive --watch terminal. */
  onLine?(listener: (line: string) => void): () => void;
}

/** Every terminal action uses the same commands, IDs and revisions as Studio. */
export async function watchRun(
  transport: RuntimeTransport,
  runId: string,
  options: WatchOptions,
): Promise<RunProjection> {
  const snapshot = await transport.getSnapshot(runId);
  let current = snapshot.projection;
  if (terminal(current)) return current;
  return new Promise((resolveRun, reject) => {
    let done = false;
    let cancelling = false;
    let unsubscribe = () => {};
    let unlisten = () => {};
    let lastStatus = '';
    const shownApprovals = new Set<string>();
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      unsubscribe();
      unlisten();
      options.signal.removeEventListener('abort', interrupt);
      if (error) reject(error);
      else resolveRun(current);
    };
    const show = () => {
      if (current.status !== lastStatus) {
        lastStatus = current.status;
        options.write(`Run ${runId}: ${current.status}`);
      }
      for (const approval of Object.values(current.approvals)) {
        if (approval.status !== 'pending' || shownApprovals.has(approval.approvalId)) continue;
        shownApprovals.add(approval.approvalId);
        options.write(
          `Approval ${approval.approvalId} is waiting. Use Studio or type: approve ${approval.approvalId} / reject ${approval.approvalId}`,
        );
      }
      if (terminal(current)) finish();
    };
    const interrupt = () => {
      if (cancelling || done) return;
      cancelling = true;
      void transport
        .sendCommand({
          schemaVersion: '0.1',
          commandId: options.commandId(),
          runId,
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'CLI interrupted' },
        })
        .then((receipt) => {
          if (receipt.status === 'rejected' && !terminal(current))
            finish(new Error('cancellation was rejected'));
        })
        .catch(finish);
    };
    options.signal.addEventListener('abort', interrupt, { once: true });
    unlisten =
      options.onLine?.((line) => {
        const [decision, approvalId, extra] = line.trim().split(/\s+/);
        const approval = approvalId ? current.approvals[approvalId] : undefined;
        if (
          extra ||
          (decision !== 'approve' && decision !== 'reject') ||
          !approval ||
          approval.status !== 'pending' ||
          !approval.subjectVersionIds[0]
        ) {
          options.write('Expected: approve <pending-approval-id> or reject <pending-approval-id>');
          return;
        }
        void transport
          .sendCommand({
            schemaVersion: '0.1',
            commandId: options.commandId(),
            runId,
            type: 'resolve_approval',
            expectedControlRevision: current.controlRevision,
            payload: {
              approvalId: approval.approvalId,
              decision,
              subjectVersionId: approval.subjectVersionIds[0],
            },
          })
          .then((receipt) => {
            if (receipt.status === 'rejected')
              options.write(`Approval rejected: ${receipt.error?.code ?? 'UNKNOWN'}`);
          })
          .catch(finish);
      }) ?? (() => {});
    unsubscribe = transport.subscribe(runId, snapshot.seq, {
      onEvent: (event) => {
        current = applyEvent(current, event);
        show();
      },
      onError: finish,
    });
    if (done) unsubscribe();
    else {
      show();
      if (options.signal.aborted) interrupt();
    }
  });
}

export interface CliIO {
  cwd: string;
  write(line: string): void;
  signal: AbortSignal;
  onLine?(listener: (line: string) => void): () => void;
}

const usage =
  'corral dev [--demo] | validate <file> | run <file> [--input <brief>] [--watch] [--demo] | inspect <run-id> [--judgments] | inspect --archive <file> | export <run-id> [--redact | --private] | judge install|status [--model-dir <dir>] | exec <file> [--input <brief>] [--demo] [--json] | eval <suite.json> [--demo] [--out <file>]';

export async function runCli(args: string[], io: CliIO): Promise<number> {
  let server: import('@corral/server').CorralServer | undefined;
  let activeRunId: string | null = null;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        demo: { type: 'boolean', default: false },
        watch: { type: 'boolean', default: false },
        input: { type: 'string' },
        workspace: { type: 'string' },
        port: { type: 'string', default: '4317' },
        static: { type: 'string' },
        redact: { type: 'boolean', default: false },
        private: { type: 'boolean', default: false },
        archive: { type: 'string' },
        'model-dir': { type: 'string' },
        judgments: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    const [command, target, extra] = positionals;
    if (values.help || !command) {
      io.write(usage);
      return 0;
    }
    if (
      extra ||
      !['dev', 'validate', 'run', 'inspect', 'export', 'judge', 'exec', 'eval'].includes(command)
    ) {
      io.write(usage);
      return 1;
    }
    if (command === 'judge') return await judge(target, values['model-dir'], io);
    const workspace = resolve(io.cwd, values.workspace ?? '.');
    if (command === 'exec' || command === 'eval') {
      if (!target) {
        io.write(usage);
        return 1;
      }
      const mode = values.demo ? 'mock' : 'live';
      if (command === 'eval') {
        const loaded = loadSuite(resolve(io.cwd, target));
        if (!loaded.ok) {
          for (const error of loaded.errors) io.write(`Suite: ${error}`);
          return 1;
        }
        server = await startHeadless(values, workspace);
        const report = await runSuite(
          new InProcessTransport(server.coordinator),
          loaded.suite,
          mode,
          {
            signal: io.signal,
            onResult: io.write,
          },
        );
        io.write(summaryTable(report));
        io.write('Cost and time only: this table does not judge answer quality.');
        if (values.out)
          writeFileSync(resolve(io.cwd, values.out), `${JSON.stringify(report, null, 2)}\n`);
        return report.summary.every((s) => s.runs > 0) ? 0 : 1;
      }
      const compiled = compileDefinition(JSON.parse(readInput(resolve(io.cwd, target))));
      if (!compiled.ok) {
        io.write(`Invalid Corral: ${compiled.diagnostics.map((d) => d.code).join(', ')}`);
        return 1;
      }
      if (values.input) compiled.definition.input.brief = readInput(resolve(io.cwd, values.input));
      server = await startHeadless(values, workspace);
      const result = await executeOnce(
        new InProcessTransport(server.coordinator),
        compiled.definition,
        mode,
        { signal: io.signal },
      );
      if (values.json) io.write(JSON.stringify(result));
      else {
        if (result.output) io.write(result.output);
        io.write(
          `Run ${result.runId}: ${result.status} · ${result.modelCalls} model calls · ${result.outputTokens} output tokens · ${result.wallMs} ms`,
        );
      }
      if (result.needsUser) {
        io.write(
          'This Corral needs a person to approve or decide; exec never decides for you, so the run was cancelled. Use Studio or `corral run --watch`.',
        );
        return 3;
      }
      return result.status === 'succeeded' ? 0 : 1;
    }
    if (command === 'validate' || command === 'run') {
      if (!target) {
        io.write(usage);
        return 1;
      }
      const compiled = compileDefinition(JSON.parse(readInput(resolve(io.cwd, target))));
      if (!compiled.ok) {
        io.write(`Invalid Corral: ${compiled.diagnostics.map((d) => d.code).join(', ')}`);
        return 1;
      }
      if (command === 'validate') {
        io.write('Corral is valid.');
        return 0;
      }
      if (values.input) compiled.definition.input.brief = readInput(resolve(io.cwd, values.input));
      server = await startServer(values, workspace, io);
      if (io.signal.aborted) return 130;
      const transport = new InProcessTransport(server.coordinator);
      const result = await transport.startRun({
        schemaVersion: '0.1',
        commandId: commandId(),
        definition: compiled.definition,
        mode: values.demo ? 'mock' : 'live',
      });
      if (!result.runId) {
        io.write(`Run rejected: ${result.receipt.error?.code ?? 'UNKNOWN'}`);
        return 1;
      }
      activeRunId = result.runId;
      io.write(`Studio session: ${server.bootstrapUrl}`);
      const projection = await watchRun(transport, activeRunId, {
        write: io.write,
        signal: io.signal,
        commandId,
        ...(values.watch && io.onLine ? { onLine: io.onLine } : {}),
      });
      io.write(`Run ${activeRunId}: ${projection.status}`);
      return projection.status === 'succeeded' ? 0 : projection.status === 'cancelled' ? 130 : 1;
    }
    if (command === 'dev') {
      server = await startServer(values, workspace, io);
      io.write(`Studio session: ${server.bootstrapUrl}`);
      if (!io.signal.aborted)
        await new Promise<void>((done) =>
          io.signal.addEventListener('abort', () => done(), { once: true }),
        );
      for (const run of server.coordinator.listRuns()) {
        const projection = server.coordinator.getSnapshot(run.runId).projection;
        if (!terminal(projection))
          await watchRun(new InProcessTransport(server.coordinator), run.runId, {
            write: io.write,
            signal: io.signal,
            commandId,
          });
      }
      return 0;
    }
    if (command === 'inspect' && values.archive) {
      const history = openRunArchive(
        JSON.parse(readInput(resolve(io.cwd, values.archive), 64 * 1024 * 1024)),
      );
      io.write(JSON.stringify(history, null, 2));
      return 0;
    }
    if (!target || (values.private && values.redact)) {
      io.write(usage);
      return 1;
    }
    const db = openReadOnlyDatabase(join(workspace, '.corral', 'corral.db'));
    try {
      const store = new SqliteRunStore(db);
      if (command === 'export')
        io.write(
          JSON.stringify(
            exportRunArchive(store, target, { privateTranscript: values.private }),
            null,
            2,
          ),
        );
      else {
        const run = store.getRun(target);
        if (!run) {
          io.write('No such run.');
          return 1;
        }
        io.write(
          values.judgments
            ? judgmentReport(run.projection)
            : JSON.stringify(run.projection, null, 2),
        );
      }
      return 0;
    } finally {
      db.close();
    }
  } catch {
    io.write('Command failed. Check the input, workspace, port and local model setup.');
    return 1;
  } finally {
    if (server) {
      if (activeRunId && !terminal(server.coordinator.getSnapshot(activeRunId).projection)) {
        const aborted = new AbortController();
        aborted.abort();
        await watchRun(new InProcessTransport(server.coordinator), activeRunId, {
          write: io.write,
          signal: aborted.signal,
          commandId,
        }).catch(() => {});
      }
      await server.close();
    }
  }
}

function readInput(path: string, maximumBytes = 2 * 1024 * 1024): string {
  if (!statSync(path).isFile() || statSync(path).size > maximumBytes)
    throw new Error('input is not a bounded file');
  return readFileSync(path, 'utf8');
}

/**
 * `corral judge install|status` (C-072): the local effort judge model lives in the OS's standard
 * per-user data directory. Installing downloads ≈185 MB from the release in the bundled
 * manifest and checks every file's size and sha256.
 */
async function judge(action: string | undefined, modelDir: string | undefined, io: CliIO) {
  const { bundledManifest, defaultModelDir, installModel, installState } = await import(
    '@corral/effort-judge'
  );
  const dir = modelDir ? resolve(io.cwd, modelDir) : defaultModelDir();
  const manifest = bundledManifest();
  if (action === 'status') {
    const state = installState(dir, manifest);
    io.write(
      state === 'current'
        ? `${manifest.release} installed in ${dir}`
        : state === 'stale'
          ? `an older release is installed in ${dir}; run \`corral judge install\``
          : `not installed (${dir}); run \`corral judge install\``,
    );
    return 0;
  }
  if (action !== 'install') {
    io.write(usage);
    return 1;
  }
  io.write(`Installing ${manifest.release} into ${dir}.`);
  await installModel(dir, {
    manifest,
    onFile: (name, size) => io.write(`Downloading ${name} (${Math.round(size / 1e6)} MB).`),
  });
  io.write(`${manifest.release} installed.`);
  return 0;
}

/** `inspect --judgments`: each request's effort judgments side by side (CR-003, C-071). */
function judgmentReport(projection: RunProjection): string {
  const settings = projection.decisionSettings?.reasoning_effort;
  if (!settings) return `Run ${projection.runId} recorded no judgment settings.`;
  const lines = [
    `Effort judgments for ${projection.runId} (${settings.mode === 'observe' ? 'observe only, not applied' : 'off'})`,
  ];
  for (const p of settings.providers.filter((p) => !p.available))
    lines.push(`  ${p.id}: ${p.reason ?? 'unavailable'}`);
  const calls = projection.executionOrder.flatMap((id) =>
    (projection.executions[id]?.modelCallIds ?? []).map((call) => ({
      call,
      node: projection.executions[id]?.nodeId ?? id,
    })),
  );
  const decisions = Object.values(projection.decisions ?? {});
  for (const { call, node } of calls) {
    for (const d of decisions.filter((x) => x.modelCallId === call)) {
      const result =
        d.status === 'observed'
          ? `${d.answer}${d.evidenceLevel === 'rule' ? ' (rule)' : ''}${
              d.probabilities
                ? ` [${(['low', 'medium', 'high', 'xhigh'] as const)
                    .map((l) => `${l} ${Math.round((d.probabilities?.[l] ?? 0) * 100)}%`)
                    .join(', ')}]`
                : ''
            }`
          : d.status === 'failed'
            ? `failed: ${d.reason}`
            : 'pending';
      lines.push(
        `${call} ${node} ${d.provider} ${result}${d.latencyMs === null ? '' : ` ${d.latencyMs} ms`}`,
      );
    }
  }
  if (decisions.length === 0) lines.push('No requests were judged.');
  return lines.join('\n');
}

/** The local server without Studio: nothing is built or served (exec, eval). */
async function startHeadless(values: { demo?: boolean }, workspace: string) {
  const { createLiveModels, defaultDecisionProviders, startCorralServer } = await import(
    '@corral/server'
  );
  const { ScriptedAgentAdapter } = await import('@corral/testkit');
  return startCorralServer({
    workspace,
    port: 0,
    agents: new ScriptedAgentAdapter({ turns: 2 }),
    decisionProviders: defaultDecisionProviders(),
    ...(values.demo ? {} : { live: createLiveModels() }),
  });
}

async function startServer(
  values: { demo?: boolean; port?: string; static?: string },
  workspace: string,
  io: CliIO,
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const staticDir = resolve(io.cwd, values.static ?? join(root, 'apps/studio/dist'));
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
  if (!existsSync(join(staticDir, 'index.html'))) {
    if (values.static) throw new Error('Studio build is missing');
    io.write('Building Studio.');
    await new Promise<void>((done, reject) => {
      const child = spawn('pnpm', ['--filter', '@corral/studio', 'build'], {
        cwd: root,
        stdio: 'ignore',
        signal: io.signal,
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? done() : reject(new Error('Studio build failed')),
      );
    });
  }
  const { createLiveModels, defaultDecisionProviders, startCorralServer } = await import(
    '@corral/server'
  );
  const { ScriptedAgentAdapter } = await import('@corral/testkit');
  return startCorralServer({
    workspace,
    port,
    staticDir,
    decisionProviders: defaultDecisionProviders(),
    agents: new ScriptedAgentAdapter({ turns: 2 }),
    ...(values.demo ? {} : { live: createLiveModels() }),
  });
}
