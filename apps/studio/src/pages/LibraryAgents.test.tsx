// @vitest-environment jsdom
import type { HarnessEntryView, LibraryAgent, LibraryAgentRole } from '@corral/contracts';
import {
  type AgentLibrary,
  createKeyValueAgentLibrary,
  createKeyValueCorralRepository,
} from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { LibraryAgents } from './LibraryAgents.tsx';

function library() {
  let id = 0;
  const clock = { nowIso: () => '2026-11-10T00:00:00.000Z', monotonicMs: () => 0 };
  const projects = createKeyValueCorralRepository(localStorage, {
    clock,
    newCorralId: () => 'team',
  });
  return createKeyValueAgentLibrary(localStorage, {
    clock,
    projects,
    newAgentId: () => `agent_${++id}`,
  });
}
let agents: AgentLibrary;
let harnesses: { entries: () => Promise<HarnessEntryView[]> } | null;
vi.mock('../services.tsx', () => ({ useServices: () => ({ agents, harnesses, mode: 'browser' }) }));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
const role: LibraryAgentRole = {
  name: 'Writer',
  prompt: 'Write a summary.\nCite the field notes.',
  modelProfile: 'model-a',
  allowedCollaborationTools: ['submit_result'],
  allowedWorkTools: ['write_artifact'],
  outputContract: 'text',
};
async function seed(name = 'Writer', changes: Partial<LibraryAgentRole> = {}) {
  const result = await agents.create('default', {
    operationId: `seed_${name}`,
    role: { ...role, name, ...changes },
  });
  if (!result.ok) throw new Error(result.message);
  return result.agent;
}
const cleanups: (() => void)[] = [];
beforeEach(() => {
  agents = library();
  harnesses = null;
  Element.prototype.getAnimations ??= () => [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
});
afterEach(() => {
  for (const dispose of cleanups.splice(0)) act(dispose);
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function show(initialAgent?: string) {
  const host = document.createElement('div'),
    toolbar = document.createElement('div');
  document.body.append(toolbar, host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
    toolbar.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider
        locale="en"
        messages={messages}
        timeZone="UTC"
        now={new Date('2026-11-10T00:10:00Z')}
      >
        <LibraryAgents projectId="default" initialAgent={initialAgent} toolbar={toolbar} />
      </IntlProvider>,
    ),
  );
  return { host, toolbar };
}
function button(text: string, scope: ParentNode = document) {
  const el = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`Missing button: ${text}`);
  return el;
}
const click = async (text: string, scope?: ParentNode) =>
  act(async () => button(text, scope).click());
function dialog() {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!el) throw new Error('Missing dialog');
  return el;
}
async function type(el: HTMLInputElement | HTMLTextAreaElement | null, text: string) {
  if (!el) throw new Error('Missing field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const rows = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')].map((tr) => tr.cells[0]?.textContent);

it('separates loading, failure, retry and the empty creation path', async () => {
  let rejectLookup!: (reason: Error) => void;
  const pending = new Promise<LibraryAgent[]>((_resolve, reject) => {
    rejectLookup = reject;
  });
  const list = vi.spyOn(agents, 'list').mockReturnValueOnce(pending);
  const { host, toolbar } = await show();
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading agents');
  expect(host.textContent).not.toContain('No saved agents');
  await act(async () => rejectLookup(new Error('offline')));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load agents');
  expect(host.textContent).not.toContain('No saved agents');
  await click('Try again', host);
  expect(list.mock.calls).toEqual([['default'], ['default']]);
  expect(host.textContent).toContain('No saved agents');
  expect(button('Create agent', toolbar)).toBeTruthy();
});

it('filters names and full instructions locally and shows exact skill names in the side detail', async () => {
  const ref = { resourceHash: 'a'.repeat(64), entry: 'skills/notes/SKILL.md' };
  await seed('Writer', { skills: [ref] });
  await seed('Planner', { prompt: 'Plan tasks.' });
  const old = await seed('Retired');
  await agents.update('default', old.agentId, { archived: true, expectedRevision: 1 });
  harnesses = {
    entries: async () => [{ ...ref, kind: 'skill', name: 'Source notes' } as HarnessEntryView],
  };
  const list = vi.spyOn(agents, 'list');
  const { host } = await show();
  expect(rows(host)).toEqual(['Writer', 'Planner']);
  expect([...host.querySelectorAll('th')].map((el) => el.textContent)).toEqual([
    'Name',
    'Task',
    'Skills',
    'Last changed',
  ]);
  expect(host.querySelector<HTMLTableRowElement>('tbody tr')?.cells[1]?.textContent).toBe(
    'Write a summary.',
  );
  expect(host.querySelector('tbody tr time')?.textContent).toBe('10 minutes ago');
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Search agents"]');
  await type(field, 'PLAnn');
  expect(rows(host)).toEqual(['Planner']);
  await type(field, 'FIELD NOTES');
  expect(rows(host)).toEqual(['Writer']);
  await click('Writer');
  expect(host.querySelector('section')?.textContent).toContain('Source notes');
  await type(field, 'absent');
  expect(rows(host)).toEqual([]);
  expect(host.textContent).toContain('No matching agents');
  expect(host.textContent).not.toContain('No saved agents');
  await type(field, '');
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')?.click());
  expect(rows(host).some((name) => name?.includes('Retired'))).toBe(true);
  expect(list).toHaveBeenCalledTimes(1);
});

it('edits only original fields, requires name and instructions and reuses the creation receipt after a lost response', async () => {
  const actualCreate = agents.create;
  const create = vi.spyOn(agents, 'create').mockImplementationOnce(async (...args) => {
    const saved = await actualCreate(...args);
    expect(saved.ok).toBe(true);
    throw new Error('response lost');
  });
  const { toolbar, host } = await show();
  await click('Create agent', toolbar);
  const form = dialog();
  expect(form.querySelector('textarea')?.getAttribute('aria-label')).toBe('Base instructions');
  expect(form.textContent).toContain(messages.Library.resources.localOnly);
  for (const label of ['Receives', 'Runs', 'Calls', 'Task']) {
    expect(
      [...form.querySelectorAll('label, summary, h3, [aria-label]')].some(
        (el) => el.textContent === label || el.getAttribute('aria-label') === label,
      ),
    ).toBe(false);
  }
  const save = button('Save agent', form);
  expect(save.disabled).toBe(true);
  await type(form.querySelector('input'), 'Maker');
  expect(save.disabled).toBe(true);
  await type(form.querySelector('textarea'), 'Build a digest.');
  await click('Save agent', form);
  expect(form.querySelector('[role="alert"]')?.textContent).toMatch(/try again/i);
  expect(form.querySelector('textarea')?.value).toBe('Build a digest.');
  await click('Save agent', form);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(create).toHaveBeenCalledTimes(2);
  const first = create.mock.calls[0];
  expect(first?.[1].role).toMatchObject({ name: 'Maker', prompt: 'Build a digest.' });
  expect(first?.[1].role).not.toHaveProperty('id');
  expect(first?.[1].role).not.toHaveProperty('origin');
  expect(first?.[1].operationId).toBeTruthy();
  expect(create.mock.calls[1]).toEqual(first);
  expect(rows(host)).toEqual(['Maker']);
});

it('keeps stale edits until the person explicitly reloads the original', async () => {
  const original = await seed();
  await show(original.agentId);
  await click('Edit');
  await type(dialog().querySelector('textarea'), 'My version.');
  await agents.update('default', original.agentId, {
    role: { ...role, prompt: 'Other version.' },
    expectedRevision: 1,
  });
  await click('Save agent');
  expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(/changed/i);
  expect(dialog().querySelector('textarea')?.value).toBe('My version.');
  await click('Reload original');
  expect(dialog().querySelector('textarea')?.value).toBe('Other version.');
  await type(dialog().querySelector('textarea'), 'Merged version.');
  await click('Save agent');
  expect((await agents.get('default', original.agentId))?.role.prompt).toBe('Merged version.');
});

it('asks before closing dirty inputs and keeps the original untouched on discard', async () => {
  const original = await seed();
  const create = vi.spyOn(agents, 'create'),
    update = vi.spyOn(agents, 'update');
  await show(original.agentId);
  await click('Edit');
  await type(dialog().querySelector('textarea'), 'Unsaved draft.');
  await click('Cancel');
  await click('Keep editing');
  expect(dialog().querySelector('textarea')?.value).toBe('Unsaved draft.');
  await click('Cancel');
  await click('Discard changes');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(create).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it('duplicates the chosen original and refreshes after archiving and restoring', async () => {
  const original = await seed();
  const create = vi.spyOn(agents, 'create'),
    update = vi.spyOn(agents, 'update'),
    list = vi.spyOn(agents, 'list');
  const { host } = await show(original.agentId);
  await click('Duplicate');
  expect(create).toHaveBeenCalledWith('default', {
    role: { ...role, name: 'Writer copy' },
    operationId: expect.any(String),
  });
  expect(rows(host)).toEqual(['Writer', 'Writer copy']);
  await click('Writer');
  await click('Archive');
  expect(rows(host)).toEqual(['Writer copy']);
  expect(update).toHaveBeenCalledWith('default', original.agentId, {
    archived: true,
    expectedRevision: 1,
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')?.click());
  const firstRow = host.querySelector<HTMLButtonElement>('tbody tr button');
  await act(async () => firstRow?.click());
  await click('Restore');
  expect(update).toHaveBeenLastCalledWith('default', original.agentId, {
    archived: false,
    expectedRevision: 1,
  });
  expect(list).toHaveBeenCalledTimes(4);
});

it('reconciles a lost create with changed inputs instead of hiding the saved original or creating another', async () => {
  const persist = agents.create;
  const create = vi.spyOn(agents, 'create').mockImplementationOnce(async (...args) => {
    await persist(...args);
    throw new Error('response lost');
  });
  const { host, toolbar } = await show();
  await click('Create agent', toolbar);
  await type(dialog().querySelector('input'), 'Editor');
  await type(dialog().querySelector('textarea'), 'Check the sources.');
  await click('Save agent');
  await type(dialog().querySelector('textarea'), 'Check the dates.');
  await click('Save agent');
  expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(
    /earlier version was saved/i,
  );
  expect(dialog().querySelector('textarea')?.value).toBe('Check the dates.');
  await click('Cancel');
  await click('Discard changes');
  expect(rows(host)).toEqual(['Editor']);
  await click('Create agent', toolbar);
  await type(dialog().querySelector('input'), 'Planner');
  await type(dialog().querySelector('textarea'), 'Plan the review.');
  await click('Save agent');
  expect(create.mock.calls[2]?.[1].operationId).not.toBe(create.mock.calls[0]?.[1].operationId);
  expect(rows(host)).toEqual(['Editor', 'Planner']);
});

it('keeps invalid settings in the form and allows correcting them', async () => {
  const saved = await seed();
  const update = vi
    .spyOn(agents, 'update')
    .mockResolvedValueOnce({ ok: false, error: 'invalid', message: 'Internal validation details' });
  await show(saved.agentId);
  await click('Edit');
  await type(dialog().querySelector('textarea'), 'Invalid submission.');
  await click('Save agent');
  expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(
    /check the name, instructions/i,
  );
  expect(dialog().querySelector('textarea')?.value).toBe('Invalid submission.');
  await type(dialog().querySelector('textarea'), 'Corrected instructions.');
  await click('Save agent');
  expect(update).toHaveBeenLastCalledWith('default', saved.agentId, {
    expectedRevision: 1,
    role: { ...role, prompt: 'Corrected instructions.' },
  });
});

it('applies skills to the private original draft and persists them only on Save agent', async () => {
  const original = await seed();
  const ref = { resourceHash: '8'.repeat(64), entry: 'skills/notes/SKILL.md' };
  const api = {
    entries: async () => [
      {
        ...ref,
        kind: 'skill',
        name: 'Source notes',
        description: 'Trace a claim',
        managementRevision: 1,
        archivedAt: null,
        successor: null,
        resource: {
          hash: ref.resourceHash,
          name: 'research-pack',
          version: '1',
          fileCount: 1,
          trustedAt: '2026-11-10T00:00:00.000Z',
          createdAt: '2026-11-10T00:00:00.000Z',
          sourceKind: 'local',
          sourceLabel: 'Created in Corral',
          packagePath: null,
          license: null,
          skills: [{ name: 'source-notes', description: 'Trace a claim', entry: ref.entry }],
          extensions: [],
        },
        profiles: [],
      } satisfies HarnessEntryView,
    ],
    packages: async () => [],
    profileManagement: async () => [],
    preview: async () => ({ snapshot: null, problem: null }),
  };
  harnesses = api;
  const { host } = await show(original.agentId);
  await click('Edit', host);
  await click('Add skills');
  const row = document.querySelector<HTMLElement>('[role="checkbox"][aria-label="Source notes"]');
  expect(row).not.toBeNull();
  await act(async () => row?.click());
  await click('Apply to the agent original');
  expect((await agents.get('default', original.agentId))?.role.skills).toBeUndefined();
  expect(dialog().textContent).toContain('Source notes');
  await click('Save agent');
  expect((await agents.get('default', original.agentId))?.role.skills).toEqual([ref]);
  expect(host.querySelector('section')?.textContent).toContain('Source notes');
});

it('opens Advanced and focuses this original’s policy when a required extension blocks its skills', async () => {
  const original = await seed('PolicyWriter', { skills: [] });
  const api = {
    entries: async () => [],
    packages: async () => [],
    profileManagement: async () => [],
    preview: async () => ({
      snapshot: null,
      problem: { roleId: 'writer', reason: 'execution_policy_required', entries: [] },
    }),
  };
  harnesses = api;
  const { host } = await show(original.agentId);
  await click('Edit', host);
  const advanced = [...dialog().querySelectorAll('button[aria-expanded]')].find((button) =>
    button.textContent?.includes(messages.Inspector.advanced),
  );
  expect(advanced?.getAttribute('aria-expanded')).toBe('false');
  expect(dialog().textContent).toContain(messages.Harness.roleNeedsPolicy);
  await click('Execution policy settings', dialog());
  expect(advanced?.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement?.getAttribute('role')).toBe('combobox');
  expect(document.activeElement?.getAttribute('aria-label')).toBe(messages.Harness.heading);
  expect((await agents.get('default', original.agentId))?.revision).toBe(1);
});
