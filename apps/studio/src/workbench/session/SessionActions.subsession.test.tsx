// @vitest-environment jsdom
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TopbarSlotContext } from '../TopbarSlot.tsx';
import { SessionActions } from './SessionActions.tsx';

// docs/specs/features/sub-sessions.md 열기: the session menu opens a sub-session from a Paddock,
// and is off, with its reason, without one.

const fixture = vi.hoisted(() => ({
  navigate: (() => {}) as (...args: unknown[]) => unknown,
  services: {} as Record<string, unknown>,
}));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => fixture.navigate,
  useRouter: () => ({ invalidate: async () => {} }),
}));
vi.mock('../ChatView.tsx', () => ({ useChatDensityRow: () => () => null }));
vi.mock('../../sessionActions.ts', () => ({ newCommandId: () => 'cmd_fixed' }));

Element.prototype.getAnimations ??= () => [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const session = {
  sessionId: 'parent',
  projectId: 'project',
  title: 'Login work',
  corralId: null,
  revision: 1,
  pinned: false,
  archivedAt: null,
  entries: [],
} as unknown as WorkSession;

async function menuItem(canOpenSubSession: boolean) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const openSubSession = vi.fn(async () => ({ sessionId: 'sub' }));
  fixture.navigate = vi.fn();
  fixture.services = {
    mode: 'server',
    repository: { updateSession: vi.fn(), getSession: vi.fn(async () => null) },
    workspaces: { openSubSession },
    terminals: {},
  };
  const bar = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(bar, container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    bar.remove();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <TopbarSlotContext.Provider value={{ actions: bar, crumbs: null }}>
          <SessionActions
            session={session}
            corrals={[]}
            team={null}
            changes={null}
            panel={undefined}
            onPanel={vi.fn()}
            panelToggle={null}
            onEditTeam={() => true}
            canOpenSubSession={canOpenSubSession}
          />
        </TopbarSlotContext.Provider>
      </IntlProvider>,
    ),
  );
  const trigger = bar.querySelector<HTMLElement>(
    `[aria-label="${messages.Desktop.sessionActions.replace('{title}', 'Login work')}"]`,
  );
  await act(async () => trigger?.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    row.textContent?.startsWith(messages.Sessions.openSubSession),
  );
  return { item, openSubSession };
}

it('opens a sub-session under this one and goes to it', async () => {
  const { item, openSubSession } = await menuItem(true);
  expect(item?.getAttribute('aria-disabled')).not.toBe('true');
  await act(async () => item?.click());
  for (let i = 0; i < 3; i++) await act(async () => {});
  expect(openSubSession).toHaveBeenCalledWith('parent', {
    commandId: 'cmd_fixed',
    title: messages.Sessions.new,
  });
  expect(fixture.navigate).toHaveBeenCalledWith({
    to: '/sessions/$sessionId',
    params: { sessionId: 'sub' },
  });
});

it('is off and says why when the session has no Paddock', async () => {
  const { item, openSubSession } = await menuItem(false);
  expect(item?.getAttribute('aria-disabled')).toBe('true');
  expect(item?.textContent).toContain(messages.Sessions.subSessionNeedsPaddock);
  await act(async () => item?.click());
  expect(openSubSession).not.toHaveBeenCalled();
});
