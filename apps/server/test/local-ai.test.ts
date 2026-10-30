import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleDir,
  bundledManifest,
  createLocalIntelligence,
  type HelperLauncher,
  runtimeTarget,
} from '@corral/local-intelligence';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { startCorralServer } from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bundle = bundledManifest();
const target = runtimeTarget(bundle, process.platform, process.arch);
const launches: string[] = [];
const neverReady: HelperLauncher = (command) => {
  launches.push(command.executable);
  return { write() {}, onLine() {}, onExit() {}, kill: async () => {} };
};

it.skipIf(!target)(
  'reasoning settings see a bundle installed while the server runs, and stopping closes the engine',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'corral-local-ai-'));
    dirs.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, '.corral'), { recursive: true });
    writeFileSync(
      join(workspace, '.corral', 'config.json'),
      JSON.stringify({ schemaVersion: '0.1' }),
    );
    const dataRoot = join(root, 'local-ai');
    const localIntelligence = createLocalIntelligence({
      root: dataRoot,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/corral-helper' },
      launch: neverReady,
    });
    const token = 'test-bootstrap-token-0123456789abcdef';
    const server = await startCorralServer({
      workspace,
      port: 0,
      bootstrapToken: token,
      worktreeRoot: join(root, 'worktrees'),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      localIntelligence,
    });
    try {
      const login = await fetch(`${server.url}/api/v1/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: server.url },
        body: JSON.stringify({ token }),
      });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const settings = async () =>
        (await (
          await fetch(`${server.url}/api/v1/models/reasoning`, {
            headers: { origin: server.url, cookie },
          })
        ).json()) as { available: boolean; version: string | null; reason: string | null };

      expect(await settings()).toMatchObject({ available: false });
      expect((await settings()).reason).toContain('corral local-ai install');

      mkdirSync(bundleDir(dataRoot, bundle), { recursive: true });
      writeFileSync(
        join(bundleDir(dataRoot, bundle), 'install.json'),
        JSON.stringify({ release: bundle.release, target }),
      );
      expect(await settings()).toMatchObject({
        available: true,
        version: `${bundle.release}+effort-v1`,
        reason: null,
      });
      expect(launches).toEqual([]);
    } finally {
      await server.close();
    }
    expect(localIntelligence.effort.available()).toMatch(/closed/);
  },
);
