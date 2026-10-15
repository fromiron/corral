import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'storage-sqlite',
    include: ['test/**/*.test.ts'],
  },
});
