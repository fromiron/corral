import { defineProject } from 'vitest/config';
import { testTimeout } from '../../vitest.defaults.ts';

export default defineProject({
  test: {
    testTimeout,
    name: 'storage-sqlite',
    include: ['test/**/*.test.ts'],
  },
});
