import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CorralServer, startCorralServer } from '@corral/server';
import { ScriptedAgentAdapter } from '@corral/testkit';
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
}

async function serve(workspace: string, replyDelayMs: number) {
  if (!existsSync(join(STUDIO, 'index.html'))) {
    throw new Error('Studio is not built: run `pnpm build` before the server E2E tests.');
  }
  return startCorralServer({
    workspace,
    port: 0,
    staticDir: STUDIO,
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

export const test = base.extend<{ replyDelayMs: number; corral: Harness }>({
  replyDelayMs: [50, { option: true }],
  corral: async ({ page, replyDelayMs }, use) => {
    const workspace = mkdtempSync(join(tmpdir(), 'corral-e2e-'));
    const external: string[] = [];
    await page.route('**/*', (route) => {
      const { hostname, origin } = new URL(route.request().url());
      if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
      external.push(origin);
      return route.abort('blockedbyclient');
    });
    let server = await serve(workspace, replyDelayMs);
    const harness: Harness = {
      get server() {
        return server;
      },
      workspace,
      errors: watchErrors(page),
      async open(path = '/') {
        const token = server.bootstrapUrl.split('#')[1];
        await page.goto(`${server.url}${path}#${token}`);
      },
      async restart() {
        await server.close();
        server = await serve(workspace, replyDelayMs);
      },
    };
    try {
      await use(harness);
    } finally {
      await server.close();
      rmSync(workspace, { recursive: true, force: true });
    }
    expect(external, 'requests to hosts other than the local server').toEqual([]);
  },
});

export { expect };
