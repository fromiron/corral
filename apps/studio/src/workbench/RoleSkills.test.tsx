// @vitest-environment jsdom
import type { HarnessApi } from '@corral/client';
import type { HarnessEntryView, RoleSkillRef } from '@corral/contracts';
import { addNode, createEditorStore, type EditorStore, emptyDraft } from '@corral/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RoleSkills } from './RoleSkills.tsx';

const services: { harnesses: HarnessApi | null } = { harnesses: null };
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('./SettingsLifecycle.tsx', () => ({
  useSettingsTask: () => (task: () => Promise<unknown>) => task(),
  useSettingsForm: () => async () => true,
}));
vi.mock('../desktop.tsx', () => ({ desktop: null }));

function entry(name: string, hash: string, trusted = true): HarnessEntryView {
  const path = `skills/${name}/SKILL.md`;
  const createdAt = '2026-11-10T00:00:00.000Z';
  return {
    kind: 'skill',
    name,
    resourceHash: hash.repeat(64),
    entry: path,
    description: `When writing ${name}`,
    archivedAt: null,
    successor: null,
    profiles: [],
    managementRevision: 1,
    resource: {
      hash: hash.repeat(64),
      name: 'writing-pack',
      version: '1',
      fileCount: 1,
      trustedAt: trusted ? createdAt : null,
      createdAt,
      sourceKind: 'local',
      sourceLabel: 'Created in Corral',
      packagePath: null,
      license: null,
      extensions: [],
      skills: [{ name, entry: path, description: `When writing ${name}` }],
    },
  };
}
const ref = ({ resourceHash, entry }: RoleSkillRef): RoleSkillRef => ({ resourceHash, entry });
const alpha = entry('Alpha', 'a');
const beta = entry('Beta', 'b');
const locked = entry('Unreviewed', 'c', false);
const off = entry('Offline', 'd');
const archived = { ...entry('Retired', 'e'), archivedAt: 'yesterday' };
let entries: HarnessEntryView[];
const api = {
  entries: vi.fn(async () => entries),
  packages: vi.fn(async () => [{ status: 'disabled', resource: { hash: off.resourceHash } }]),
  preview: vi.fn<HarnessApi['preview']>(),
  profile: vi.fn(async () => ({
    name: 'Editorial policy',
    resources: [{ ...ref(beta), kind: 'skill', required: true }],
  })),
  readEntry: vi.fn(async (item: RoleSkillRef) => ({
    content: `Instructions for ${item.resourceHash[0]}`,
    hook: null,
  })),
  resource: vi.fn(async () => ({ files: [] })),
  reviewDocument: vi.fn(async () => ({
    reviewId: 'created',
    resource: { skills: [{ entry: 'skills/SKILL.md' }] },
  })),
  install: vi.fn(async () => {
    // The server trusts a package when it installs it.
    const item = { ...entry('Just saved', 'f'), entry: 'skills/SKILL.md' };
    entries = [...entries, item];
    return { hash: item.resourceHash, skills: [{ entry: item.entry }] };
  }),
  trust: vi.fn(async (hash: string) => {
    entries = entries.map((e) =>
      e.resourceHash === hash ? { ...e, resource: { ...e.resource, trustedAt: 'now' } } : e,
    );
  }),
};
const cleanups: (() => void)[] = [];
beforeEach(() => {
  entries = [alpha, beta, locked, off, archived];
  services.harnesses = api as unknown as HarnessApi;
  api.preview.mockReset().mockResolvedValue({ snapshot: null, problem: null });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.getAnimations ??= () => [];
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) act(cleanup);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function role(store: EditorStore, nodeId: string) {
  const { nodes, roles } = store.getState().draft.definition;
  const node = nodes.find((n) => n.id === nodeId);
  if (node?.type !== 'agent') throw Error('Missing writer');
  const found = roles.find((r) => r.id === node.roleId);
  if (!found) throw Error('Missing role');
  return found;
}
async function show(skills?: RoleSkillRef[], mode: 'seat' | 'original' = 'seat') {
  const { draft, nodeId } = addNode(emptyDraft(), 'agent');
  const [writer] = draft.definition.roles,
    [seat] = draft.definition.nodes;
  if (!writer || !seat) throw Error('Missing fixture seat');
  if (skills) writer.skills = skills;
  draft.definition.nodes.push({ ...seat, id: 'other' });
  const editor = createEditorStore(draft);
  const apply = vi.fn((skills: RoleSkillRef[]) => editor.getState().updateNode(nodeId, { skills }));
  function Host() {
    useStore(editor, (s) => s.draft);
    const current = role(editor, nodeId);
    return (
      <RoleSkills
        value={current.skills}
        onApply={apply}
        revealPolicy={vi.fn()}
        roleId={current.id}
        targetLabel="Writer"
        mode={mode}
        projectId="letter"
      />
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={en}>
        <Host />
      </IntlProvider>,
    ),
  );
  return { draft, editor, nodeId, apply, writer, host };
}
function button(label: string, root: ParentNode = document) {
  const b = [...root.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent) === label,
  );
  if (!b) throw Error(`Button not found: ${label}`);
  return b;
}
const click = async (label: string) => act(async () => button(label).click());
function check(label: string) {
  const row = document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${label}"]`);
  if (!row) throw Error(`Missing checkbox: ${label}`);
  return row;
}
const toggle = async (label: string) => act(async () => check(label).click());
const description = (row: HTMLElement) =>
  row
    .getAttribute('aria-describedby')
    ?.split(' ')
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ');
function fill(label: string, value: string) {
  const field = [...document.querySelectorAll('label')]
    .find((el) => el.textContent?.startsWith(label))
    ?.querySelector('input,textarea');
  if (!field) throw Error(`Missing ${label}`);
  return act(async () => {
    Object.getOwnPropertyDescriptor(
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('applies two skills once to this seat, forks a shared role, undoes both together', async () => {
  const { apply, editor, nodeId, draft } = await show();
  await click('Add skills');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Search skills');
  expect(button('Apply to Writer').disabled).toBe(true);
  await toggle('Alpha');
  await toggle('Beta');
  await click('Apply to Writer');
  expect(apply).toHaveBeenCalledExactlyOnceWith([ref(alpha), ref(beta)]);
  expect(role(editor, nodeId).skills).toEqual([ref(alpha), ref(beta)]);
  expect(role(editor, 'other').skills).toBeUndefined();
  expect(editor.getState().past).toHaveLength(1);
  await act(async () => editor.getState().undo());
  expect(editor.getState().draft).toBe(draft);
});
it('preserves disabled and archived choices; untrusted and disabled show the reason and cannot be checked', async () => {
  const { apply, editor, draft } = await show([ref(archived)], 'original');
  await click('Add skills');
  expect(check('Retired').getAttribute('aria-checked')).toBe('true');
  for (const [name, reason] of [
    ['Unreviewed', 'Needs trust'],
    ['Offline', 'Disabled'],
  ] as const) {
    const row = check(name);
    expect(description(row)).toContain(reason);
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.hasAttribute('tabindex')).toBe(false);
    await toggle(name);
    expect(row.getAttribute('aria-checked')).toBe('false');
  }
  await toggle('Alpha');
  expect(button('Apply to the agent original').disabled).toBe(false);
  await toggle('Alpha');
  expect(button('Apply to the agent original').disabled).toBe(true);
  await click('Cancel');
  expect(apply).not.toHaveBeenCalled();
  expect(editor.getState().draft).toBe(draft);
});
it('keeps a created skill in the library after cancelling; a saved skill is checked at once', async () => {
  const { editor, draft, apply } = await show();
  await click('Add skills');
  expect(document.querySelector('[aria-label="Retired"]')).toBeNull();
  await toggle('Alpha');
  await click('Create skill');
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await fill('Display name', 'Just saved');
  await fill(en.Resources.description, 'When checking');
  await fill('Instructions', 'Check the details.');
  await click('Save');
  expect(api.trust).not.toHaveBeenCalled();
  const row = check('Just saved');
  expect(row.getAttribute('aria-checked')).toBe('true');
  expect(description(row)).toContain('Saved · not applied');
  expect(document.activeElement).toBe(row);
  expect(check('Alpha').getAttribute('aria-checked')).toBe('true');
  await click('Cancel');
  expect(entries.find((e) => e.name === 'Just saved')).toBeDefined();
  expect(apply).not.toHaveBeenCalled();
  expect(editor.getState().draft).toBe(draft);
  expect(editor.getState().past).toHaveLength(0);
});
it('preserves unusable refs until explicit recovery; deselecting the last writes an empty array', async () => {
  api.preview.mockResolvedValue({
    snapshot: null,
    problem: {
      roleId: 'agent_1_role',
      reason: 'unusable_skills',
      entries: [{ ...ref(locked), reason: 'untrusted' }],
    },
  });
  const { apply, writer, host } = await show([ref(locked)]);
  expect(api.preview).toHaveBeenCalledWith({ id: writer.id, skills: [ref(locked)] }, 'letter');
  expect(host.textContent).toContain('Needs trust');
  expect(button('Unreviewed')).toBeTruthy();
  expect(apply).not.toHaveBeenCalled();
  await click('Reconnect Unreviewed');
  expect(button('Trust for use')).toBeTruthy();
  await click('Close');
  await click('Deselect Unreviewed');
  expect(apply).toHaveBeenCalledExactlyOnceWith([]);
});
it('reconnects a missing entry only when a replacement is chosen and applied', async () => {
  const missing = { resourceHash: '9'.repeat(64), entry: 'skills/Outline/SKILL.md' };
  api.preview.mockResolvedValue({
    snapshot: null,
    problem: {
      roleId: 'agent_1_role',
      reason: 'unusable_skills',
      entries: [{ ...missing, reason: 'missing' }],
    },
  });
  const { apply } = await show([missing, ref(beta)]);
  await click('Reconnect Outline');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Replacing Outline');
  await toggle('Alpha');
  expect(apply).not.toHaveBeenCalled();
  await click('Apply to Writer');
  expect(apply).toHaveBeenCalledExactlyOnceWith([ref(alpha), ref(beta)]);
});
it('displays unconfirmed when preview fails, with retry that does not write', async () => {
  api.preview.mockRejectedValueOnce(Error('offline'));
  const { host, apply } = await show([ref(alpha)]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Skill availability is unconfirmed',
  );
  await click('Try again');
  expect(api.preview).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});
it.each([true, false])(
  'shows successor instructions and replaces one exact selection only when trusted=%s',
  async (trusted) => {
    const newer = { ...entry('Alpha revised', 'f', trusted), entry: alpha.entry };
    entries = [{ ...alpha, successor: newer }, beta, newer];
    const { apply, editor, nodeId } = await show([ref(alpha), ref(beta)]);
    await click('Alpha');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Version 1');
    await click('Use the new version for Writer only');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      `Instructions for ${newer.resourceHash[0]}`,
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      trusted ? 'Trusted' : 'Needs trust',
    );
    expect(button('Apply to Writer').disabled).toBe(!trusted);
    await click('Apply to Writer');
    if (trusted) {
      expect(apply).toHaveBeenCalledExactlyOnceWith([ref(newer), ref(beta)]);
      expect(role(editor, nodeId).skills).toEqual([ref(newer), ref(beta)]);
      expect(editor.getState().past).toHaveLength(1);
    } else expect(apply).not.toHaveBeenCalled();
    expect(role(editor, 'other').skills).toEqual([ref(alpha), ref(beta)]);
  },
);
it('shows only the local-server message in the browser demo', async () => {
  services.harnesses = null;
  const { host } = await show();
  expect(host.textContent).toBe(en.Library.resources.localOnly);
  expect(host.querySelector('button')).toBeNull();
});
it('never adopts unread instructions: retry must load the newer body first', async () => {
  const newer = { ...entry('Alpha revised', 'f'), entry: alpha.entry };
  entries = [{ ...alpha, successor: newer }, newer];
  const { apply } = await show([ref(alpha)]);
  await click('Alpha');
  api.readEntry.mockRejectedValueOnce(Error('read failed'));
  await click('Use the new version for Writer only');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(en.Resources.readFailed);
  expect(button('Apply to Writer').disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  await click('Try again');
  expect(button('Apply to Writer').disabled).toBe(false);
});
it('keeps a policy-required skill checked and immutable, with its actual pinned source', async () => {
  const binding = { profileId: 'editorial', revision: 2 };
  api.preview.mockResolvedValue({
    snapshot: {
      binding,
      layers: [{ scope: 'project', binding }],
      snapshotHash: '4'.repeat(64),
      piVersion: '1.3.0',
      policyRevision: 1,
      policy: 'strict',
      allowedTools: [],
      tools: [],
      diagnostics: [],
      resources: [
        {
          hash: beta.resourceHash,
          entry: beta.entry,
          name: 'Writing pack',
          version: '1',
          kind: 'skill',
          required: true,
        },
      ],
    },
    sections: [],
    dynamic: false,
  });
  const { host, apply } = await show([]);
  expect(api.profile).toHaveBeenCalledWith(binding);
  expect(host.textContent).toContain('Required by Editorial policy');
  expect(host.querySelector('button[aria-label="Deselect Beta"]')).toBeNull();
  await click('Add skills');
  expect(check('Beta').getAttribute('aria-checked')).toBe('true');
  expect(check('Beta').getAttribute('aria-disabled')).toBe('true');
  await toggle('Beta');
  expect(button('Apply to Writer').disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
});
