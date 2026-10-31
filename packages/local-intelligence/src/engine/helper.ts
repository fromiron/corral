// The process boundary to the Rust helper (../../helper). The engine only sees lines in and out
// and an exit notice, so the server can launch it with its own process-group ownership and tests
// can drive a fake one.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export interface HelperCommand {
  executable: string;
  args: string[];
  /** The bundle folder, so a library's companion files resolve next to it. */
  cwd: string;
  env: Record<string, string>;
}

export interface HelperProcess {
  write(line: string): void;
  onLine(fn: (line: string) => void): void;
  /** Called once when the process has ended, with the last line it wrote to stderr. */
  onExit(fn: (detail: string) => void): void;
  /** Ends the process; resolves once it has exited. */
  kill(): Promise<void>;
}

export type HelperLauncher = (command: HelperCommand) => HelperProcess;

/** A plain child process; the server injects one that owns the process group instead. */
export const spawnHelper: HelperLauncher = (command) => {
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let detail: string | null = null;
  const exitHandlers: ((detail: string) => void)[] = [];
  let markExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const finish = (reason: string) => {
    if (detail !== null) return;
    detail = stderr.trim().split('\n').at(-1) || reason;
    markExited();
    for (const fn of exitHandlers) fn(detail);
  };
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.stdin.on('error', () => {
    // EPIPE after the helper exits; the exit notice reports it.
  });
  child.once('error', (error) => finish(error.message));
  child.once('close', (code, signal) => finish(`exited with ${code ?? signal}`));
  const lines = createInterface({ input: child.stdout });
  return {
    write: (line) => {
      child.stdin.write(`${line}\n`);
    },
    onLine: (fn) => {
      lines.on('line', fn);
    },
    onExit: (fn) => {
      if (detail !== null) {
        const known = detail;
        queueMicrotask(() => fn(known));
      } else exitHandlers.push(fn);
    },
    kill: async () => {
      if (detail === null) child.kill('SIGKILL');
      await exited;
    },
  };
};

export function helperFileName(platform: string = process.platform) {
  return `corral-local-ai-helper${platform === 'win32' ? '.exe' : ''}`;
}

/**
 * The helper the desktop runtime ships in this package's `bin/`, else the one built in this
 * checkout (`pnpm --filter @corral/local-intelligence build:helper`).
 */
export function builtHelperPath(
  platform: string = process.platform,
  packageDir: string = fileURLToPath(new URL('../../', import.meta.url)),
): string | null {
  const name = helperFileName(platform);
  return (
    [join(packageDir, 'bin', name), join(packageDir, 'helper/target/release', name)].find(
      existsSync,
    ) ?? null
  );
}
