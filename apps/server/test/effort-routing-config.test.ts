import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffortRoutingSettings } from '@corral/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configRevision,
  currentEffortRouting,
  prepareWorkspace,
  writeEffortRouting,
} from '../src/workspace.ts';

// features/effort-routing.md#설정: the workspace saves effort routing with a revision guard.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-effort-routing-'));
  dirs.push(dir);
  prepareWorkspace(dir);
  return dir;
};
const LOCAL: EffortRoutingSettings = {
  mode: 'manual',
  engine: { kind: 'local', device: { kind: 'cpu', threads: 2 }, callerTimeoutMs: 5000 },
  fallback: { kind: 'provider-default' },
};

describe('saving effort routing', () => {
  it('is Off until saved, and keeps every other config key', () => {
    const root = workspace();
    expect(currentEffortRouting(root)).toEqual({ mode: 'off' });
    const path = join(root, '.corral', 'config.json');
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: '0.1', hardCaps: { maxSpawns: 4 } })}\n`,
    );
    const saved = writeEffortRouting(root, LOCAL, configRevision(root));
    expect(saved).toMatchObject({ ok: true, settings: LOCAL });
    expect(currentEffortRouting(root)).toEqual(LOCAL);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ hardCaps: { maxSpawns: 4 } });
    const off = writeEffortRouting(root, { mode: 'off' }, configRevision(root));
    expect(off).toMatchObject({ ok: true, settings: { mode: 'off' } });
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('decisions');
  });

  it('refuses a stale revision and saves nothing', () => {
    const root = workspace();
    const before = configRevision(root);
    writeEffortRouting(root, LOCAL, before);
    expect(writeEffortRouting(root, { mode: 'off' }, before)).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(currentEffortRouting(root)).toEqual(LOCAL);
  });

  it('routes nothing when the config cannot be read', () => {
    const root = workspace();
    writeFileSync(join(root, '.corral', 'config.json'), '{ not json');
    expect(currentEffortRouting(root)).toEqual({ mode: 'off' });
  });
});
