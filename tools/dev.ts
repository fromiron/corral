import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// `pnpm dev` keeps the in-browser simulated runtime. `pnpm dev --live` starts the local
// server and Vite together so Studio hot-reloads against a server that can call connected models.
// The page has to be opened on Vite's origin: that origin is allowed on the server, and Vite
// proxies `/api` to it (`apps/studio/vite.config.ts`).

export const SERVER_PORT = 4317;
export const STUDIO_PORT = 5173;
export const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
export const STUDIO_ORIGIN = `http://localhost:${STUDIO_PORT}`;
export const ROOT = join(import.meta.dirname, '..');

export const usage = `Usage: pnpm dev [--live] [-- <vite args>]

  pnpm dev         in-browser simulated agents, with hot reload
  pnpm dev --live  hot-reloading Studio on the local server, which can call connected models
`;

export interface DevCommand {
  help: boolean;
  live: boolean;
  studioArgs: string[];
}

export function parseDevArgs(argv: string[]): DevCommand {
  const args = argv.filter((arg) => arg !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    return { help: true, live: false, studioArgs: [] };
  }
  const studioArgs = args.filter((arg) => arg !== '--live');
  if (args.includes('--live') && studioArgs.length > 0) {
    throw new Error(`pnpm dev --live takes no extra arguments (${studioArgs.join(' ')}).`);
  }
  return { help: false, live: args.includes('--live'), studioArgs };
}

export function demoArgs(studioArgs: readonly string[]): string[] {
  return [
    '--filter',
    '@corral/studio',
    'dev',
    ...(studioArgs.length > 0 ? ['--', ...studioArgs] : []),
  ];
}

/** Live models stay on (no `--no-live`) and Studio is not built or served by this process. */
export function liveServerArgs(workspace: string): string[] {
  return [
    'apps/server/src/main.ts',
    '--workspace',
    workspace,
    '--port',
    String(SERVER_PORT),
    '--allow-origin',
    STUDIO_ORIGIN,
    '--mock-delay',
    '0',
  ];
}

/** A leftover `CORRAL_SERVER` must not turn the simulated dev server into the live proxy. */
export function demoEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.CORRAL_SERVER;
  return next;
}

export function liveStudioEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, CORRAL_SERVER: SERVER_ORIGIN };
}

export function liveStudioArgs(): string[] {
  return [
    '--filter',
    '@corral/studio',
    'exec',
    'vite',
    '--port',
    String(STUDIO_PORT),
    '--strictPort',
  ];
}

const BOOTSTRAP = /http:\/\/127\.0\.0\.1:\d+\/#bootstrap=([A-Za-z0-9_-]+)/;
const SERVER_INTRO = 'Corral is running. Open this link to start a session';

export function bootstrapToken(line: string): string | null {
  return BOOTSTRAP.exec(line)?.[1] ?? null;
}

export function viteIsReady(line: string): boolean {
  return line.includes(`${STUDIO_ORIGIN}/`) || line.includes(`http://127.0.0.1:${STUDIO_PORT}/`);
}

export interface LiveLogState {
  token: string | null;
  studioReady: boolean;
  announced: boolean;
}

export const initialLiveLog: LiveLogState = { token: null, studioReady: false, announced: false };

export function studioSessionLines(token: string): string[] {
  return [
    'Corral is running. Open this link to start a session (reusable until this server stops):',
    `  ${STUDIO_ORIGIN}/#bootstrap=${token}`,
  ];
}

/** Hides the server's own bootstrap URL until Vite is up, then prints that URL on Vite's origin. */
export function reduceLiveLog(
  state: LiveLogState,
  source: 'server' | 'studio',
  line: string,
): { state: LiveLogState; lines: string[] } {
  const found = source === 'server' ? bootstrapToken(line) : null;
  const next: LiveLogState = {
    token: found ?? state.token,
    studioReady: state.studioReady || (source === 'studio' && viteIsReady(line)),
    announced: state.announced,
  };
  const lines: string[] = [];
  const serverLink = source === 'server' && (line.includes(SERVER_INTRO) || found !== null);
  if (!serverLink) lines.push(line);
  if (next.token && next.studioReady && !next.announced) {
    next.announced = true;
    lines.push(...studioSessionLines(next.token));
  }
  return { state: next, lines };
}

export function pushText(pending: string, chunk: string, onLine: (line: string) => void): string {
  const parts = (pending + chunk).split('\n');
  const rest = parts.pop() ?? '';
  for (const line of parts) onLine(line);
  return rest;
}

function stopChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

async function supervise(children: ChildProcess[]): Promise<number> {
  const rows = children.map((child) => ({ child, finished: false }));
  let stopping = false;
  let code = 0;
  let force: NodeJS.Timeout | undefined;
  const stop = (next: number, signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    code = next;
    for (const row of rows) stopChild(row.child, signal);
    force = setTimeout(() => {
      for (const row of rows) if (!row.finished) stopChild(row.child, 'SIGKILL');
    }, 2000);
    force.unref();
  };
  const onSignal = (signal: NodeJS.Signals) => stop(0, signal);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const check = () => {
        if (settled || rows.some((row) => !row.finished)) return;
        settled = true;
        if (force) clearTimeout(force);
        resolve();
      };
      for (const row of rows) {
        row.child.on('exit', (status, signal) => {
          if (!stopping) {
            const interrupted = signal === 'SIGINT' || signal === 'SIGTERM';
            stop(interrupted ? 0 : (status ?? 1), 'SIGTERM');
          }
          row.finished = true;
          check();
        });
        row.child.on('error', () => {
          if (!stopping) stop(1, 'SIGTERM');
          row.finished = true;
          check();
        });
      }
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return code;
}

function follow(child: ChildProcess, source: 'server' | 'studio', logs: { current: LiveLogState }) {
  let pending = '';
  const write = (line: string) => {
    const next = reduceLiveLog(logs.current, source, line);
    logs.current = next.state;
    for (const out of next.lines) process.stdout.write(`${out}\n`);
  };
  const flush = () => {
    if (!pending) return;
    const line = pending;
    pending = '';
    write(line);
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending = pushText(pending, chunk, write);
  });
  child.stdout?.on('end', flush);
  child.on('exit', flush);
  child.stderr?.pipe(process.stderr);
}

function spawnGroup(command: string, args: string[], env: NodeJS.ProcessEnv, piped: boolean) {
  return spawn(command, args, {
    cwd: ROOT,
    env,
    detached: process.platform !== 'win32',
    stdio: piped ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
}

export async function main(argv: string[]): Promise<number> {
  let command: DevCommand;
  try {
    command = parseDevArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid arguments.');
    return 1;
  }
  if (command.help) {
    console.log(usage.trimEnd());
    return 0;
  }
  if (!command.live) {
    return supervise([
      spawnGroup('pnpm', demoArgs(command.studioArgs), demoEnv(process.env), false),
    ]);
  }
  const server = spawnGroup(process.execPath, liveServerArgs(ROOT), process.env, true);
  const studio = spawnGroup('pnpm', liveStudioArgs(), liveStudioEnv(process.env), true);
  const logs = { current: initialLiveLog };
  follow(server, 'server', logs);
  follow(studio, 'studio', logs);
  return supervise([server, studio]);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'pnpm dev failed.');
      process.exitCode = 1;
    });
}
