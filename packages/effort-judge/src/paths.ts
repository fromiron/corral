import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where installed models live: the OS's standard per-user data directory (Bell, 2026-10-16:
 * prefer OS-standard locations). Linux $XDG_DATA_HOME or ~/.local/share, macOS
 * ~/Library/Application Support, Windows %LOCALAPPDATA%.
 */
export function defaultModelDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const base =
    platform === 'win32'
      ? (env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'))
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (env.XDG_DATA_HOME ?? join(home, '.local', 'share'));
  return join(base, 'corral', 'effort-judge');
}
