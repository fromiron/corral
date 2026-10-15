import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'adapter-pi',
    include: ['test/**/*.test.ts'],
  },
});
