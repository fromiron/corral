import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Run on demand only: pnpm --filter @corral/spike-p0 exec vitest run
export default defineConfig({
  test: {
    include: ['src/**/*.browser.test.mjs'],
    browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' }] },
  },
});
