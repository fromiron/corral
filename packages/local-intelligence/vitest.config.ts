import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'local-intelligence',
    include: ['test/**/*.test.ts'],
  },
});
