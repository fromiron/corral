import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RefusalHelp } from './RefusalHelp.tsx';

vi.mock('./navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/settings' }) }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    search,
    children,
  }: {
    params: { sessionId: string };
    search: { terminal: string };
    children: ReactNode;
  }) => (
    <a href={`/sessions/${params.sessionId}?panel=terminal&terminal=${search.terminal}`}>
      {children}
    </a>
  ),
}));

it('uncertain ownership gives host diagnostics and exact owner navigation without suggesting queue', () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <RefusalHelp
        code="RUN_ALREADY_ACTIVE"
        message="New diagnostic wording"
        owner={{
          kind: 'terminal',
          id: 'owner_terminal',
          sessionId: 'owner_session',
          state: 'uncertain',
        }}
        sessionId="current_session"
        onQueue={() => {}}
      />
    </IntlProvider>,
  );
  expect(html).toContain('data-kind="terminalUncertain"');
  expect(html).toContain('check the process on the host');
  expect(html).toContain('/sessions/owner_session?panel=terminal&amp;terminal=owner_terminal');
  expect(html).toMatch(/<details>.*New diagnostic wording.*owner_terminal.*<\/details>/);
  expect(html).not.toContain('Move to the queue');
});
