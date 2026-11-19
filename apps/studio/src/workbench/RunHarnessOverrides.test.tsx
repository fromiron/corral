// @vitest-environment jsdom
import type { HarnessPreview, RoleHarnessPreview } from '@corral/client';
import type { RoleSkillRef } from '@corral/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunHarnessOverrides } from './RunHarnessOverrides.tsx';

const { api } = vi.hoisted(() => ({
  api: { profileManagement: async () => [], preview: vi.fn<() => Promise<RoleHarnessPreview>>() },
}));
vi.mock('../services.tsx', () => ({ useServices: () => ({ harnesses: api }) }));

const binding = { profileId: 'base', revision: 2 };
const runOverride = { profileId: 'limited', revision: 1 };
const style = { resourceHash: 'a'.repeat(64), entry: 'skills/style/SKILL.md' };
const checked: HarnessPreview = {
  snapshot: {
    binding,
    snapshotHash: 'b'.repeat(64),
    piVersion: '1.3.0',
    policyRevision: 1,
    policy: 'strict',
    resources: [],
    allowedTools: [],
    tools: [],
    diagnostics: [],
  },
  sections: [],
  dynamic: false,
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.preview.mockReset().mockResolvedValue(checked);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function renderSelection(skills?: RoleSkillRef[]) {
  const writer = { roleId: 'writer', name: 'Writer', harness: binding, ...(skills && { skills }) };
  const reader = { roleId: 'reader', name: 'Reader', skills: [style] };
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunHarnessOverrides
          roles={[writer, reader]}
          projectId="project"
          value={{ writer: runOverride }}
          onChange={() => {}}
        />
      </IntlProvider>,
    );
  });
}
async function previewWriter() {
  const label = messages.Harness.previewRunStyle.replace('{name}', 'Writer');
  const button = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === label,
  );
  host.querySelector('summary')?.click();
  if (!button) throw Error(`Missing ${label}`);
  await act(async () => button.click());
}

it.each([
  { label: 'selected entries', skills: [style] },
  { label: 'an explicit empty selection', skills: [] },
])('previews $label together with the pinned harness and run override', async ({ skills }) => {
  await renderSelection(skills);
  await previewWriter();
  expect(api.preview).toHaveBeenCalledExactlyOnceWith(
    { id: 'writer', harness: binding, skills },
    'project',
    runOverride,
  );
  expect(host.querySelector('[data-testid="run-harness-preview"]')?.textContent).toContain(
    checked.snapshot.snapshotHash,
  );
});

it('keeps a bound role without a skill selection on its binding preview and excludes an unbound role', async () => {
  await renderSelection();
  expect(host.textContent).not.toContain('Reader');
  await previewWriter();
  expect(api.preview).toHaveBeenCalledExactlyOnceWith(binding, 'project', runOverride);
});

it('invalidates a pending preview when only the skills change, even when the selection is restored', async () => {
  let finish!: (result: HarnessPreview) => void;
  api.preview.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await renderSelection();
  await previewWriter();
  expect(host.querySelector('[role="status"]')?.textContent).toBe(messages.Harness.busy);
  await renderSelection([]);
  expect(host.querySelector('[data-testid="run-harness-preview"]')).toBeNull();
  await renderSelection();
  await act(async () => finish(checked));
  expect(host.querySelector('[data-testid="run-harness-preview"]')).toBeNull();
});

it('identifies the unusable selection without displaying a resolved snapshot', async () => {
  const other = { resourceHash: 'c'.repeat(64), entry: 'skills/review/SKILL.md' };
  api.preview.mockResolvedValueOnce({
    snapshot: null,
    problem: {
      roleId: 'writer',
      reason: 'unusable_skills',
      entries: [{ ...other, reason: 'disabled' }],
    },
  });
  await renderSelection([style, other]);
  await previewWriter();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    messages.Harness.roleSkillProblem.disabled.replace('{number}', '2'),
  );
  expect(host.querySelector('[data-testid="harness-preview"]')).toBeNull();
});
