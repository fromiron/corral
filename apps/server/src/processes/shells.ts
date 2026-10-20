import { access, realpath } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { windowsPowerShell } from './owned-process.ts';

export type ShellId = 'powershell' | 'pwsh' | 'cmd' | 'git-bash' | 'bash' | 'sh';
export type ShellCommand = { shellId: ShellId; executable: string; args: string[] };
export type ShellInfo = { id: ShellId; label: string; executable: string };

async function firstInstalled(paths: string[]) {
  for (const path of paths) {
    try {
      await access(path);
      return await realpath(path);
    } catch {}
  }
  return undefined;
}

export async function listShells(): Promise<ShellInfo[]> {
  const path = process.env.PATH ?? '';
  const fromPath = (file: string) =>
    path
      .split(delimiter)
      .filter(Boolean)
      .map((p) => join(p, file));
  const candidates: { id: ShellId; label: string; paths: string[] }[] =
    process.platform === 'win32'
      ? [
          { id: 'powershell', label: 'Windows PowerShell', paths: [windowsPowerShell()] },
          { id: 'pwsh', label: 'PowerShell', paths: fromPath('pwsh.exe') },
          {
            id: 'cmd',
            label: 'Command Prompt (UTF-8 batch)',
            paths: [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')],
          },
          {
            id: 'git-bash',
            label: 'Git Bash',
            paths: [
              join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
              ...fromPath('bash.exe').filter((p) => /[\\/]Git[\\/]/i.test(p)),
            ],
          },
        ]
      : [
          { id: 'bash', label: 'Bash', paths: ['/bin/bash', ...fromPath('bash')] },
          { id: 'sh', label: 'POSIX shell', paths: ['/bin/sh', ...fromPath('sh')] },
        ];
  const shells: ShellInfo[] = [];
  for (const candidate of candidates) {
    const executable = await firstInstalled(candidate.paths);
    if (executable) shells.push({ id: candidate.id, label: candidate.label, executable });
  }
  return shells;
}

export async function resolveShellCommand(command: string, id?: string): Promise<ShellCommand> {
  if (!command.trim() || command.length > 32768 || command.includes('\0'))
    throw new Error('Command must contain between 1 and 32768 characters without NUL');
  const shell = (await listShells()).find(
    (entry) => entry.id === (id ?? (process.platform === 'win32' ? 'powershell' : 'bash')),
  );
  if (!shell) throw new Error('The selected shell is not installed');
  const args =
    shell.id === 'powershell' || shell.id === 'pwsh'
      ? [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(
            `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$ErrorActionPreference = 'Stop'\n${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n`,
            'utf16le',
          ).toString('base64'),
        ]
      : shell.id === 'cmd'
        ? ['/d', '/s', '/c', command]
        : ['--noprofile', '--norc', '-c', command];
  if (shell.id === 'sh') args.splice(0, 2);
  return { shellId: shell.id, executable: shell.executable, args };
}

/** Deliberately excludes provider keys, bootstrap tokens and inherited app configuration. */
export function commandEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    LANG: 'C.UTF-8',
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_USERCONFIG: join(home, 'npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc'),
  };
}
