import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

// Where credentials live (ADR-019): the user's config directory, never the workspace, so a
// workspace can be shared, zipped or committed without carrying anyone's sign-in.

export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CORRAL_CONFIG_DIR) return resolve(env.CORRAL_CONFIG_DIR);
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'corral');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'corral');
}

export function assertOutsideWorkspace(configDir: string, workspace: string) {
  const inside = relative(resolve(workspace), resolve(configDir));
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new Error('The credential directory must be outside the workspace.');
  }
}
