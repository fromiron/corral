import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CorralServer, startCorralServer } from '@corral/server';
import { FAKE_PROFILES, fakeOpenAI } from '@corral/server/testing';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { type CompatibleEndpoint, startCompatibleEndpoint } from '@corral/testkit/endpoint';
import { test as base, expect, type Page } from '@playwright/test';

// C-059 E2E harness: every test gets its own server process state, workspace and SQLite file,
// scripted agents, and a browser that may not reach any host but the local server. Traces are
// kept for failures (playwright.config.ts).

const STUDIO = join(import.meta.dirname, '..', '..', 'dist');

export interface Harness {
  readonly server: CorralServer;
  workspace: string;
  /** Opens a Studio path with a fresh session (the bootstrap link). */
  open(path?: string): Promise<void>;
  /** Stops the server like a crash or Ctrl-C, then starts a new one on the same workspace. */
  restart(): Promise<void>;
  /** Console errors and page errors seen so far. */
  errors: string[];
  /** The fake OpenAI behind live runs, when the test asked for live models. */
  fake: Fake | null;
  /** A keyless OpenAI-compatible endpoint on 127.0.0.1 (CR-005), when the test asked for one. */
  endpoint: CompatibleEndpoint | null;
}

type Fake = ReturnType<typeof fakeOpenAI>;

async function serve(
  workspace: string,
  replyDelayMs: number,
  fake: Fake | null,
  endpoint: CompatibleEndpoint | null,
) {
  if (!existsSync(join(STUDIO, 'index.html'))) {
    throw new Error('Studio is not built: run `pnpm build` before the server E2E tests.');
  }
  if (fake) {
    mkdirSync(join(workspace, '.corral'), { recursive: true });
    writeFileSync(
      join(workspace, '.corral', 'config.json'),
      JSON.stringify(
        endpoint
          ? {
              schemaVersion: '0.1',
              modelProviders: [
                {
                  id: 'local',
                  name: 'Local server',
                  baseUrl: endpoint.baseUrl,
                  access: 'none',
                  models: [{ id: 'llama3.2', contextWindow: 8000, maxOutput: 512 }],
                },
              ],
              modelProfiles: [{ id: 'model-a', provider: 'local', model: 'llama3.2' }],
            }
          : { schemaVersion: '0.1', modelProfiles: FAKE_PROFILES },
      ),
    );
  }
  return startCorralServer({
    workspace,
    port: 0,
    staticDir: STUDIO,
    ...(fake ? { live: fake.live } : {}),
    agents: new ScriptedAgentAdapter({
      turns: 2,
      beforeReply: () => new Promise((done) => setTimeout(done, replyDelayMs)),
    }),
  });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

export const test = base.extend<{
  replyDelayMs: number;
  live: boolean;
  codexLogin: boolean;
  compatibleEndpoint: boolean;
  corral: Harness;
}>({
  replyDelayMs: [50, { option: true }],
  live: [false, { option: true }],
  /** Lay a Codex CLI login (CR-004) for the fake OpenAI to borrow. */
  codexLogin: [false, { option: true }],
  /** Profiles on a keyless OpenAI-compatible endpoint instead of the fake OpenAI (CR-005). */
  compatibleEndpoint: [false, { option: true }],
  corral: async ({ page, replyDelayMs, live, codexLogin, compatibleEndpoint }, use) => {
    const workspace = mkdtempSync(join(tmpdir(), 'corral-e2e-'));
    const external: string[] = [];
    await page.route('**/*', (route) => {
      const { hostname, origin } = new URL(route.request().url());
      if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
      external.push(origin);
      return route.abort('blockedbyclient');
    });
    const fake = live
      ? fakeOpenAI({
          configDir: join(workspace, '..', `${workspace.split('/').at(-1)}-config`),
          ...(codexLogin ? { codexLogin: {} } : {}),
        })
      : null;
    const endpoint = compatibleEndpoint ? await startCompatibleEndpoint() : null;
    let server = await serve(workspace, replyDelayMs, fake, endpoint);
    const harness: Harness = {
      get server() {
        return server;
      },
      workspace,
      errors: watchErrors(page),
      fake,
      endpoint,
      async open(path = '/') {
        const token = server.bootstrapUrl.split('#')[1];
        await page.goto(`${server.url}${path}#${token}`);
      },
      async restart() {
        await server.close();
        server = await serve(workspace, replyDelayMs, fake, endpoint);
      },
    };
    try {
      await use(harness);
    } finally {
      await server.close();
      await endpoint?.close();
      rmSync(workspace, { recursive: true, force: true });
      if (fake) rmSync(fake.configDir, { recursive: true, force: true });
    }
    expect(external, 'requests to hosts other than the local server').toEqual([]);
  },
});

export { expect };
