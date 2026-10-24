import { defineProject } from 'vitest/config';
export default defineProject({ test: { name: 'pi-runtime-port', include: ['test/**/*.test.ts'] } });
