import { defineConfig } from 'vitest/config';
import { testTimeout } from '../../vitest.defaults.ts';
export default defineConfig({
  test: { testTimeout, name: 'desktop', include: ['test/**/*.test.ts'] },
});
