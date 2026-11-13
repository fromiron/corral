import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RefusalHelp, refusalActions } from './RefusalHelp.tsx';

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

it("offers the advisor's control after a refusal of the advisor's model, and only where it can open", () => {
  const can = { terminal: false, retry: false, queue: false, edit: true };
  expect(refusalActions('advisor', { ...can, advisor: true })).toEqual(['chooseAdvisor', 'edit']);
  expect(refusalActions('advisor', { ...can, advisor: false })).toEqual(['edit']);
  // Another kind never offers it.
  expect(refusalActions('profile', { ...can, advisor: true })).toEqual(['connect', 'edit']);
  const html = renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <RefusalHelp
        code="GRAPH_INVALID"
        message="Advisor model model-x: no such model profile"
        onAdvisor={() => {}}
      />
    </IntlProvider>,
  );
  expect(html).toContain('data-kind="advisor"');
  // One line of reason; the runtime's words fold away.
  expect(html).toContain(messages.Refusal.advisor);
  expect(html).toMatch(/<details>.*Advisor model model-x.*<\/details>/);
  expect(html).toContain(messages.Refusal.chooseAdvisor);
  expect(html).not.toContain(messages.Refusal.connect);
});
