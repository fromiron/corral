// @vitest-environment jsdom
import type { ProjectToolConfigRevision } from '@corral/contracts';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { McpSettingsPage } from './McpSettingsPage.tsx';

const config = (mcpServers: ProjectToolConfigRevision['mcpServers']) =>
  ({
    projectId: 'p1',
    revision: mcpServers?.length ? 2 : 1,
    hash: 'a'.repeat(64),
    createdAt: '2026-11-11T00:00:00.000Z',
    checks: [],
    lspServers: [],
    mcpServers,
  }) as ProjectToolConfigRevision;
const SAVED = config([
  {
    id: 'docs',
    name: 'Docs',
    timeoutMs: 30_000,
    exposure: 'direct',
    transport: 'stdio',
    argv: ['docs-mcp'],
  },
]);
const api = {
  projectTools: vi.fn(async () => config([])),
  mcpHistory: vi.fn(async () => []),
  mcpUsages: vi.fn(async () => []),
};
vi.mock('../services.tsx', () => ({ useServices: () => ({ harnesses: api }) }));
vi.mock('./SettingsPage.tsx', () => ({
  SettingsLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('../workbench/navigation.ts', () => ({
  useSettingsNavigation: () => ({ projectId: 'p1', link: () => ({ to: '/' }) }),
}));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsTask: () => (action: () => Promise<unknown>) => action(),
}));
vi.mock('../workbench/harness/ConfirmAction.tsx', () => ({
  useManagementConfirmation: () => ({ request: () => {}, dialog: null }),
}));
// The editor saves the one server the page then lists.
vi.mock('../workbench/harness/McpEditor.tsx', () => ({
  mcpDraft: () => ({}),
  McpEditor: ({ onSaved }: { onSaved: (saved: ProjectToolConfigRevision) => void }) => (
    <button type="button" onClick={() => onSaved(SAVED)}>
      Save server
    </button>
  ),
}));
vi.mock('./McpConnection.tsx', () => ({ McpConnection: () => null }));

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

async function open() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <McpSettingsPage />
      </IntlProvider>,
    ),
  );
  return container;
}
const adds = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].filter(
    (button) => button.textContent === messages.Resources.add,
  );

it('lets the empty server list carry its Add, with no button row of its own above it', async () => {
  const container = await open();
  const empty = container.querySelector('[data-slot="empty-view"]');
  expect(empty?.textContent).toContain(messages.Resources.emptyMcp);
  expect(adds(container)).toHaveLength(1);
  expect(empty?.contains(adds(container)[0] as Node)).toBe(true);
});

it('moves focus to the Add above the list once the first saved server replaces the empty state', async () => {
  const container = await open();
  await act(async () => adds(container)[0]?.click());
  api.projectTools.mockResolvedValue(SAVED);
  const save = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Save server',
  );
  await act(async () => save?.click());
  expect(container.querySelector('[data-slot="empty-view"]')).toBeNull();
  expect(adds(container)).toHaveLength(1);
  expect(document.activeElement).toBe(adds(container)[0]);
});
