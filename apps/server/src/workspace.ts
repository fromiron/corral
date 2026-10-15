import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type InstallationPolicy,
  installationPolicy,
  parseWorkspaceConfig,
  type WorkspaceConfig,
} from '@corral/core';

// Workspace layout (C-062, v0.2 supplement §2.3):
//   <workspace>/.corral/corral.db     SQLite (WAL)
//   <workspace>/.corral/config.json   hard caps and model profile names, never credentials
// Messages name paths relative to the workspace so they can be shown or logged.

export interface Workspace {
  root: string;
  dbPath: string;
  config: WorkspaceConfig;
  policy: InstallationPolicy;
}

const CONFIG = join('.corral', 'config.json');

export function prepareWorkspace(root: string): Workspace {
  mkdirSync(join(root, '.corral'), { recursive: true, mode: 0o700 });
  const configPath = join(root, CONFIG);
  let raw: unknown = { schemaVersion: '0.1' };
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      throw new Error(`${CONFIG} is not valid JSON`);
    }
  }
  const parsed = parseWorkspaceConfig(raw);
  if (!parsed.ok) throw new Error(`${CONFIG}: ${parsed.errors.join('; ')}`);
  return {
    root,
    dbPath: join(root, '.corral', 'corral.db'),
    config: parsed.config,
    policy: installationPolicy(parsed.config),
  };
}
