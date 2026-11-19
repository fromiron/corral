// @vitest-environment jsdom
import type { HarnessApi } from '@corral/client';
import type { RoleMcpToolProblemReason } from '@corral/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RoleTools } from './RoleTools.tsx';

const tool = { serverId: 'issues', name: 'mcp__issues__search' };
const role = {
  id: 'writer',
  harness: { profileId: 'p', revision: 1 },
  skills: [],
  mcpTools: [tool],
};
const api = {
  projectTools: vi.fn(async () => ({ mcpServers: [{ id: 'issues', name: 'Issue tracker' }] })),
  preview: vi.fn<HarnessApi['preview']>(),
};
const services: { harnesses: unknown } = { harnesses: api };
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: React.ReactNode }) => <a href="?settings=mcp">{children}</a>,
}));
const onApply = vi.fn();
const revealPolicy = vi.fn();
let root: Root;
let host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  services.harnesses = api;
  api.preview.mockResolvedValue({
    snapshot: {
      binding: role.harness,
      snapshotHash: 'b'.repeat(64),
      piVersion: '1.3.0',
      policyRevision: 1,
      policy: 'trusted-native',
      resources: [],
      allowedTools: [tool.name],
      tools: [],
      diagnostics: [],
    },
    sections: [],
    dynamic: false,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function show(mode: 'original' | 'seat' = 'seat', value = role) {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={en}>
        <RoleTools
          projectId="project"
          role={value}
          mode={mode}
          targetLabel="Writer"
          onApply={onApply}
          revealPolicy={revealPolicy}
        />
      </IntlProvider>,
    ),
  );
}
function button(name: string) {
  const el = [...host.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent) === name,
  );
  if (!el) throw Error(`Missing button: ${name}`);
  return el;
}
it.each([
  ['execution_policy_required', 'Choose an execution policy'],
  ['server_not_selected', 'Choose an execution policy'],
  ['tool_not_allowed', 'Choose an execution policy'],
  ['server_missing', 'Manage connections'],
  ['server_disabled', 'Manage connections'],
] as const)(
  'retains a blocked selection and offers the right recovery for %s',
  async (reason: RoleMcpToolProblemReason, recovery) => {
    api.preview.mockResolvedValue({
      snapshot: null,
      problem: null,
      mcpProblem: { roleId: 'writer', tools: [{ ...tool, reason }] },
    });
    await show();
    expect(api.preview).toHaveBeenCalledWith(role, 'project');
    expect(host.textContent).toContain('Issue tracker · search');
    expect(host.textContent).not.toContain('mcp__');
    expect(host.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy();
    expect(host.textContent).toContain('Mock tests do not call external tools.');
    expect(onApply).not.toHaveBeenCalled();
    if (recovery === 'Manage connections')
      expect(host.querySelector('a')?.textContent).toBe(recovery);
    else {
      await act(async () => button(recovery).click());
      expect(revealPolicy).toHaveBeenCalledOnce();
    }
    await act(async () => button('Deselect Issue tracker · search').click());
    expect(onApply).toHaveBeenCalledExactlyOnceWith([]);
  },
);
it('deselects only the chosen connection and tool pair in an imported role', async () => {
  const current = { serverId: 'issues', name: 'mcp__issues__old__search' };
  const unresolved = { serverId: 'issues__old', name: current.name };
  await show('seat', { ...role, mcpTools: [current, unresolved] });
  await act(async () => button('Deselect Issue tracker · old__search').click());
  expect(onApply).toHaveBeenCalledExactlyOnceWith([unresolved]);
});
it('retries a failed preview without changing the selection and omits the mock note on originals', async () => {
  api.preview.mockRejectedValueOnce(new Error('offline'));
  await show('original');
  expect(host.textContent).toContain('Tool access could not be confirmed.');
  expect(host.textContent).not.toContain('Mock tests');
  await act(async () => button('Try again').click());
  expect(api.preview).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain('Tool access could not be confirmed.');
  expect(onApply).not.toHaveBeenCalled();
});
it('shows only Add tools when empty and only the server-availability line in the demo', async () => {
  await show('seat', { ...role, mcpTools: [] });
  expect(host.textContent).toBe('Add tools');
  services.harnesses = null;
  await show();
  expect(host.textContent).toBe(en.Library.resources.localOnly);
  expect(host.querySelector('button')).toBeNull();
});
