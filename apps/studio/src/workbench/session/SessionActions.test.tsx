// @vitest-environment jsdom
import type { CorralSummary, WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TopbarSlotContext } from '../TopbarSlot.tsx';
import { SessionActions } from './SessionActions.tsx';

vi.mock('../../services.tsx', () => ({
  useServices: () => ({ repository: { updateSession: vi.fn() }, mode: 'server' }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ invalidate: vi.fn(async () => {}) }),
}));
vi.mock('../ChatView.tsx', () => ({ ChatDensityMenu: () => null }));

Element.prototype.getAnimations ??= () => [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const team: CorralSummary = {
  corralId: 'team_brief',
  projectId: 'project',
  name: 'Research brief',
  definitionRevision: 3,
  nodeCount: 2,
  updatedAt: '2026-11-10T00:00:00.000Z',
};
const session = {
  sessionId: 'session',
  projectId: 'project',
  title: 'Brief',
  corralId: 'team_brief',
  revision: 1,
  pinned: false,
  archivedAt: null,
  entries: [],
} as unknown as WorkSession;

it("leaves the team's name and revision to the session menu, not the top bar", async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
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
        <TopbarSlotContext.Provider value={{ actions: bar, views: null, crumbs: null }}>
          <SessionActions
            session={session}
            corrals={[team]}
            team={team}
            changes={null}
            panel={undefined}
            onPanel={vi.fn()}
            fileViewerOpen={false}
            onToggleFileViewer={vi.fn()}
            onEditTeam={() => true}
          />
        </TopbarSlotContext.Provider>
      </IntlProvider>,
    ),
  );
  expect(bar.textContent).not.toContain('Research brief');
  expect(bar.textContent).not.toContain('r3');
  const menu = bar.querySelector<HTMLElement>(
    `[aria-label="${messages.Desktop.sessionActions.replace('{title}', 'Brief')}"]`,
  );
  expect(menu).not.toBeNull();
  await act(async () => menu?.click());
  const line = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    row.textContent?.startsWith(messages.Sessions.chooseTeam),
  );
  expect(line?.textContent).toContain('Research brief · r3');
});
