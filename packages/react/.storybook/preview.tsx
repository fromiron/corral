import type { Preview } from '@storybook/react-vite';
import { IntlProvider } from 'use-intl';
import messages from '../src/messages/en.json' with { type: 'json' };
import { DesignKitProvider } from '../src/ui/index.ts';
import '../src/fonts.css';
import './preview.css';

const preview: Preview = {
  parameters: {
    // Accessibility violations fail the story test, not just the panel.
    a11y: { test: 'error' },
    layout: 'padded',
  },
  // Load Inter before a story renders. A swap after the first paint restarts the kit's entrance
  // motion, and the accessibility check would then read colors mid-fade.
  loaders: [
    async () => {
      await document.fonts.load('14px Inter');
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <DesignKitProvider>
          <Story />
        </DesignKitProvider>
      </IntlProvider>
    ),
  ],
};

export default preview;
