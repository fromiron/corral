import { defineProject } from 'vitest/config';
import { testTimeout } from '../../vitest.defaults.ts';

export default defineProject({
  test: {
    testTimeout,
    name: 'runner-langgraph',
    include: ['test/**/*.test.ts'],
  },
});
