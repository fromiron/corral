// @vitest-environment jsdom
import type { HarnessApi, McpProbeResult } from '@corral/client';
import type { RegisteredMcpServer } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import en from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { McpConnection } from './McpConnection.tsx';

vi.mock('../../services.tsx', () => ({ useServices: () => ({}) }));
vi.mock('../SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => {},
  useSettingsTask: () => (task: () => Promise<unknown>) => task(),
}));
const server: RegisteredMcpServer = {
  id: 'issues',
  name: 'Issues',
  timeoutMs: 1000,
  transport: 'http',
  exposure: 'direct',
  url: 'https://example.org/mcp',
  auth: { kind: 'bearer', credentialRef: 'issues' },
};
const launch = { server, configRevision: 3, fingerprint: 'f'.repeat(64), trustedAt: 'today' };
const status = { kind: 'bearer', state: 'ready' } as const;
const api = {
  inspectMcpServer: vi.fn(async () => launch),
  mcpAuthStatus: vi.fn(async () => status),
  probeMcp: vi.fn<HarnessApi['probeMcp']>(),
  cancelMcpProbe: vi.fn(async () => ({ ok: true })),
};
let dispose: () => void;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  act(dispose);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function open(external: boolean) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => {
    root.unmount();
    host.remove();
  };
  const onProbe = vi.fn();
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={en}>
        <McpConnection
          api={api as unknown as HarnessApi}
          projectId="project"
          server={server}
          manage={false}
          onProbe={onProbe}
          externalCheck={
            external
              ? {
                  result: { launch, status: { kind: 'bearer', state: 'missing' } },
                  sessionId: '',
                  onSessionChange: vi.fn(),
                }
              : undefined
          }
        />
      </IntlProvider>,
    ),
  );
  function button(text: string) {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!button) throw Error(`No button: ${text}`);
    return button;
  }
  return { onProbe, button };
}
it('takes its probe boundary from the external check without a second trust/auth lookup', async () => {
  const { button } = await open(true);
  expect(api.inspectMcpServer).not.toHaveBeenCalled();
  expect(api.mcpAuthStatus).not.toHaveBeenCalled();
  expect(button('Check tools').disabled).toBe(true);
  expect(api.probeMcp).not.toHaveBeenCalled();
});
it('cancels the actual operation and never publishes a late success after explicit cancellation', async () => {
  let finish!: (result: McpProbeResult) => void;
  api.probeMcp.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { onProbe, button } = await open(false);
  await act(async () => button(en.Resources.probe).click());
  const input = api.probeMcp.mock.calls[0]?.[2];
  if (!input) throw Error('No operation');
  await act(async () => button(en.Resources.cancelProbe).click());
  expect(api.cancelMcpProbe).toHaveBeenCalledExactlyOnceWith(input.operationId);
  await act(async () => finish({ ...input, observedAt: 'now', tools: [] }));
  expect(onProbe.mock.calls).toEqual([[null]]);
});
