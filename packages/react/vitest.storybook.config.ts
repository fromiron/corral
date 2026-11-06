import { createRequire } from 'node:module';
import { join } from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineProject } from 'vitest/config';

const studioRequire = createRequire(new URL('../../apps/studio/package.json', import.meta.url));

// Every story renders in Chromium and must pass the a11y addon's axe checks.
export default defineProject({
  optimizeDeps: {
    include: [
      'react-markdown',
      '@base-ui/react/select',
      'lucide-react',
      studioRequire.resolve('@tanstack/react-router'),
      'zustand/react/shallow',
    ],
  },
  plugins: [storybookTest({ configDir: join(import.meta.dirname, '.storybook') })],
  test: {
    name: 'storybook',
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
