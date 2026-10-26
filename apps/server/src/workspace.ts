import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type InstallationPolicy,
  installationPolicy,
  parseWorkspaceConfig,
  type WorkspaceConfig,
} from '@corral/core';

// Workspace layout:
//   <workspace>/.corral/corral.db     SQLite (WAL)
//   <workspace>/.corral/config.json   hard caps and model profile names, never credentials
// Messages name paths relative to the workspace so they can be shown or logged.

export interface Workspace {
  root: string;
  id: string;
  dbPath: string;
  config: WorkspaceConfig;
  configRevision: string;
  policy: InstallationPolicy;
}

const CONFIG = join('.corral', 'config.json');

export function prepareWorkspace(root: string): Workspace {
  mkdirSync(join(root, '.corral'), { recursive: true, mode: 0o700 });
  const identity = join(root, '.corral', 'workspace-id');
  try {
    writeFileSync(identity, randomUUID(), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const id = readFileSync(identity, 'utf8').trim();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid workspace identity');
  const { config, revision } = readWorkspaceConfig(root);
  return {
    root,
    id,
    dbPath: join(root, '.corral', 'corral.db'),
    config,
    configRevision: revision,
    policy: installationPolicy(config),
  };
}

/** Values and their save guard must come from the same bytes, even after an external edit. */
export function readWorkspaceConfig(root: string) {
  const path = join(root, CONFIG);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  let raw: unknown;
  try {
    raw = text === null ? { schemaVersion: '0.1' } : JSON.parse(text);
  } catch {
    throw new Error(`${CONFIG} is not valid JSON`);
  }
  const parsed = parseWorkspaceConfig(raw);
  if (!parsed.ok) throw new Error(`${CONFIG}: ${parsed.errors.join('; ')}`);
  return {
    config: parsed.config,
    revision: text === null ? 'none' : createHash('sha256').update(text).digest('hex'),
  };
}

/** The config file's content hash; `none` when there is no file (save guard). */
export function configRevision(root: string): string {
  const path = join(root, CONFIG);
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'none';
}

export type ModelConfigChange = { modelProfiles: unknown[]; modelProviders: unknown[] };

/**
 * Replaces `modelProfiles` and `modelProviders` in `.corral/config.json`, keeping every other
 * key. Checked like a config read; written to a temporary file and renamed into place.
 * Errors name fields, never values.
 */
export function writeModelConfig(
  root: string,
  change: ModelConfigChange,
  expectedRevision: string,
  /** Checks that need the runtime (known providers); errors stop the write. */
  check: (config: WorkspaceConfig) => string[] = () => [],
  operation?: WorkspaceConfig['modelSettingsOperation'],
):
  | { ok: true; config: WorkspaceConfig; revision: string }
  | { ok: false; conflict: boolean; errors: string[] } {
  if (configRevision(root) !== expectedRevision) {
    return { ok: false, conflict: true, errors: ['the config changed since it was read'] };
  }
  const path = join(root, CONFIG);
  const raw = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)
    : { schemaVersion: '0.1' };
  // A normal edit supersedes any vault checkpoint. The owner checkpoint and model
  // configuration share the same atomic file replacement.
  delete raw.modelSettingsOperation;
  const next = {
    ...raw,
    modelProfiles: change.modelProfiles,
    modelProviders: change.modelProviders,
    ...(operation ? { modelSettingsOperation: operation } : {}),
  };
  const parsed = parseWorkspaceConfig(next);
  if (!parsed.ok) return { ok: false, conflict: false, errors: parsed.errors };
  const refused = check(parsed.config);
  if (refused.length > 0) return { ok: false, conflict: false, errors: refused };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temporary, path);
  return { ok: true, config: parsed.config, revision: configRevision(root) };
}

/** Explicit apply opt-in; preserves observer settings and guards concurrent config edits. */
export function writeReasoningApply(root: string, apply: boolean, expectedRevision: string) {
  if (configRevision(root) !== expectedRevision) return { ok: false as const };
  const path = join(root, CONFIG);
  const raw = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : { schemaVersion: '0.1' };
  const current = parseWorkspaceConfig(raw);
  if (!current.ok) return { ok: false as const };
  const reasoning_effort = {
    ...(current.config.decisions?.reasoning_effort ?? {
      mode: 'off' as const,
      providers: ['local-model'],
    }),
    apply,
  };
  const next = { ...raw, decisions: { reasoning_effort } };
  const parsed = parseWorkspaceConfig(next);
  if (!parsed.ok) return { ok: false as const };
  writeFileSync(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return { ok: true as const, config: parsed.config, revision: configRevision(root) };
}
