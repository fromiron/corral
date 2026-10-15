import type { Preview } from '@storybook/react-vite';
import { IntlProvider } from 'use-intl';
import messages from '../src/messages/en.json' with { type: 'json' };
import './preview.css';

const preview: Preview = {
  parameters: {
    // Accessibility violations fail the story test (C-004 PR gate), not just the panel.
    a11y: { test: 'error' },
    layout: 'padded',
  },
  decorators: [
    (Story) => (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Story />
      </IntlProvider>
    ),
  ],
};

export default preview;
