// @vitest-environment jsdom
import type {
  HarnessEntryView,
  LibraryAgentRole,
  PackageView,
  RoleSkillRef,
} from '@corral/contracts';
import {
  BUILTIN_SKILLS,
  createKeyValueAgentLibrary,
  createKeyValueCorralRepository,
} from '@corral/core';
import { emptyDraft } from '@corral/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import type { StudioServices } from '../../services.tsx';
import { SettingsNavigationContext, standaloneSettingsLink } from '../../workbench/navigation.ts';
import { SkillSettingsPage } from '../harness/ResourceSettingsPage.tsx';
import { LibrarySkills } from './LibrarySkills.tsx';

const api = {
  entries: vi.fn<() => Promise<HarnessEntryView[]>>(),
  packages: vi.fn<() => Promise<PackageView[]>>(),
  trust: vi.fn(async () => {}),
  profileManagement: vi.fn(async () => []),
  resource: vi.fn(async () => ({ files: [] })),
  readEntry: vi.fn(async () => ({
    content: '---\nname: inspect\n---\nRead the evidence.',
    hook: null,
  })),
};
function projectServices() {
  let id = 0;
  const clock = { nowIso: () => '2026-11-10T00:00:00.000Z', monotonicMs: () => 0 };
  const repository = createKeyValueCorralRepository(localStorage, {
    clock,
    newProjectId: () => 'other',
    newCorralId: () => `team_${++id}`,
  });
  const agents = createKeyValueAgentLibrary(localStorage, {
    clock,
    projects: repository,
    newAgentId: () => `agent_${++id}`,
  });
  return { agents, repository, harnesses: api };
}
let services: Pick<StudioServices, 'agents' | 'repository'> & { harnesses: typeof api | null };
vi.mock('../../services.tsx', () => ({ useServices: () => services }));
vi.mock('../SettingsPage.tsx', () => ({
  SettingsLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsTask: () => (task: () => Promise<unknown>) => task(),
}));
vi.mock('../../workbench/harness/SkillQualityPanel.tsx', () => ({ SkillQualityPanel: () => null }));
const fixture = (name: string, resourceHash: string, changes: Partial<HarnessEntryView> = {}) =>
  ({
    kind: 'skill',
    name,
    entry: `skills/${name}/SKILL.md`,
    resourceHash,
    description: `For ${name}`,
    profiles: [],
    successor: null,
    archivedAt: null,
    managementRevision: 1,
    resource: {
      hash: resourceHash,
      trustedAt: null,
      name: 'language-pack',
      sourceKind: 'local',
      sourceLabel: '/home/private/source',
      fileCount: 2,
    },
    ...changes,
  }) as HarnessEntryView;
const projectPackage = (hash: string, status: PackageView['status']) =>
  ({ resource: { hash }, status }) as PackageView;

const cleanups: (() => void)[] = [];
beforeEach(() => {
  services = projectServices();
  policyLink.mockClear();
  api.entries.mockResolvedValue([]);
  api.packages.mockResolvedValue([]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  for (const dispose of cleanups.splice(0)) act(dispose);
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const policyLink = vi.fn((section: string, projectId?: string, _item?: string) =>
  standaloneSettingsLink(section, projectId ? { projectId } : {}),
);
async function show(surface: 'library' | 'settings' = 'settings', projectId?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  const rootRoute = createRootRoute();
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <SettingsNavigationContext.Provider
        value={{
          projects: [],
          ...(surface === 'settings' && projectId ? { projectId } : {}),
          returnTo: '/',
          search: {},
          link: policyLink,
        }}
      >
        {surface === 'settings' ? (
          <SkillSettingsPage />
        ) : (
          <LibrarySkills projectId={projectId ?? 'default'} toolbar={null} />
        )}
      </SettingsNavigationContext.Provider>
    ),
  });
  const destinations = ['/library/agents', '/corrals/$corralId/edit', '/settings/harness'].map(
    (path) => createRoute({ getParentRoute: () => rootRoute, path }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, ...destinations]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RouterProvider router={router} />
      </IntlProvider>,
    );
    await router.load();
  });
  return host;
}
const rows = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLTableRowElement>('tbody tr'), (row) =>
    Array.from(row.cells, (cell) => cell.textContent),
  );
const click = async (host: HTMLElement, label: string) => {
  const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
};
it('lists each skill in a package and hides archived entries until requested, with exactly one state per row', async () => {
  const newer = fixture('Newer', 'new');
  newer.resource.trustedAt = 'now';
  const older = fixture('Older', 'old', { successor: newer });
  older.resource.trustedAt = 'now';
  api.entries.mockResolvedValue([
    ...['Alpha', 'Beta', 'Gamma'].map((n) => fixture(n, 'multi', { successor: newer })),
    fixture('Off', 'off', { successor: newer }),
    fixture('Archived', 'off', { archivedAt: 'now', successor: newer }),
    older,
    newer,
  ]);
  api.packages.mockResolvedValue([
    projectPackage('multi', 'enabled'),
    projectPackage('off', 'disabled'),
    projectPackage('old', 'enabled'),
    projectPackage('new', 'enabled'),
  ]);
  const host = await show();
  expect(rows(host)).toEqual([
    ...['Alpha', 'Beta', 'Gamma'].map((n) => [n, `For ${n}`, 'Needs trust']),
    ['Off', 'For Off', 'Disabled'],
    ['Older', 'For Older', 'New version available'],
    ['Newer', 'For Newer', ''],
  ]);
  await act(async () => host.querySelector<HTMLElement>('[role="switch"]')?.click());
  expect(rows(host)).toContainEqual(['Archived', 'For Archived', 'Archived']);
});
it('walks a successor chain in order, renders the chosen version and its execution policies', async () => {
  const last = fixture('Third', '3');
  const middle = fixture('Second', '2', {
    successor: last,
    profiles: [{ name: 'Review policy', profileId: 'p', revision: 2 }],
  });
  api.entries.mockResolvedValue([middle, last, fixture('First', '1', { successor: middle })]);
  const host = await show();
  await click(host, 'Second');
  expect(host.textContent).toContain('Version 2');
  expect(host.textContent).toContain('Execution policies');
  expect(host.textContent).toContain('Review policy');
  expect(host.textContent).toContain('Read the evidence.');
  expect(host.querySelector('details')?.open).toBe(false);
  expect(host.querySelector('details')?.textContent).toContain('language-pack');
  expect(host.textContent).not.toContain('/home/private');
  await click(host, 'Previous version');
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe('First');
  await click(host, 'Next version');
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Second');
});
it('retries a failed package lookup rather than showing an empty or usable list', async () => {
  api.entries.mockResolvedValue([fixture('Review', 'r')]);
  api.packages
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([projectPackage('r', 'disabled')]);
  const host = await show();
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  expect(host.textContent).not.toContain(messages.Resources.emptySkills);
  await click(host, 'Try again');
  expect(rows(host)).toEqual([['Review', 'For Review', 'Disabled']]);
});
it('shows only local-server availability without a harness service', async () => {
  services.harnesses = null;
  expect((await show()).textContent).toBe(messages.Library.resources.localOnly);
});

// builtin-crew.md, 1: a bundled skill's source is its pack, not an imported copy.
it('names the bundled pack as the source of a bundled skill', async () => {
  const bundled = BUILTIN_SKILLS.find((skill) => skill.pack === 'core');
  if (!bundled) throw new Error('missing the core pack');
  const builtin = fixture(bundled.name, bundled.resourceHash, { entry: bundled.entry });
  builtin.resource.name = '@corral/builtin-core';
  builtin.resource.sourceLabel = 'Corral 1.1.0';
  const copy = fixture(bundled.name, 'c'.repeat(64));
  api.entries.mockResolvedValue([builtin, copy]);
  const host = await show('library');
  const sources = Array.from(host.querySelectorAll('tbody tr td:first-child small'), (small) =>
    small.textContent?.trim(),
  );
  expect(sources).toEqual([
    `@corral/builtin-core · ${messages.Resources.builtinPacks.core}`,
    `language-pack · ${messages.Resources.importedCopy}`,
  ]);
});

it('searches names, descriptions and package names, with a distinct no-matches result', async () => {
  const first = fixture('Alpha', 'a', { description: 'Review images' });
  const second = fixture('Beta', 'b');
  second.resource.name = 'copy-edit';
  api.entries.mockResolvedValue([first, second]);
  const host = await show();
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Search skills"]');
  const search = async (query: string) => {
    if (!field) throw new Error('Missing search');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, query);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return rows(host).map((row) => row[0]);
  };
  expect(await search('alph')).toEqual(['Alpha']);
  expect(await search('IMAGES')).toEqual(['Alpha']);
  expect(await search('copy-edit')).toEqual(['Beta']);
  expect(await search('missing')).toEqual([]);
  expect(host.textContent).toContain(messages.Resources.noMatches);
  expect(host.textContent).not.toContain(messages.Resources.emptySkills);
});

const roleWith = (name: string, skills?: RoleSkillRef[]): LibraryAgentRole => ({
  name,
  prompt: 'Read the source.',
  modelProfile: 'model-a',
  allowedWorkTools: [],
  allowedCollaborationTools: [],
  outputContract: 'text',
  ...(skills ? { skills } : {}),
});
async function original(name: string, skills?: RoleSkillRef[], projectId = 'default') {
  const result = await services.agents.create(projectId, {
    operationId: `create_${name}`,
    role: roleWith(name, skills),
  });
  if (!result.ok) throw new Error(result.message);
  return result.agent;
}
async function savedTeam(name: string, roles: LibraryAgentRole[], projectId = 'default') {
  const { definition } = emptyDraft('untitled', name);
  definition.roles = roles.map((role, index) => ({ ...role, id: `role_${index}` }));
  const result = await services.repository.save({
    projectId,
    expectedDefinitionRevision: null,
    definition,
  });
  if (!result.ok) throw new Error(result.message);
  return result.record;
}
function usageGroup(host: HTMLElement, name: string) {
  const group = host.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
  if (!group) throw new Error(`Missing usage group: ${name}`);
  return group;
}
const groupLinks = (group: HTMLElement) =>
  [...group.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')]);

it.each(['library', 'settings'] as const)(
  '%s usage links only exact, directly selected entries in current project records',
  async (surface) => {
    const oldRef = { resourceHash: 'a'.repeat(64), entry: 'skills/review/SKILL.md' };
    const nextRef = { ...oldRef, resourceHash: 'b'.repeat(64) };
    const sibling = { ...oldRef, entry: 'skills/different/SKILL.md' };
    const newest = fixture('Revised', nextRef.resourceHash, { entry: nextRef.entry });
    api.entries.mockResolvedValue([
      fixture('Review', oldRef.resourceHash, {
        entry: oldRef.entry,
        successor: newest,
        profiles: [{ profileId: 'policy', revision: 2, name: 'Review policy' }],
      }),
      newest,
    ]);
    await services.repository.createProject({ name: 'Other' });
    const writer = await original('Writer', [oldRef]);
    await original('Sibling', [sibling]);
    await original('Inherited');
    await original('Foreign', [oldRef], 'other');
    const team = await savedTeam('Digest', [roleWith('A', [oldRef]), roleWith('B', [oldRef])]);
    const changed = await savedTeam('Revised team', [roleWith('A', [oldRef])]);
    const updated = await services.repository.save({
      expectedDefinitionRevision: changed.definitionRevision,
      definition: { ...changed.definition, roles: [{ ...roleWith('A', [nextRef]), id: 'role_0' }] },
    });
    if (!updated.ok) throw new Error(updated.message);
    await savedTeam('Other entry', [roleWith('A', [sibling])]);
    const foreign = await savedTeam('Foreign team', [roleWith('A', [oldRef])], 'other');
    const agents = vi.spyOn(services.agents, 'list');
    const get = vi.spyOn(services.repository, 'get');
    const host = await show(surface, 'default');
    await click(host, 'Review');
    expect(groupLinks(usageGroup(host, 'Agent originals'))).toEqual([
      ['Writer', `/library/agents?project=default&agent=${writer.agentId}`],
    ]);
    expect(groupLinks(usageGroup(host, 'Saved teams'))).toEqual([
      ['Digest', `/corrals/${team.corralId}/edit`],
    ]);
    expect(groupLinks(usageGroup(host, 'Execution policies'))).toEqual([
      ['Review policy · r2', '/settings/harness?projectId=default'],
    ]);
    expect(policyLink).toHaveBeenCalledWith('harness', 'default', 'policy:2');
    expect(host.textContent).not.toContain('Connect in Harnesses');
    await click(host, 'Next version');
    expect(usageGroup(host, 'Agent originals').textContent).toContain(
      'No agent originals use this version.',
    );
    expect(groupLinks(usageGroup(host, 'Saved teams'))).toEqual([
      ['Revised team', `/corrals/${changed.corralId}/edit`],
    ]);
    expect(usageGroup(host, 'Execution policies').textContent).toContain(
      messages.Resources.noPolicies,
    );
    expect(agents.mock.calls).toEqual([['default']]);
    expect(get).not.toHaveBeenCalledWith(foreign.corralId);
  },
);

it('recovers failed usage groups independently without reporting pending or unreadable records as empty', async () => {
  const ref = { resourceHash: 'c'.repeat(64), entry: 'skills/test/SKILL.md' };
  api.entries.mockResolvedValue([fixture('Test', ref.resourceHash, { entry: ref.entry })]);
  const team = await savedTeam('Weekly', [roleWith('Reader', [ref])]);
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const agents = vi.spyOn(services.agents, 'list').mockReturnValueOnce(pending);
  const get = vi.spyOn(services.repository, 'get').mockResolvedValueOnce(null);
  const host = await show('library', 'default');
  await click(host, 'Test');
  const originals = usageGroup(host, 'Agent originals'),
    teams = usageGroup(host, 'Saved teams');
  expect(originals.querySelector('[role="status"]')).not.toBeNull();
  expect(originals.textContent).not.toContain('No agent originals');
  expect(teams.querySelector('[role="alert"]')).not.toBeNull();
  expect(teams.textContent).not.toContain('No saved teams');
  expect(usageGroup(host, 'Execution policies').textContent).toContain(
    messages.Resources.noPolicies,
  );
  await click(teams, 'Try again');
  expect(groupLinks(teams)).toEqual([['Weekly', `/corrals/${team.corralId}/edit`]]);
  expect(agents).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('offline')));
  expect(originals.querySelector('[role="alert"]')).not.toBeNull();
  expect(originals.textContent).not.toContain('No agent originals');
  await click(originals, 'Try again');
  expect(originals.textContent).toContain('No agent originals use this version.');
  expect(get).toHaveBeenCalledTimes(2);
});

it('retries execution policy usage without reloading the catalog, originals, or teams', async () => {
  const ref = { resourceHash: 'd'.repeat(64), entry: 'skills/notes/SKILL.md' };
  const newer = fixture('Revised', 'e'.repeat(64), { entry: ref.entry });
  const selected = fixture('Notes', ref.resourceHash, {
    entry: ref.entry,
    successor: newer,
    profiles: [{ profileId: 'old', revision: 1, name: 'Outdated policy' }],
  });
  let reject!: (error: Error) => void;
  const pending = new Promise<HarnessEntryView[]>((_, fail) => {
    reject = fail;
  });
  api.entries
    .mockClear()
    .mockResolvedValueOnce([selected, newer])
    .mockReturnValueOnce(pending)
    .mockResolvedValue([
      { ...selected, profiles: [{ profileId: 'fresh', revision: 3, name: 'Notes policy' }] },
      newer,
      fixture('Other path', ref.resourceHash, {
        profiles: [{ profileId: 'other', revision: 1, name: 'Wrong policy' }],
      }),
    ]);
  api.packages.mockClear();
  await original('Reporter', [ref]);
  await savedTeam('Bulletin', [roleWith('Writer', [ref])]);
  const agents = vi.spyOn(services.agents, 'list');
  const teams = vi.spyOn(services.repository, 'list');
  const host = await show('library', 'default');
  await click(host, 'Notes');
  const policies = usageGroup(host, 'Execution policies');
  expect(policies.querySelector('[role="status"]')).not.toBeNull();
  expect(policies.textContent).not.toContain('Outdated policy');
  await act(async () => reject(new Error('offline')));
  expect(policies.querySelector('[role="alert"]')).not.toBeNull();
  expect(policies.textContent).not.toContain(messages.Resources.noPolicies);
  expect(usageGroup(host, 'Agent originals').textContent).toContain('Reporter');
  expect(usageGroup(host, 'Saved teams').textContent).toContain('Bulletin');
  await click(policies, 'Try again');
  expect(groupLinks(policies)).toEqual([
    ['Notes policy · r3', '/settings/harness?projectId=default'],
  ]);
  expect(policyLink).toHaveBeenCalledWith('harness', 'default', 'fresh:3');
  await click(host, 'Next version');
  expect(policies.textContent).toContain(messages.Resources.noPolicies);
  expect(api.entries).toHaveBeenCalledTimes(3);
  expect(api.packages).toHaveBeenCalledTimes(1);
  expect(agents).toHaveBeenCalledTimes(1);
  expect(teams).toHaveBeenCalledTimes(1);
});

it('invalidates open roles after trust changes, but not after a refused change', async () => {
  const item = fixture('Review', 'r');
  api.entries.mockResolvedValue([item]);
  api.trust.mockRejectedValueOnce(Error('offline'));
  const host = await show('settings', 'default');
  const changed = vi.fn();
  window.addEventListener('corral:harness-changed', changed);
  try {
    await click(host, 'Review');
    await click(host, 'Trust for use');
    expect(changed).not.toHaveBeenCalled();
    await click(host, 'Trust for use');
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener('corral:harness-changed', changed);
  }
});
