// @vitest-environment jsdom
import type { ProjectSummary, WorkSession } from '@corral/core';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { createTranslator, IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { Palette } from './CommandPalette.tsx';
import { setCommands } from './commandRegistry.ts';
import { composerCommands } from './workbench/session/composer/commands.ts';

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
      save: vi.fn(async () => ({ ok: false, message: 'Must not save on entry' })),
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
  services.server.repository.save.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function mount(
  props: Partial<ComponentProps<typeof Palette>> = {},
  { locale, catalogue }: { locale: 'en' | 'ko'; catalogue: typeof messages } = {
    locale: 'en',
    catalogue: messages,
  },
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale={locale} messages={catalogue} timeZone="UTC">
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

it('opens a conversation it finds with neither panel nor compose, so the conversation restores its panel', async () => {
  const container = await mount({ mode: 'sessions', initialQuery: 'Release checklist' });
  const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!input) throw new Error('Missing palette input');
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(fixture.navigate).toHaveBeenCalledWith({
    to: '/sessions/$sessionId',
    params: { sessionId: 'here' },
  });
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

it.each([
  ['New empty Corral', {}],
  ['New Corral from template: Bug fix', { template: 'bug-fix' }],
  ['Draft a Corral from a goal', { assistant: 1 }],
] as const)('opens the unsaved editor for “%s” without writing a team', async (label, search) => {
  const container = await mount({ initialQuery: label });
  const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (row) => row.textContent === label,
  );
  expect(option).toBeTruthy();
  await act(async () => {
    option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  expect(services.server.repository.save).not.toHaveBeenCalled();
  expect(fixture.navigate).toHaveBeenCalledWith({
    to: '/corrals/new/edit',
    search: { project: 'alpha', ...search },
  });
});

it('omits unsaved team actions for an archived project', async () => {
  const container = await mount({
    projects: [{ ...project('alpha', 'Alpha'), archivedAt: createdAt }],
  });
  const labels = options(container);
  expect(labels).not.toContain(messages.CommandPalette.newBlank);
  expect(labels).not.toContain(messages.CommandPalette.draftTeam);
  expect(labels.some((label) => label?.startsWith('New Corral from template:'))).toBe(false);
});

// glossary.md: the whole-run stop is named Stop the run / 실행 중지; the word it had before still
// finds it, in either language.
it.each([
  ['en', messages],
  ['ko', ko],
] as const)(
  'finds the run’s stop by “stop”, “중지” and “취소” in %s',
  async (locale, catalogue) => {
    const say = (namespace: string) => {
      const t = createTranslator({ locale, messages: catalogue, namespace: namespace as never });
      return (key: string, values?: Record<string, string | number>) =>
        (t as unknown as (key: string, values?: Record<string, string | number>) => string)(
          key,
          values,
        );
    };
    // The commands the composer registers while a conversation is open.
    setCommands(
      'composer',
      composerCommands({
        t: say('Sessions'),
        tc: say('Composer'),
        tr: say('Reins'),
        tStatus: say('RunStatus'),
        available: { queue: true, join: false, interrupt: false },
        ownActive: null,
        corrals: [],
        chooseIntent: () => {},
        focus: () => {},
        run: () => {},
        compact: () => {},
        autocompaction: () => {},
        requestStop: () => {},
        openTeam: () => {},
        openModels: () => {},
      }),
    );
    try {
      const stop = catalogue.Reins.cancelRun;
      for (const query of ['stop', '중지', '취소']) {
        const container = await mount({}, { locale, catalogue });
        const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
        if (!input) throw new Error('Missing palette input');
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            input,
            query,
          );
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        // Each row's title, without the hint or slash beside it.
        const titles = [...container.querySelectorAll('[role="option"] span.block')].map((title) =>
          title.textContent?.trim(),
        );
        expect(titles, query).toContain(stop);
      }
    } finally {
      setCommands('composer', null);
    }
  },
);

// workbench.md 대화 찾기: with nothing typed, the conversations this device used last come first,
// by when each was last entered here or last changed, whichever is later.
it('lists the conversations used last on this device first while nothing is typed', async () => {
  const { writeSeenMemory } = await import('./workbench/panel/memory.ts');
  const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const used = [
    { ...session('a', 'alpha', 'Changed lately'), updatedAt: at(20) },
    { ...session('b', 'alpha', 'Opened lately'), updatedAt: at(2), pinned: true },
    { ...session('c', 'alpha', 'Quiet and pinned'), updatedAt: at(1), pinned: true },
  ];
  window.localStorage.clear();
  writeSeenMemory(window.localStorage, 'b', { openedAt: at(24) });
  writeSeenMemory(window.localStorage, 'a', { openedAt: at(3) });
  const container = await mount({ mode: 'sessions', sessions: used });
  const titles = options(container)
    .map((text) => text?.split(' ')[0])
    .filter((word) => word === 'Opened' || word === 'Changed' || word === 'Quiet');
  expect(titles).toEqual(['Opened', 'Changed', 'Quiet']);
  window.localStorage.clear();
});
