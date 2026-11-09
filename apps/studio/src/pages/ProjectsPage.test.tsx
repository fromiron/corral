// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ProjectsPage } from './ProjectsPage.tsx';

const fixture = vi.hoisted(() => ({ hash: '' }));
vi.mock('../router.tsx', () => ({
  projectsRoute: { useLoaderData: () => ({ projects: [], corrals: [], runs: [] }) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#project">{children}</a>,
  useNavigate: () => vi.fn(),
  useRouter: () => ({ invalidate: vi.fn(async () => {}) }),
  useRouterState: ({ select }: { select: (state: { location: { hash: string } }) => unknown }) =>
    select({ location: { hash: fixture.hash } }),
}));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ repository: {}, workspaces: null, mode: 'browser' }),
}));
vi.mock('../projects.ts', () => ({
  projectName: (project: { name: string }) => project.name,
  projectOfRun: () => null,
  projectsChanged() {},
  useCurrentProject: () => null,
}));
vi.mock('../desktop.tsx', () => ({ desktop: null }));

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.getAnimations ??= () => [];
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function show(hash: string) {
  fixture.hash = hash;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ProjectsPage />
      </IntlProvider>,
    ),
  );
  const form = container.querySelector(`form[aria-label="${messages.Projects.new}"]`);
  return { form, name: form?.querySelector('input') ?? null };
}

it('focuses the new-project name when opened from New project', async () => {
  const { form, name } = await show('new-project');
  expect(form?.id).toBe('new-project');
  expect(name).not.toBeNull();
  expect(document.activeElement).toBe(name);
});

it('leaves focus alone when the projects page opens without the hash', async () => {
  const { name } = await show('');
  expect(name).not.toBeNull();
  expect(document.activeElement).not.toBe(name);
});
