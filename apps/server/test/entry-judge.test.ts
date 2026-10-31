import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleDir,
  bundledManifest,
  dataBase,
  defaultLocalAiDir,
  legacyJudgeDir,
  runtimeTarget,
} from '@corral/local-intelligence';
import { linearCorral } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';

// Issue #21: the server's own entry point (`pnpm serve`) registers the local AI effort judge like
// the CLI does. A stamp file stands in for an installed bundle and a script that never becomes
// ready stands in for the helper: nothing is downloaded and no model runs.

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-entry-'));
  dirs.push(dir);
  return dir;
};
const modelEnv = (dataHome: string, helper?: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    LOCALAPPDATA: dataHome,
    HOME: dataHome,
    USERPROFILE: dataHome,
  };
  delete env.CORRAL_LOCAL_AI_HELPER;
  return helper ? { ...env, CORRAL_LOCAL_AI_HELPER: helper } : env;
};

/** Stays alive without ever saying it is ready, and exits when the server goes away. */
function idleHelper(dir: string) {
  const path = join(dir, 'idle-helper.mjs');
  writeFileSync(
    path,
    `#!${process.execPath}\nprocess.stdin.on('end', () => process.exit(0));\nprocess.stdin.resume();\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function serve(dataHome: string, helper?: string) {
  const workspace = temp();
  mkdirSync(join(workspace, '.corral'));
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({
      schemaVersion: '0.1',
      decisions: {
        reasoning_effort: { mode: 'observe', providers: ['local-heuristic', 'local-model'] },
      },
    }),
  );
  const child = spawn(
    process.execPath,
    [MAIN, '--workspace', workspace, '--port', '0', '--no-live', '--mock-delay', '10'],
    { env: modelEnv(dataHome, helper), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  const link = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
      const found = out.match(/https?:\/\/\S+#\S+/);
      if (found) resolve(found[0]);
    });
    child.once('exit', (code) => reject(new Error(`server exited (${code})`)));
  });
  const url = new URL(link);
  const origin = url.origin;
  const session = await fetch(`${origin}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get('bootstrap') }),
  });
  const headers = {
    'content-type': 'application/json',
    origin,
    cookie: (session.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    'x-corral-csrf': session.headers.get('x-corral-csrf') ?? '',
  };
  return { origin, headers };
}

async function decisionProviders(dataHome: string, helper?: string) {
  const { origin, headers } = await serve(dataHome, helper);
  const saved = await fetch(`${origin}/api/v1/corrals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      definition: linearCorral(['writer']),
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    }),
  });
  const { corralId } = ((await saved.json()) as { record: { corralId: string } }).record;
  const run = await fetch(`${origin}/api/v1/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      schemaVersion: '0.1',
      commandId: 'cmd_entry',
      corralId,
      definitionRevision: 1,
      mode: 'mock',
    }),
  });
  const { runId } = (await run.json()) as { runId: string };
  const snapshot = (await (
    await fetch(`${origin}/api/v1/runs/${runId}/snapshot`, { headers })
  ).json()) as {
    projection: {
      decisionSettings: {
        reasoning_effort: { providers: { id: string; available: boolean; version: string }[] };
      };
    };
  };
  const decisions = snapshot.projection.decisionSettings;
  return decisions.reasoning_effort.providers;
}

const bundle = bundledManifest();
const target = runtimeTarget(bundle, process.platform, process.arch);

describe('the server entry point registers the local AI effort judge (#21)', () => {
  it.skipIf(!target || process.platform === 'win32')(
    'an installed bundle is available to `pnpm serve`, with its release and classifier',
    async () => {
      const dataHome = temp();
      const root = defaultLocalAiDir(dataBase(modelEnv(dataHome), process.platform, dataHome));
      mkdirSync(bundleDir(root, bundle), { recursive: true });
      writeFileSync(
        join(bundleDir(root, bundle), 'install.json'),
        JSON.stringify({ release: bundle.release, target }),
      );
      const providers = await decisionProviders(dataHome, idleHelper(dataHome));
      expect(providers.find((p) => p.id === 'local-model')).toMatchObject({
        available: true,
        version: `${bundle.release}+effort-v2`,
      });
    },
    30_000,
  );

  it('starting removes the old judge model but keeps files Corral did not write', async () => {
    const dataHome = temp();
    const old = legacyJudgeDir(dataBase(modelEnv(dataHome), process.platform, dataHome));
    mkdirSync(old, { recursive: true });
    for (const name of ['model.onnx', 'tokenizer.json', 'install.json', 'notes.txt'])
      writeFileSync(join(old, name), 'x');
    await serve(dataHome);
    expect(readdirSync(old)).toEqual(['notes.txt']);
  }, 30_000);

  it('without an installed bundle it is plainly unavailable, and the server still runs', async () => {
    const providers = await decisionProviders(temp());
    expect(providers.find((p) => p.id === 'local-model')).toMatchObject({ available: false });
    expect(providers.find((p) => p.id === 'local-heuristic')).toMatchObject({ available: true });
  }, 30_000);
});
