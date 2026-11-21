import { defineProject } from 'vitest/config';
import { testTimeout } from '../../vitest.defaults.ts';
export default defineProject({
  test: { testTimeout, name: 'pi-runtime-port', include: ['test/**/*.test.ts'] },
});
