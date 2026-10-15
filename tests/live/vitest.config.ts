import { defineConfig } from 'vitest/config';

// Separate from `pnpm test`: these call real providers and run only by hand (CRL-DEV-004).
export default defineConfig({
  test: {
    name: 'live',
    root: import.meta.dirname,
    include: ['**/*.live.test.ts'],
    testTimeout: 120_000,
  },
});
