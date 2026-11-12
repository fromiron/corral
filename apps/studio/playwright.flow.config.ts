import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// Scene checks (docs/plans/unified-flow.md §9). Each test starts its own server through the
// E2E harness, so there is no webServer here.
export default defineConfig({
  ...base,
  testDir: './e2e/flow',
  // The tests write one shared baseline file.
  workers: 1,
  fullyParallel: false,
  projects: [{ name: 'flow', testMatch: '**/*.spec.ts' }],
});
