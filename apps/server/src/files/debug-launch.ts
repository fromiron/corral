import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  canonicalJson,
  type RegisteredDebugAdapter,
  type RegisteredDebugConfiguration,
} from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import { executablePath, fileHash, launchFingerprint } from './launch-fingerprint.ts';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** js-debug checks the HTTP map URL before it can fall back to the captured local file. */
export function debugSourceMapLocations(root: string, paths: string[], previewUrl?: string) {
  const locations = [join(root, '**')];
  if (!previewUrl) return locations;
  // PreviewService already proved the exact lease; its isolated host differs from inspector IPC.
  const preview = new URL(previewUrl);
  if (preview.protocol !== 'http:' || preview.username || preview.password)
    throw new ToolRefusal('CAPABILITY_DENIED', 'debug source maps require an owned local preview');
  for (const path of paths) {
    // The adapter interprets these as glob patterns; wildcard filenames remain unsupported.
    if (
      !path.endsWith('.map') ||
      isAbsolute(path) ||
      /[\\*?[\]{}()!]/.test(path) ||
      path.split('/').some((part) => part === '..' || part === '.git' || part === '.corral')
    )
      continue;
    locations.push(`${preview.origin}/${path.split('/').map(encodeURIComponent).join('/')}`);
  }
  return locations;
}

/** Only names leave the broker; the inspected identity also pins each referenced value. */
export async function debugLaunch(
  root: string,
  revision: number,
  adapter: RegisteredDebugAdapter,
  configuration: RegisteredDebugConfiguration,
  input: unknown,
) {
  const executable = await executablePath(adapter.argv[0] as string, root);
  const files: Record<string, string> = {};
  for (const argument of adapter.argv.slice(1)) {
    if (argument.startsWith('-')) continue;
    const path = isAbsolute(argument) ? argument : resolve(root, argument);
    try {
      if ((await stat(path)).isFile()) files[argument] = await fileHash(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const environment: Record<string, string> = {};
  if (configuration.request === 'launch') {
    for (const name of configuration.envRefs ?? []) {
      const value = process.env[name];
      if (value === undefined || value.includes('\0') || value.length > 16000)
        throw new Error('A referenced debugger environment variable is unavailable');
      environment[name] = value;
    }
  }
  const runtimeExecutable =
    configuration.request === 'launch'
      ? await executablePath(
          configuration.runtime === 'node'
            ? (configuration.runtimeExecutable ?? process.execPath)
            : configuration.executablePath,
          root,
        )
      : null;
  const base = await launchFingerprint(root, revision, {
    ...adapter,
    argv: [adapter.argv[0] as string],
  });
  let runtimeHash: string | null = null;
  if (runtimeExecutable) {
    try {
      // Installed Chromium binaries can exceed the ordinary 256 MiB tool limit.
      runtimeHash = await fileHash(
        runtimeExecutable,
        configuration.runtime === 'chromium' ? 512 * 1024 * 1024 : undefined,
      );
    } catch {
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'The registered debugger runtime cannot be inspected within its supported file-size limit.',
      );
    }
  }
  return {
    executable,
    runtimeExecutable,
    environment,
    fingerprint: hash({
      base: base.fingerprint,
      adapter,
      configuration,
      files,
      environment,
      input,
      runtime: runtimeHash,
    }),
  };
}
