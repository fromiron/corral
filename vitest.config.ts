import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Leave CPU for CLI/SDK child processes alongside the test workers.
    maxWorkers: process.env.CI ? 2 : undefined,
    projects: [
      'packages/*',
      'apps/*',
      'tools/spec-check',
      'packages/react/vitest.storybook.config.ts',
    ],
  },
});
