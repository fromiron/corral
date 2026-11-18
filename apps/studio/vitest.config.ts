import { defineProject } from 'vitest/config';
import { testTimeout } from '../../vitest.defaults.ts';

// Unit tests only; e2e/ runs under Playwright (pnpm test:e2e).
export default defineProject({
  test: {
    testTimeout,
    name: 'studio',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/vitest.setup.ts'],
    passWithNoTests: true,
  },
});
