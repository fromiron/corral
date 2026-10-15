import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/performance',
  globalSetup: './e2e/performance/build.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: '../../test-results/performance',
  reporter: [['list']],
  use: {
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    browserName: 'chromium',
  },
});
