// @vitest-environment jsdom
import type { ProjectSummary, WorkSession } from '@corral/core';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import { Palette } from './CommandPalette.tsx';

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(async (_to: unknown) => {}),
  mode: 'server' as 'server' | 'browser',
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => fixture.navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/', search: {}, href: '/' } }),
}));
vi.mock('./desktop.tsx', () => ({ desktop: null }));
// One services object per mode, as the app keeps one for its whole life.
const services = vi.hoisted(() => {
  const make = (mode: 'server' | 'browser') => ({
    mode,
    repository: {
      list: async () => [],
      listProjects: async () => [],
      listSessions: async () => [],
    },
    transport: { listRuns: async () => [], getRunDefinition: async () => null },
  });
  return { server: make('server'), browser: make('browser') };
});
vi.mock('./services.tsx', () => ({ useServices: () => services[fixture.mode] }));

const createdAt = '2026-11-01T00:00:00.000Z';
const project = (projectId: string, name: string): ProjectSummary => ({
  projectId,
  name,
  description: '',
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
});
const session = (sessionId: string, projectId: string, title: string, objective = '') =>
  ({
    sessionId,
    projectId,
    corralId: null,
    auto: null,
    title,
    objective,
    pinned: false,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    autoStart: true,
    entries: [],
  }) as WorkSession;
const projects = [project('alpha', 'Alpha'), project('beta', 'Beta')];
const sessions = [
  session('here', 'alpha', 'Release checklist'),
  session('there', 'beta', 'Survey notes', 'moonstone survey of the north wing'),
];

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  fixture.navigate.mockClear();
  fixture.mode = 'server';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function mount(props: Partial<ComponentProps<typeof Palette>> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Palette
          onClose={() => {}}
          onHelp={() => {}}
          sessions={sessions}
          projects={projects}
          projectId="alpha"
          {...props}
        />
      </IntlProvider>,
    );
  });
  return container;
}

const options = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
    option.textContent?.trim(),
  );
const scopeButton = (container: HTMLElement, name: string) => {
  const group = container.querySelector('fieldset[aria-label="Find conversations in"]');
  const button = [...(group?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (item) => item.textContent === name,
  );
  if (!button) throw new Error(`Missing scope ${name}`);
  return button;
};

it('searches the current project first and finds another project’s session by purpose in all projects', async () => {
  const container = await mount({ mode: 'sessions', initialQuery: 'moonstone' });
  const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
  expect(input?.value).toBe('moonstone');
  expect(scopeButton(container, 'Alpha').getAttribute('aria-pressed')).toBe('true');
  expect(options(container).some((text) => text?.includes('Survey notes'))).toBe(false);
  await act(async () => scopeButton(container, 'All projects').click());
  expect(scopeButton(container, 'All projects').getAttribute('aria-pressed')).toBe('true');
  const found = options(container).find((text) => text?.includes('Survey notes'));
  expect(found).toContain('Beta');
  // Session search lists sessions only, never the palette's other commands.
  expect(options(container).some((text) => text?.includes('Open all projects'))).toBe(false);
});

it('starts on all projects outside a project', async () => {
  const container = await mount({ mode: 'sessions', initialQuery: 'survey', projectId: undefined });
  expect(scopeButton(container, 'All projects').getAttribute('aria-pressed')).toBe('true');
  expect(options(container).some((text) => text?.includes('Survey notes'))).toBe(true);
});

it('continues the same query into message and result search in server mode only', async () => {
  const container = await mount({ mode: 'sessions', initialQuery: 'north wing' });
  const searched: unknown[] = [];
  const listen = (event: Event) => searched.push((event as CustomEvent).detail);
  window.addEventListener('corral:search-sessions', listen);
  try {
    const action = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes('Search messages and results'),
    );
    if (!action) throw new Error('Missing message search');
    await act(async () => {
      action.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(searched).toEqual(['north wing']);
  } finally {
    window.removeEventListener('corral:search-sessions', listen);
  }
  fixture.mode = 'browser';
  const browser = await mount({ mode: 'sessions', initialQuery: 'north wing' });
  expect(options(browser).some((text) => text?.includes('Search messages and results'))).toBe(
    false,
  );
});

it('goes to Needs you, Library, Automation and feature previews, and starts a meeting here', async () => {
  const container = await mount();
  const titles = options(container);
  for (const title of ['Needs you', 'Library', 'Automation', 'Feature previews'])
    expect(titles).toContain(title);
  expect(titles).toContain('New meeting in Alpha');
  const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!input) throw new Error('Missing palette input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'needs you',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(fixture.navigate).toHaveBeenCalledWith({ to: '/inbox' });
  const meetings: unknown[] = [];
  const listen = (event: Event) => meetings.push((event as CustomEvent).detail);
  window.addEventListener('corral:new-meeting', listen);
  try {
    const again = await mount();
    const row = [...again.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.trim() === 'New meeting in Alpha',
    );
    if (!row) throw new Error('Missing New meeting');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(meetings).toEqual(['alpha']);
  } finally {
    window.removeEventListener('corral:new-meeting', listen);
  }
});
