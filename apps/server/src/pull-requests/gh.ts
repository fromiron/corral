import { spawn } from 'node:child_process';

export type GhResult = { code: number | 'missing' | 'timeout'; stdout: string; stderr?: string };
export type GhRunner = (args: string[]) => Promise<GhResult>;

const GITHUB_REMOTE =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export function parseGitHubRemote(url: string): { owner: string; name: string } | null {
  const match = GITHUB_REMOTE.exec(url.trim());
  return match?.[1] && match[2] ? { owner: match[1], name: match[2] } : null;
}

const OUTPUT_LIMIT = 4 * 1024 * 1024;

/** The person's `gh`, run outside any repository with prompts off (features/pull-requests.md). */
export function ghRunner(options: { cwd: string; timeoutMs?: number }): GhRunner {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn('gh', args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          NO_COLOR: '1',
          GH_PAGER: 'cat',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: GhResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ code: 'timeout', stdout, stderr });
      }, options.timeoutMs ?? 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
      });
      child.on('error', (error: NodeJS.ErrnoException) =>
        finish({ code: error.code === 'ENOENT' ? 'missing' : 1, stdout, stderr }),
      );
      child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
    });
}
