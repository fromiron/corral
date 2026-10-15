import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/*',
      'tools/spec-check',
      'packages/react/vitest.storybook.config.ts',
    ],
  },
});
