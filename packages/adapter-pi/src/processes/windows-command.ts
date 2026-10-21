import type { SpawnOptions } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function environmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const key = Object.keys(environment)
    .sort()
    .find((key) => key.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

export function resolveWindowsExecutable(executable: string, options: SpawnOptions = {}) {
  const environment = options.env ?? process.env;
  const cwd =
    typeof options.cwd === 'string'
      ? options.cwd
      : options.cwd
        ? fileURLToPath(options.cwd)
        : process.cwd();
  const extensions = (environmentValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => /^\.[a-z\d]+$/i.test(extension));
  const names = extname(executable)
    ? [executable, ...extensions.map((extension) => `${executable}${extension}`)]
    : [...extensions.map((extension) => `${executable}${extension}`), executable];
  const directories =
    isAbsolute(executable) || /[\\/]/.test(executable) || /^[a-z]:/i.test(executable)
      ? [cwd]
      : [cwd, ...(environmentValue(environment, 'PATH') ?? '').split(delimiter)];
  for (const directory of directories) {
    const base = resolve(cwd, directory.replace(/^"(.*)"$/, '$1'));
    for (const name of names) {
      const path = resolve(base, name);
      try {
        if (statSync(path).isFile()) return path;
      } catch {}
    }
  }
  throw new Error('The executable is unavailable');
}

/** CRT quoting, followed by the two CMD parses of a batch shim forwarding %*. */
function batchArgument(value: string): string {
  if (/[\r\n\0]/.test(value))
    throw new Error(
      'Windows batch arguments cannot contain CR, LF or NUL; use a native executable',
    );
  let argument = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
  // First the launcher invokes the batch, then its %* forwarding invokes the CLI.
  // Protect both parses, including quote characters; quotes alone do not protect
  // a following ampersand once an earlier argument contains an embedded quote.
  const metacharacters = /([()[\]%!^"`<>&|;, *?])/g;
  argument = argument.replace(metacharacters, '^$1').replace(metacharacters, '^$1');
  // This is batch file source, where %% is a literal percent. /c has different rules.
  return argument.replaceAll('%', '%%');
}

/**
 * Keep raw command source separate from literal argv. Batch programs may themselves
 * reinterpret arguments (CALL, delayed expansion, etc.); those program semantics
 * are not native argv semantics. Standard npm/pnpm %* forwarding remains literal.
 */
export function prepareWindowsCommand(
  executable: string,
  args: readonly string[],
  directory: string,
) {
  let source: string;
  let launchExecutable: string;
  const systemDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  if (/\.(cmd|bat)$/i.test(executable)) {
    if (/[\r\n\0"]/.test(executable)) throw new Error('Invalid Windows batch executable path');
    launchExecutable = join(systemDirectory, 'cmd.exe');
    source = `@setlocal DisableDelayedExpansion\r\n"${executable.replaceAll('%', '%%')}" ${args
      .map(batchArgument)
      .join(' ')}`;
    if (source.length > 8191)
      throw new Error(
        'Windows batch argument command exceeds 8191 characters; use a native executable',
      );
  } else if (
    basename(executable).toLowerCase() === 'cmd.exe' &&
    args.length === 4 &&
    args[0] === '/d' &&
    args[1] === '/s' &&
    args[2] === '/c'
  ) {
    launchExecutable = executable;
    source = args[3] as string;
  } else {
    return { executable, args };
  }
  // CMD decodes a /c string before executing chcp. Read UTF-8 source only after
  // the separate code-page line has executed in the native owner's hidden console.
  const script = join(directory, 'command.cmd');
  writeFileSync(
    script,
    `@echo off\r\n@"${join(systemDirectory, 'chcp.com')}" 65001 >nul\r\n@if errorlevel 1 exit /b 1\r\n${source}\r\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  return { executable: launchExecutable, args: ['/d', '/s', '/c', `"${script}"`] };
}
