// @vitest-environment jsdom
import type { HarnessEntryView } from '@corral/contracts';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SkillSettingsPage } from './ResourceSettingsPage.tsx';

const SKILL = {
  kind: 'skill',
  resourceHash: 'h1',
  entry: 'skills/SKILL.md',
  name: 'Review',
  description: '',
  profiles: [],
  resource: {
    name: 'Review',
    trustedAt: '2026-11-11T00:00:00.000Z',
    sourceLabel: 'Created in Corral',
    sourceKind: 'local',
    version: 'v1',
  },
} as unknown as HarnessEntryView;
let library: HarnessEntryView[] = [];
const pending = () => new Promise<never>(() => {});
const api = {
  entries: vi.fn(async () => library),
  readEntry: vi.fn(pending),
  resource: vi.fn(pending),
};
vi.mock('../services.tsx', () => ({ useServices: () => ({ harnesses: api }) }));
vi.mock('./SettingsPage.tsx', () => ({
  SettingsLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('../workbench/navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsTask: () => (action: () => Promise<unknown>) => action(),
}));
vi.mock('../workbench/harness/ConfirmAction.tsx', () => ({
  useManagementConfirmation: () => ({ request: () => {}, dialog: null }),
}));
// The editor saves the one skill the library then lists.
vi.mock('../workbench/harness/ResourceEditor.tsx', () => ({
  ResourceEditor: ({ onSaved }: { onSaved: (hash: string, entry?: string) => void }) => (
    <button type="button" onClick={() => onSaved('h1', 'skills/SKILL.md')}>
      Save skill
    </button>
  ),
}));
vi.mock('../workbench/harness/SkillQualityPanel.tsx', () => ({ SkillQualityPanel: () => null }));
vi.mock('../workbench/harness/PackageManager.tsx', () => ({ PackageManager: () => null }));

const cleanup: (() => void)[] = [];
beforeEach(() => {
  library = [];
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
        <SkillSettingsPage />
      </IntlProvider>,
    ),
  );
  return container;
}
const adds = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].filter(
    (button) => button.textContent === messages.Resources.add,
  );

it('lets the empty library carry its Add, with no button row of its own above it', async () => {
  const container = await open();
  const empty = container.querySelector('[data-slot="empty-view"]');
  expect(empty?.textContent).toContain(messages.Resources.emptySkills);
  expect(adds(container)).toHaveLength(1);
  expect(empty?.contains(adds(container)[0] as Node)).toBe(true);
});

it('moves focus to the Add above the list once the first saved skill replaces the empty state', async () => {
  const container = await open();
  await act(async () => adds(container)[0]?.click());
  library = [SKILL];
  const save = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Save skill',
  );
  await act(async () => save?.click());
  expect(container.querySelector('[data-slot="empty-view"]')).toBeNull();
  expect(adds(container)).toHaveLength(1);
  expect(document.activeElement).toBe(adds(container)[0]);
});
