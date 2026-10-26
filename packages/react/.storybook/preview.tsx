import type { Preview } from '@storybook/react-vite';
import { IntlProvider } from 'use-intl';
import messages from '../src/messages/en.json' with { type: 'json' };
import { DesignKitProvider } from '../src/ui/index.ts';
import './preview.css';

const preview: Preview = {
  parameters: {
    // Accessibility violations fail the story test, not just the panel.
    a11y: { test: 'error' },
    layout: 'padded',
  },
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
