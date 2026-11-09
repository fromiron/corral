// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { InboxPage, validateInboxSearch } from './InboxPage.tsx';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

it('keeps only an in-app return address', () => {
  expect(validateInboxSearch({ returnTo: '/sessions/session_a?panel=run#result' })).toEqual({
    returnTo: '/sessions/session_a?panel=run#result',
  });
  for (const returnTo of [
    'https://example.org',
    '//example.org',
    '/\\example.org',
    '/settings?section=general',
    'sessions/session_a',
    ['/inbox'],
  ])
    expect(validateInboxSearch({ returnTo })).toEqual({});
});

it('names the screen from its own messages', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <InboxPage />
      </IntlProvider>,
    ),
  );
  expect(container.querySelector('h2')?.textContent).toBe('Needs you');
});
