// @vitest-environment jsdom
import type { ProjectSummary } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ProjectsPage } from './ProjectsPage.tsx';

const project = (projectId: string, name: string, change: Partial<ProjectSummary> = {}) =>
  ({
    projectId,
    name,
    description: '',
    revision: 3,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    archivedAt: null,
    ...change,
  }) as ProjectSummary;

const fixture = vi.hoisted(() => ({
  hash: '',
  data: { projects: [] as ProjectSummary[], corrals: [], runs: [] },
  navigate: vi.fn(),
  invalidate: vi.fn(async () => {}),
  services: {} as Record<string, unknown>,
}));
vi.mock('../router.tsx', () => ({
  projectsRoute: { useLoaderData: () => fixture.data },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#project">{children}</a>,
  useNavigate: () => fixture.navigate,
  useRouter: () => ({ invalidate: fixture.invalidate }),
  useRouterState: ({ select }: { select: (state: { location: { hash: string } }) => unknown }) =>
    select({ location: { hash: fixture.hash } }),
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
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
  fixture.hash = '';
  fixture.navigate.mockReset();
  fixture.invalidate.mockClear();
  fixture.data = {
    projects: [
      project('default', 'My project'),
      project('project_b', 'Billing service'),
      project('project_c', 'Old notes', { archivedAt: '2026-11-09T00:00:00.000Z' }),
    ],
    corrals: [],
    runs: [],
  };
  fixture.services = {
    mode: 'browser',
    workspaces: null,
    repository: {
      createProject: vi.fn(async () => ({ ok: true, project: project('project_new', 'New') })),
      updateProject: vi.fn(async () => ({ ok: true })),
    },
  };
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function show(hash = '') {
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
  await settle();
  return container;
}

/** The new-project form, wherever its dialog is portaled. */
const form = () =>
  document.querySelector<HTMLFormElement>(`form[aria-label="${messages.Projects.new}"]`);
const nameField = () =>
  [...(form()?.querySelectorAll<HTMLInputElement>('input') ?? [])].find(
    (input) => document.querySelector(`label[for="${input.id}"]`)?.textContent === 'Name',
  ) ??
  form()?.querySelector<HTMLInputElement>('input') ??
  null;
const button = (scope: ParentNode, name: string) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const type = (control: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });

it('lists the projects first, as a table, with one New project action and no form', async () => {
  const container = await show();
  expect(container.querySelector('h1')?.textContent).toBe(messages.Projects.heading);
  expect(form()).toBeNull();
  expect(container.textContent).not.toContain(messages.Projects.intro);
  const rows = [...container.querySelectorAll('table tbody tr')];
  expect(rows.map((row) => row.querySelector('a')?.textContent)).toEqual([
    'My project',
    'Billing service',
  ]);
  // The default project cannot be archived; the others can.
  expect(rows[0]?.querySelector('button')).toBeNull();
  expect(rows[1]?.querySelector('button')?.getAttribute('aria-label')).toBe(
    `${messages.Projects.archive}: Billing service`,
  );
  expect(button(container, messages.Projects.new).textContent).toBe(messages.Projects.new);
});

it('New project opens a dialog holding the form, its name focused', async () => {
  const container = await show();
  await act(async () => button(container, messages.Projects.new).click());
  await settle();
  expect(form()).not.toBeNull();
  expect(document.activeElement).toBe(nameField());
});

it('creates the project with the same repository call and opens it', async () => {
  const container = await show();
  await act(async () => button(container, messages.Projects.new).click());
  await settle();
  const inputs = [...(form()?.querySelectorAll<HTMLInputElement>('input') ?? [])];
  await type(inputs[0] as HTMLInputElement, 'Client A');
  await type(inputs[1] as HTMLInputElement, 'Billing for client A');
  await act(async () => form()?.requestSubmit());
  await settle();
  const repository = fixture.services.repository as Record<string, ReturnType<typeof vi.fn>>;
  expect(repository.createProject).toHaveBeenCalledTimes(1);
  expect(repository.createProject).toHaveBeenCalledWith({
    name: 'Client A',
    description: 'Billing for client A',
  });
  expect(fixture.navigate).toHaveBeenCalledWith({
    to: '/projects/$projectId',
    params: { projectId: 'project_new' },
  });
});

it('keeps what was typed when the dialog is closed by accident, and returns focus to New project', async () => {
  const container = await show();
  const trigger = button(container, messages.Projects.new);
  await act(async () => trigger.click());
  await settle();
  await type(nameField() as HTMLInputElement, 'Half typed');
  expect(document.activeElement).toBe(nameField());
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  // The popup leaves once its exit animation's fallback timer runs.
  await act(async () => vi.waitFor(() => expect(form()).toBeNull(), { timeout: 3000 }));
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  await settle();
  expect(nameField()?.value).toBe('Half typed');
});

it('archives and restores a project with its revision, as before', async () => {
  const container = await show();
  const repository = fixture.services.repository as Record<string, ReturnType<typeof vi.fn>>;
  await act(async () => button(container, `${messages.Projects.archive}: Billing service`).click());
  await settle();
  expect(repository.updateProject).toHaveBeenLastCalledWith('project_b', {
    archived: true,
    expectedRevision: 3,
  });
  await act(async () => button(container, 'Show archived (1)').click());
  await act(async () => button(container, `${messages.Projects.restore}: Old notes`).click());
  await settle();
  expect(repository.updateProject).toHaveBeenLastCalledWith('project_c', {
    archived: false,
    expectedRevision: 3,
  });
  expect(fixture.invalidate).toHaveBeenCalled();
});

it('opens the dialog at its name when reached from New project in the sidebar menu', async () => {
  await show('new-project');
  expect(form()?.id).toBe('new-project');
  expect(nameField()).not.toBeNull();
  expect(document.activeElement).toBe(nameField());
});

it('leaves the dialog closed when the projects page opens without the hash', async () => {
  await show('');
  expect(form()).toBeNull();
});
