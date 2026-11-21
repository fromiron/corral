// @vitest-environment jsdom
import type { HarnessApi } from '@corral/client';
import { type CorralDefinition, DEFAULT_LIMITS, type HarnessEntryView } from '@corral/contracts';
import { createEditorStore, draftFromDefinition } from '@corral/react';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { MarkdownAgentImport } from './MarkdownAgentImport.tsx';

const fixture = vi.hoisted(() => ({ services: { harnesses: {} } as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));

const disposals: (() => Promise<void>)[] = [];
Element.prototype.getAnimations ??= () => [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
  fixture.services = { harnesses: {} };
});

it('does not put a second file action or a dialog on screen before the editor opens import', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <MarkdownAgentImport
          open={false}
          onClose={() => {}}
          finalFocus={{ current: null }}
          editor={createEditorStore()}
          profiles={[]}
          projectId="default"
        />
      </IntlProvider>,
    ),
  );
  expect(container.querySelector('button')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('chooses the connected model with the searchable model field', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const profiles = [
    {
      profileId: 'openai:gpt-6',
      source: 'connection' as const,
      provider: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-6',
      modelName: 'GPT-6',
      label: 'OpenAI · GPT-6',
      available: true,
    },
  ];
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <MarkdownAgentImport
          open
          onClose={() => {}}
          finalFocus={{ current: null }}
          editor={createEditorStore()}
          profiles={profiles}
          projectId="default"
        />
      </IntlProvider>,
    ),
  );
  const field = () =>
    document.querySelector<HTMLButtonElement>(
      '[data-slot="model-picker-trigger"][aria-label^="Connected model profile"]',
    );
  expect(field()?.getAttribute('aria-label')).toBe(
    'Connected model profile: Map to a connected model',
  );
  await act(async () => field()?.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (el) => el.getAttribute('aria-label') === 'GPT-6',
  );
  expect(option?.closest('[role="group"]')?.getAttribute('aria-label')).toBe('OpenAI');
  await act(async () => option?.click());
  expect(field()?.getAttribute('aria-label')).toBe('Connected model profile: GPT-6');
});

// agent-library.md, "정의의 선택 필드": the import review attaches the named usable skills and
// shows, by name, each one it could not attach.
const definition: CorralDefinition = {
  schemaVersion: '0.1',
  id: 'team',
  name: 'Team',
  entryNodeId: 'parent',
  input: { brief: 'Inspect code', criteria: ['Explain findings'] },
  roles: [
    {
      id: 'parent_role',
      name: 'Parent',
      prompt: 'Work.',
      modelProfile: 'connected',
      allowedWorkTools: ['write_artifact', 'read_file', 'list_files'],
      allowedCollaborationTools: ['submit_result'],
      outputContract: 'text',
    },
  ],
  nodes: [
    {
      id: 'parent',
      type: 'agent',
      roleId: 'parent_role',
      label: 'Parent',
      invocation: 'scheduled',
      inputBindings: [],
      outputName: 'answer',
    },
  ],
  controlEdges: [],
  capabilityLinks: [],
  limits: DEFAULT_LIMITS,
};

function entry(name: string, letter: string, extra: Partial<HarnessEntryView> = {}) {
  const path = `skills/${name}/SKILL.md`;
  return {
    resourceHash: letter.repeat(64),
    entry: path,
    kind: 'skill',
    name: `${name} (shown)`,
    description: `Use ${name}.`,
    managementRevision: 0,
    archivedAt: null,
    successor: null,
    profiles: [],
    resource: {
      hash: letter.repeat(64),
      name: 'pack',
      version: '1.0.0',
      license: 'MIT',
      sourceKind: 'local',
      sourceLabel: 'Local copy',
      packagePath: null,
      extensions: [],
      skills: [{ name, description: `Use ${name}.`, entry: path }],
      createdAt: '2026-11-01T00:00:00.000Z',
      trustedAt: '2026-11-01T00:00:00.000Z',
      fileCount: 1,
    },
    ...extra,
  } as HarnessEntryView;
}

async function render(harnesses: Partial<HarnessApi> | null) {
  fixture.services = { harnesses };
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const editor = createEditorStore(draftFromDefinition(definition));
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <MarkdownAgentImport
          editor={editor}
          profiles={[{ profileId: 'connected', label: 'Connected', available: true } as never]}
          projectId="project"
          open
          onClose={() => {}}
          finalFocus={createRef()}
        />
      </IntlProvider>,
    ),
  );
  const textarea = document.querySelector('textarea');
  if (!textarea) throw new Error('no Markdown source field');
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    set?.call(
      textarea,
      '---\nname: explorer\ndescription: Inspect source\ntools: [Read]\nskills: [break-it, ghost]\n---\nReport.',
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {});
  return document.body.textContent ?? '';
}

it('shows the attached skills and, by name, the ones it could not attach', async () => {
  const entries = vi.fn(async () => [
    entry('break-it', 'a'),
    entry('ghost', 'b', { archivedAt: '2026-11-02T00:00:00.000Z' }),
  ]);
  const text = await render({ entries, packages: vi.fn(async () => []) });
  expect(entries).toHaveBeenCalled();
  expect(text).toContain('Skills: break-it');
  expect(text).toContain('Skills not found, not attached: ghost');
});

it('without a skill library shows every named skill as not attached', async () => {
  const text = await render(null);
  expect(text).toContain('Skills not found, not attached: break-it, ghost');
});

it('does not attach a skill whose package is off or whose pack is not trusted', async () => {
  const base = entry('break-it', 'a');
  const disabled = await render({
    entries: vi.fn(async () => [base]),
    packages: vi.fn(async () => [{ resource: base.resource, status: 'disabled' }] as never),
  });
  expect(disabled).toContain('Skills not found, not attached: break-it, ghost');
  await disposals.pop()!();
  const untrusted = await render({
    entries: vi.fn(async () => [
      entry('break-it', 'a', { resource: { ...base.resource, trustedAt: null } }),
    ]),
    packages: vi.fn(async () => []),
  });
  expect(untrusted).toContain('Skills not found, not attached: break-it, ghost');
});

it('says the named skills were not checked when the skill library cannot be read', async () => {
  const text = await render({
    entries: vi.fn(async () => {
      throw new Error('offline');
    }),
    packages: vi.fn(async () => []),
  });
  expect(text).toContain('Skills not checked, not attached: break-it, ghost');
  expect(text).not.toContain('Skills: break-it');
});
