import { defineConfig, devices } from '@playwright/test';

const STATIC_DEMO = process.env.CORRAL_STATIC_DEMO === '1';
const PORT = STATIC_DEMO ? 5181 : 5179;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Playwright counts host CPUs even in a smaller CI container; avoid starving timed UI flows.
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: Boolean(process.env.CI),
  // Flaky UI timing must be fixed, not retried away (Implementation Plan §8).
  retries: 0,
  reporter: process.env.CI
    ? [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      // The in-browser runtime (demo): Vite dev server, simulated agents in a worker.
      name: 'chromium',
      testIgnore: ['server/**', 'performance/**'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'firefox',
      testIgnore: ['server/**', 'performance/**'],
      use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } },
    },
    {
      // Against the local server (C-059): each test starts its own server, workspace and DB
      // through the harness, serving the production build of Studio (`pnpm build` first).
      name: 'server',
      testMatch: 'server/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: `pnpm exec vite ${STATIC_DEMO ? 'preview ' : ''}--port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI && !STATIC_DEMO,
    timeout: 60_000,
  },
});
