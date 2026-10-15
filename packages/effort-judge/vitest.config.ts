import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'effort-judge',
    include: ['test/**/*.test.ts'],
  },
});
