// @vitest-environment jsdom
import type { WorkSession } from '@corral/core';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SessionTabs } from './SessionTabs.tsx';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => {},
  useRouterState: () => ({ pathname: '/sessions/active', href: '/sessions/active' }),
}));
vi.mock('../commandRegistry.ts', () => ({ useRegisterCommands() {} }));
vi.mock('../shortcutBindings.ts', () => ({
  useShortcutBindings() {},
  shortcutCombination: () => '',
}));
vi.mock('../desktop.tsx', () => ({ desktop: false }));
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: () => useState([{ sessionId: 'active', href: '/sessions/active' }]),
}));
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('reveals the active tab again after its label or the available width changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  disposals.push(async () => {
    if (originalScroll)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });
  const reveal = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: reveal,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const session: WorkSession = {
    sessionId: 'active',
    projectId: 'project',
    corralId: null,
    auto: null,
    title: 'First name',
    objective: '',
    pinned: false,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    archivedAt: null,
    entries: [],
  };
  const render = async (title: string) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <SessionTabs sessions={[{ ...session, title }]} />
        </IntlProvider>,
      ),
    );
  await render('First name');
  reveal.mockClear();
  await render('A longer name pushes the active tab outside the viewport');
  expect(reveal).toHaveBeenCalled();
  reveal.mockClear();
  await act(async () => window.dispatchEvent(new Event('resize')));
  expect(reveal).toHaveBeenCalled();
});
