// @vitest-environment jsdom
import type { SessionEntry } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { EntryStatus } from './EntryStatus.tsx';

// features/advisor.md "두는 곳" (대화): a request refused for the advisor's model says so on its
// meta line, and the line's action opens the advisor control beside the request box.

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#session">{children}</a>,
}));
vi.mock('../navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));

Element.prototype.getAnimations ??= () => [];

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
});

it("a refused request's meta line opens the advisor control", async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const entry = {
    entryId: 'entry_1',
    intent: 'next',
    text: 'Find why login is slow',
    state: 'refused',
    detail: 'Advisor model model-a: sign in to OpenAI',
    refusal: { code: 'GRAPH_INVALID', message: 'Advisor model model-a: sign in to OpenAI' },
    createdAt: '2026-11-14T00:00:00Z',
  } as unknown as SessionEntry;
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
        <EntryStatus
          sessionId="session"
          entry={entry}
          steer={null}
          canResend={false}
          onResend={() => {}}
          onPanel={() => {}}
        />
      </IntlProvider>,
    ),
  );
  expect(container.textContent).toContain(messages.Refusal.advisor);
  const opened = vi.fn();
  window.addEventListener('corral:open-advisor', opened);
  try {
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((node) => node.textContent === messages.Refusal.chooseAdvisor)
        ?.click(),
    );
  } finally {
    window.removeEventListener('corral:open-advisor', opened);
  }
  expect(opened).toHaveBeenCalledTimes(1);
});
