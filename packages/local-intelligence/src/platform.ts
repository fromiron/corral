import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Bundle } from './bundle.ts';

/** `<platform>-<arch>` when the bundle ships a runtime library for it, otherwise null. */
export function runtimeTarget(bundle: Bundle, platform: string, arch: string): string | null {
  const target = `${platform}-${arch}`;
  return Object.hasOwn(bundle.runtime.targets, target) ? target : null;
}

/**
 * CPU threads for the embedding engine: the physical core count, at most 6 (more was slower in
 * measurements). Node only reports logical cores, so x64 counts them as two per core (SMT) and
 * arm64 as one.
 */
export function cpuThreads(arch: string, logicalCores: number): number {
  const physical = arch === 'arm64' ? logicalCores : Math.floor(logicalCores / 2);
  return Math.max(1, Math.min(6, physical));
}

/**
 * The OS's standard per-user data directory (Linux $XDG_DATA_HOME or ~/.local/share, macOS
 * ~/Library/Application Support, Windows %LOCALAPPDATA%), the same base the effort judge used.
 */
export function dataBase(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  return platform === 'win32'
    ? (env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'))
    : platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : (env.XDG_DATA_HOME ?? join(home, '.local', 'share'));
}

/** Where local AI bundles are installed, one folder per release. */
export function defaultLocalAiDir(base: string = dataBase()): string {
  return join(base, 'corral', 'local-ai');
}

/** Where the removed effort judge installed its model. */
export function legacyJudgeDir(base: string = dataBase()): string {
  return join(base, 'corral', 'effort-judge');
}
