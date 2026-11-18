import { defineProject } from 'vitest/config';
import { testTimeout } from '../../vitest.defaults.ts';

export default defineProject({
  test: {
    testTimeout,
    name: 'react',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
  },
});
