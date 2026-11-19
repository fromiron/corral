// @vitest-environment jsdom
import type { HarnessApi, McpProbeResult } from '@corral/client';
import type { RegisteredMcpServer, RoleMcpToolRef } from '@corral/contracts';
import { act, type ComponentProps, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SettingsNavigationContext, useSettingsNavigation } from './navigation.ts';
import { RoleToolPicker } from './RoleToolPicker.tsx';

const services = {
  repository: { listSessions: vi.fn(async () => [{ sessionId: 'copy', title: 'Research copy' }]) },
  workspaces: { worktree: vi.fn(async () => ({ missing: false })) },
};
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('./SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => {},
  useSettingsTask: () => (task: () => Promise<unknown>) => task(),
}));
function http(id: string, name: string): RegisteredMcpServer {
  return {
    id,
    name,
    timeoutMs: 1000,
    exposure: 'direct',
    transport: 'http',
    url: 'https://example.org/mcp',
    auth: { kind: 'bearer', credentialRef: id },
  };
}
const issues = http('issues', 'Issues');
const docs = http('docs', 'Docs');
const local: RegisteredMcpServer = {
  id: 'local',
  name: 'Local',
  timeoutMs: 1000,
  exposure: 'direct',
  transport: 'stdio',
  argv: ['local'],
};
const ref = (serverId: string, tool: string): RoleMcpToolRef => ({
  serverId,
  name: `mcp__${serverId}__${tool}`,
});
const tool = (serverId: string, id: string, title: string) => ({
  name: ref(serverId, id).name,
  title,
  description: '',
  schemaHash: 'a'.repeat(64),
});
const api = {
  inspectMcpServer: vi.fn<HarnessApi['inspectMcpServer']>(),
  mcpAuthStatus: vi.fn<HarnessApi['mcpAuthStatus']>(),
  probeMcp: vi.fn<HarnessApi['probeMcp']>(),
  cancelMcpProbe: vi.fn(async () => ({ ok: true })),
};
const cleanups: (() => void)[] = [];
beforeEach(() => {
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
  api.inspectMcpServer.mockImplementation(async (_project, id) => ({
    server: id === issues.id ? issues : id === local.id ? local : docs,
    configRevision: 3,
    fingerprint: id,
    trustedAt: 'today',
  }));
  api.mcpAuthStatus.mockImplementation(async (_project, id) =>
    id === local.id ? { state: 'not_required', kind: 'none' } : { state: 'ready', kind: 'bearer' },
  );
  api.probeMcp.mockImplementation(async (_project, id, input) => ({
    ...input,
    observedAt: 'now',
    tools:
      id === 'issues'
        ? [tool(id, 'search', 'Search issues'), tool(id, 'update', 'Update issue')]
        : [tool(id, 'search', 'Search docs')],
  }));
});
afterEach(() => {
  for (const dispose of cleanups.splice(0)) act(dispose);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function show(options: Partial<ComponentProps<typeof RoleToolPicker>> = {}) {
  const host = document.createElement('div');
  const opener = document.createElement('button');
  opener.textContent = 'Choose tools';
  document.body.append(opener, host);
  opener.focus();
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    opener.remove();
    host.remove();
  });
  const apply = vi.fn(),
    close = vi.fn(),
    retry = vi.fn();
  const props: ComponentProps<typeof RoleToolPicker> = {
    api: api as unknown as HarnessApi,
    projectId: 'project',
    servers: [issues, docs],
    sessionId: undefined,
    value: [],
    mode: 'seat',
    targetLabel: 'Researcher',
    opener,
    onClose: close,
    onApply: apply,
    manageConnections: <a href="/settings/mcp">Manage connections</a>,
    catalogState: 'ready',
    onRetry: retry,
    ...options,
  };
  function Host({
    props,
    overlay,
  }: {
    props: ComponentProps<typeof RoleToolPicker>;
    overlay: boolean;
  }) {
    const [open, setOpen] = useState(true);
    const navigation = useSettingsNavigation();
    return open ? (
      <SettingsNavigationContext.Provider value={{ ...navigation, overlay }}>
        <RoleToolPicker
          {...props}
          onClose={() => {
            props.onClose();
            setOpen(false);
          }}
        />
      </SettingsNavigationContext.Provider>
    ) : null;
  }
  const render = (next: Partial<typeof props>, overlay = false) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={en}>
          <Host props={{ ...props, ...next }} overlay={overlay} />
        </IntlProvider>,
      ),
    );
  await render({});
  return { apply, close, retry, render, opener };
}
function button(name: string | RegExp) {
  const button = [...document.querySelectorAll('button')].find((b) => {
    const label = b.getAttribute('aria-label') ?? b.textContent ?? '';
    return typeof name === 'string' ? name === label : name.test(label);
  });
  if (!button) throw Error(`No button: ${name}`);
  return button;
}
const click = (name: string | RegExp) => act(async () => button(name).click());
function checkbox(title: string) {
  const row = document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${title}"]`);
  if (!row) throw Error(`No checkbox: ${title}`);
  return row;
}
const toggle = (label: string) => act(async () => checkbox(label).click());
const checkTools = () => click('Check tools');

it.each(['ready', 'failed'] as const)(
  'omits search and focuses Manage connections for a %s catalog without searchable rows',
  async (catalogState) => {
    const { render } = await show({ catalogState: 'loading', servers: [] });
    await render({ catalogState, servers: [] });
    expect(document.querySelector('input[aria-label="Search connections"]')).toBeNull();
    const manage = document.querySelector('a[href="/settings/mcp"]');
    expect(manage).not.toBeNull();
    expect(document.activeElement).toBe(manage);
  },
);

it('focuses the search field when connections arrive without stealing focus from Cancel', async () => {
  const { render } = await show({ catalogState: 'loading', servers: [] });
  expect(document.querySelector('input[aria-label="Search connections"]')).toBeNull();
  await render({ catalogState: 'ready', servers: [issues] });
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Search connections');
  await render({ catalogState: 'loading', servers: [] });
  button('Cancel').focus();
  await render({ catalogState: 'ready', servers: [issues] });
  expect(document.activeElement).toBe(button('Cancel'));
});

it('opens a named dialog on search; only explicit checks discover tools; applies exact refs and titles across connections once', async () => {
  const missing = ref('missing', 'old');
  const { apply } = await show({ value: [missing, ref('issues', 'search')] });
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Add tools');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Search connections');
  expect(button('Apply to Researcher').disabled).toBe(true);
  await click(/^Issues/);
  expect(api.probeMcp).not.toHaveBeenCalled();
  await checkTools();
  expect(checkbox('Search issues').getAttribute('aria-checked')).toBe('true');
  await toggle('Update issue');
  await click(/^Docs/);
  expect(api.probeMcp).toHaveBeenCalledTimes(1);
  await checkTools();
  await toggle('Search docs');
  await click(/^Issues/);
  expect(checkbox('Search issues').getAttribute('aria-checked')).toBe('true');
  expect(checkbox('Update issue').getAttribute('aria-checked')).toBe('true');
  await click('Apply to Researcher');
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    [missing, ref('issues', 'search'), ref('issues', 'update'), ref('docs', 'search')],
    new Map([
      ['issues:mcp__issues__search', 'Search issues'],
      ['issues:mcp__issues__update', 'Update issue'],
      ['docs:mcp__docs__search', 'Search docs'],
    ]),
  );
});
it('does not check a tool on one connection because a different stored ref has the same name', async () => {
  const stored = { serverId: 'issues__old', name: 'mcp__issues__old__search' };
  api.probeMcp.mockImplementationOnce(async (_p, _s, input) => ({
    ...input,
    observedAt: 'now',
    tools: [tool('issues', 'old__search', 'Search archive')],
  }));
  const { apply } = await show({ value: [stored] });
  await click(/^Issues/);
  await checkTools();
  expect(checkbox('Search archive').getAttribute('aria-checked')).toBe('false');
  await toggle('Search archive');
  await click('Apply to Researcher');
  expect(apply.mock.calls[0]?.[0]).toEqual([stored, ref('issues', 'old__search')]);
});
it('cancel discards two pending checks, restores focus, and does not commit while composing', async () => {
  const { apply, opener, close } = await show({ mode: 'original' });
  await click(/^Issues/);
  await checkTools();
  await toggle('Search issues');
  await toggle('Update issue');
  const search = document.querySelector('input[aria-label="Search connections"]');
  if (!search) throw Error('No search');
  await act(async () => {
    search.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  await click('Apply to the agent original');
  await act(async () => {
    search.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }),
    );
  });
  expect(close).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  await act(async () => {
    search.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await toggle('Search issues');
  await toggle('Update issue');
  expect(button('Apply to the agent original').disabled).toBe(true);
  await toggle('Search issues');
  await toggle('Update issue');
  await click('Cancel');
  expect(close).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(opener);
});
it.each(['switch', 'close', 'manage'] as const)(
  'cancels the actual owned probe on %s and rejects late tools',
  async (action) => {
    const { apply, render } = await show();
    await click(/^Docs/);
    await checkTools();
    await toggle('Search docs');
    let finish!: (result: McpProbeResult) => void;
    api.probeMcp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await click(/^Issues/);
    await checkTools();
    const input = api.probeMcp.mock.calls[1]?.[2];
    if (!input) throw Error('No probe');
    if (action === 'manage') await render({}, true);
    else await click(action === 'switch' ? /^Docs/ : 'Cancel');
    expect(api.cancelMcpProbe).toHaveBeenCalledExactlyOnceWith(input.operationId);
    await act(async () =>
      finish({
        ...input,
        observedAt: 'now',
        tools: [tool('issues', 'late', 'Late tool')],
      }),
    );
    if (action === 'switch') await click(/^Issues/);
    if (action === 'manage') {
      const before = api.inspectMcpServer.mock.calls.length;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(api.inspectMcpServer).toHaveBeenCalledTimes(before);
      expect(api.probeMcp).toHaveBeenCalledTimes(2);
      await render({ servers: [issues, docs] });
    }
    expect(document.body.textContent).not.toContain('Late tool');
    expect(apply).not.toHaveBeenCalled();
    if (action === 'manage') {
      await click('Apply to Researcher');
      expect(apply).toHaveBeenCalledExactlyOnceWith(
        [ref('docs', 'search')],
        new Map([['docs:mcp__docs__search', 'Search docs']]),
      );
    }
  },
);
it('takes truth from inspection and auth, refreshes after management even at the same revision, and never probes disabled servers', async () => {
  const off = { ...docs, id: 'off', name: 'Offline', enabled: false };
  const servers = [issues, docs, off];
  let trusted = false,
    signedIn = false;
  api.inspectMcpServer.mockImplementation(async (_project, id) => ({
    server: id === 'docs' ? docs : issues,
    configRevision: 3,
    fingerprint: id,
    trustedAt: id === 'docs' && !trusted ? null : 'today',
  }));
  api.mcpAuthStatus.mockImplementation(async (_project, id) => ({
    kind: 'bearer',
    state: id === 'issues' && !signedIn ? 'missing' : 'ready',
  }));
  const { render } = await show({ servers });
  expect(button(/^Issues/).textContent).toContain('Sign-in required');
  expect(button(/^Docs/).textContent).toContain('Trust required');
  expect(button(/^Offline/).textContent).toContain('Off');
  for (const name of [/^Issues/, /^Docs/, /^Offline/]) {
    await click(name);
    expect(button('Check tools').disabled).toBe(true);
  }
  signedIn = true;
  trusted = true;
  await render({ servers: [...servers] });
  expect(button(/^Issues/).textContent).toContain('Available');
  expect(button(/^Docs/).textContent).toContain('Available');
  await click(/^Issues/);
  expect(button('Check tools').disabled).toBe(false);
  signedIn = false;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(button(/^Issues/).textContent).toContain('Sign-in required');
  expect(button('Check tools').disabled).toBe(true);
  expect(api.probeMcp).not.toHaveBeenCalled();
});
it.each([undefined, 'copy'])(
  'checks stdio against an actual chosen copy (initial session: %s)',
  async (sessionId) => {
    await show({ servers: [local], sessionId });
    await click(/^Local/);
    expect(services.repository.listSessions).toHaveBeenCalledWith('project');
    if (!sessionId) {
      expect(button(/^Local/).textContent).toContain('Choose a Paddock');
      expect(button('Check tools').disabled).toBe(true);
      await click(en.Resources.workingCopy);
      const copy = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
        option.textContent?.includes('Research copy'),
      );
      if (!copy) throw Error('No working copy option');
      await act(async () => copy.click());
    }
    await checkTools();
    expect(api.inspectMcpServer).toHaveBeenCalledWith('project', 'local', { sessionId: 'copy' });
    expect(api.probeMcp).toHaveBeenCalledExactlyOnceWith(
      'project',
      'local',
      expect.objectContaining({ fingerprint: 'local', configRevision: 3, sessionId: 'copy' }),
    );
  },
);
it('distinguishes failed checks, a confirmed empty result, and an unconfirmed catalog from no connections', async () => {
  api.probeMcp
    .mockRejectedValueOnce(Error('MCP connection refused'))
    .mockImplementationOnce(async (_p, _s, input) => ({ ...input, observedAt: 'now', tools: [] }));
  const { render, retry } = await show();
  await click(/^Issues/);
  await checkTools();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    en.Resources.probeFailure.connection,
  );
  expect(document.body.textContent).not.toContain(en.Resources.probeEmpty);
  expect(document.querySelector('a[href="/settings/mcp"]')).not.toBeNull();
  await checkTools();
  expect(document.body.textContent).toContain(en.Resources.probeEmpty);
  await render({ servers: [], catalogState: 'loading' });
  expect(document.body.textContent).not.toContain('No connections registered');
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  await render({ servers: [], catalogState: 'failed' });
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('No connections registered');
  await click(en.Library.retry);
  expect(retry).toHaveBeenCalledOnce();
  await render({ servers: [], catalogState: 'ready' });
  expect(document.body.textContent).toContain('No connections registered');
  expect(document.querySelector('a[href="/settings/mcp"]')).not.toBeNull();
});

it('keeps discovery disabled when auth could not be read, even if an earlier check later reports ready', async () => {
  let reportReady!: () => void;
  api.mcpAuthStatus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        reportReady = () => resolve({ kind: 'bearer', state: 'ready' });
      }),
  );
  const { render } = await show({ servers: [issues] });
  await click(/^Issues/);
  expect(button('Check tools').disabled).toBe(true);
  api.mcpAuthStatus.mockRejectedValueOnce(Error('offline'));
  await render({ servers: [issues] });
  await act(async () => reportReady());
  expect(button(/^Issues/).textContent).toContain('Connection status could not be confirmed.');
  expect(button('Check tools').disabled).toBe(true);
  expect(document.querySelector('a[href="/settings/mcp"]')).not.toBeNull();
  expect(api.probeMcp).not.toHaveBeenCalled();
});
