import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { type CorralServer, startCorralServer } from '@corral/server';
import { FAKE_PROFILES, fakeOpenAI } from '@corral/server/testing';
import { ScriptedAgentAdapter, type ScriptedAgentOptions } from '@corral/testkit';
import { type CompatibleEndpoint, startCompatibleEndpoint } from '@corral/testkit/endpoint';
import { test as base, expect, type Page } from '@playwright/test';

// E2E harness: every test gets its own server process state, workspace and SQLite file,
// scripted agents, and a browser that may not reach any host but the local server. Traces are
// kept for failures (playwright.config.ts).

const STUDIO = join(import.meta.dirname, '..', '..', 'dist');

async function removeTestWorkspace(workspace: string, configDir?: string) {
  const generatedRoot = resolve(workspace);
  if (
    dirname(generatedRoot) !== resolve(tmpdir()) ||
    !basename(generatedRoot).startsWith('corral-e2e-')
  )
    throw new Error('E2E cleanup target is outside the generated temporary workspace');
  const cleanupPaths = [generatedRoot, `${generatedRoot}-worktrees`];
  if (configDir) {
    if (resolve(configDir) !== `${generatedRoot}-config`)
      throw new Error('E2E config cleanup target differs from its generated workspace');
    cleanupPaths.push(resolve(configDir));
  }
  // Chromium's Windows profile handles can settle just after the owned process exits.
  for (const path of cleanupPaths)
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

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
  /** A keyless OpenAI-compatible endpoint on 127.0.0.1, when the test asked for one. */
  endpoint: CompatibleEndpoint | null;
}

type Fake = ReturnType<typeof fakeOpenAI>;
type AgentReply =
  | string
  | {
      reply: NonNullable<ScriptedAgentOptions['reply']>;
      beforeReply?: ScriptedAgentOptions['beforeReply'];
    }
  | null;

async function serve(
  workspace: string,
  replyDelayMs: number,
  fake: Fake | null,
  endpoint: CompatibleEndpoint | null,
  agentReply: AgentReply,
  port = 0,
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
    port,
    staticDir: STUDIO,
    // Sessions' working copies stay with the test, never in the user's data directory.
    worktreeRoot: `${workspace}-worktrees`,
    ...(fake ? { live: fake.live } : {}),
    agents: new ScriptedAgentAdapter({
      turns: 2,
      beforeReply:
        (typeof agentReply === 'object' && agentReply?.beforeReply) ||
        (() => new Promise((done) => setTimeout(done, replyDelayMs))),
      ...(agentReply === null
        ? {}
        : {
            reply: typeof agentReply === 'string' ? () => agentReply : agentReply.reply,
            appendNotes: false,
          }),
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
  streamTokensPerSecond: number;
  live: boolean;
  codexLogin: boolean;
  reasoningApi: boolean;
  imageInput: boolean;
  compatibleEndpoint: boolean;
  agentReply: AgentReply;
  corral: Harness;
}>({
  replyDelayMs: [50, { option: true }],
  streamTokensPerSecond: [0, { option: true }],
  live: [false, { option: true }],
  /** Lay a Codex CLI login for the fake OpenAI to borrow. */
  codexLogin: [false, { option: true }],
  reasoningApi: [false, { option: true }],
  imageInput: [false, { option: true }],
  /** Profiles on a keyless OpenAI-compatible endpoint instead of the fake OpenAI. */
  compatibleEndpoint: [false, { option: true }],
  /** Deterministic text or role-specific replies, without provider calls. */
  agentReply: [null, { option: true }],
  corral: async (
    {
      page,
      replyDelayMs,
      streamTokensPerSecond,
      live,
      codexLogin,
      reasoningApi,
      imageInput,
      compatibleEndpoint,
      agentReply,
    },
    use,
  ) => {
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
          configDir: `${workspace}-config`,
          ...(codexLogin ? { codexLogin: {} } : {}),
          reasoningApi,
          imageInput,
          tokensPerSecond: streamTokensPerSecond,
        })
      : null;
    const endpoint = compatibleEndpoint ? await startCompatibleEndpoint() : null;
    let server = await serve(workspace, replyDelayMs, fake, endpoint, agentReply);
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
        // Studio mounts only after redeeming the bootstrap cookie and checking the session. A
        // settings address opens the modal settings dialog, which hides the banner (#88).
        await expect(
          page.getByRole('banner').or(page.locator('[data-settings-dialog]')).first(),
        ).toBeVisible();
      },
      async restart() {
        const port = Number(new URL(server.url).port);
        await server.close();
        server = await serve(workspace, replyDelayMs, fake, endpoint, agentReply, port);
      },
    };
    try {
      await use(harness);
    } finally {
      await server.close();
      await endpoint?.close();
      await removeTestWorkspace(workspace, fake?.configDir);
    }
    expect(external, 'requests to hosts other than the local server').toEqual([]);
  },
});

export { expect };
