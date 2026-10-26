import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.ts';

const STATIC_DEMO = process.env.CORRAL_STATIC_DEMO === '1';
const PORT = STATIC_DEMO ? 5181 : 5179;

export default defineConfig({
  ...base,
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  use: { ...base.use, baseURL: `http://localhost:${PORT}` },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['server/**', 'performance/**'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testMatch: [
        'studio.spec.ts',
        'accessibility.spec.ts',
        'palette.spec.ts',
        'run-page-narrow.spec.ts',
      ],
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'server',
      testMatch: 'server/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `pnpm exec vite ${STATIC_DEMO ? 'preview ' : ''}--port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI && !STATIC_DEMO,
    timeout: 60_000,
  },
});
