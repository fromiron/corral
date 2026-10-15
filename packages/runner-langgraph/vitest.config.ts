import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'runner-langgraph',
    include: ['test/**/*.test.ts'],
  },
});
