// @vitest-environment jsdom
import type { WorkspacePreview } from '@corral/client';
import { SizeScope } from '@corral/react/design-kit';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { PreviewLeases } from './PreviewLeases.tsx';
import { PreviewView } from './PreviewView.tsx';

Element.prototype.getAnimations ??= () => [];

const lease: WorkspacePreview = {
  leaseId: 'lease_one',
  sessionId: 'session',
  runId: 'run_one',
  kind: 'static',
  url: 'http://127.0.0.2:4100/p/index.html?token=secret#frag',
  origin: 'http://127.0.0.2:4100',
  path: 'index.html',
  state: 'ready',
  createdAt: '2026-11-10T00:00:00.000Z',
};
const fixture = vi.hoisted(() => ({
  workspaces: {
    previews: vi.fn(),
    startPreview: vi.fn(),
    stopPreview: vi.fn(async () => {}),
    startTask: vi.fn(),
    stopTask: vi.fn(),
    taskOutput: vi.fn(),
    commandOutput: vi.fn(),
  },
}));
vi.mock('../services.tsx', () => {
  // One services object, as the app's context provides.
  const services = { mode: 'server', workspaceId: 'local', workspaces: fixture.workspaces };
  return { useServices: () => services };
});
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  for (const mock of Object.values(fixture.workspaces)) mock.mockClear();
  fixture.workspaces.previews.mockImplementation(async () => [lease]);
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});
async function mount(content: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {content}
      </IntlProvider>,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return container;
}
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
const requests = () =>
  Object.entries(fixture.workspaces)
    .filter(([name]) => name !== 'previews')
    .reduce((count, [, mock]) => count + mock.mock.calls.length, 0);

it('an open preview shows its address without the capability query, and sizes only its frame', async () => {
  const container = await mount(<PreviewLeases sessionId="session" />);
  await act(async () => button(container, messages.Preview.open)?.click());
  const frame = container.querySelector('iframe');
  expect(frame?.getAttribute('src')).toBe(lease.url);
  expect(frame?.getAttribute('sandbox')).toBe('');
  expect(container.textContent).toContain('http://127.0.0.2:4100/p/index.html');
  expect(container.textContent).not.toContain('token=secret');
  const polled = fixture.workspaces.previews.mock.calls.length;
  for (const size of [
    messages.Preview.viewportTablet,
    messages.Preview.viewportMobile,
    messages.Preview.viewportFull,
    messages.Preview.viewportTablet,
  ])
    await act(async () => button(container, size)?.click());
  // The same frame, narrowed: no reload, no lease and no task request.
  expect(container.querySelector('iframe')).toBe(frame);
  expect(frame?.style.width).toBe('768px');
  expect(button(container, messages.Preview.viewportTablet)?.getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(requests()).toBe(0);
  expect(fixture.workspaces.previews.mock.calls.length).toBe(polled);
  await act(async () => button(container, messages.Preview.refresh)?.click());
  const reloaded = container.querySelector('iframe');
  expect(reloaded).not.toBe(frame);
  expect(reloaded?.getAttribute('src')).toBe(lease.url);
  expect(reloaded?.style.width).toBe('768px');
  expect(requests()).toBe(0);
});

it('the linked task’s recent output is read only when its disclosure opens', async () => {
  fixture.workspaces.taskOutput.mockImplementation(async () => ({
    text: 'VITE ready\n',
    nextOffset: 11,
    bytes: 11,
    truncated: false,
  }));
  const service = { ...lease, kind: 'service' as const, operationId: 'task_dev' };
  const container = await mount(
    <PreviewView
      sessionId="session"
      lease={service}
      output={{ kind: 'task', operationId: 'task_dev' }}
    />,
  );
  expect(fixture.workspaces.taskOutput).not.toHaveBeenCalled();
  const disclosure = container.querySelector('details');
  expect(disclosure?.querySelector('summary')?.textContent).toContain(messages.Preview.output);
  await act(async () => {
    if (disclosure) disclosure.open = true;
    disclosure?.dispatchEvent(new Event('toggle'));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(fixture.workspaces.taskOutput).toHaveBeenCalledWith('session', 'task_dev', 0);
  expect(disclosure?.textContent).toContain('VITE ready');
});

it('says when no output is available', async () => {
  fixture.workspaces.commandOutput.mockRejectedValue(new Error('gone'));
  const container = await mount(
    <PreviewView
      sessionId="session"
      lease={{ ...lease, kind: 'service', operationId: 'cmd_one' }}
      output={{ kind: 'command', operationId: 'cmd_one' }}
    />,
  );
  const disclosure = container.querySelector('details');
  await act(async () => {
    if (disclosure) disclosure.open = true;
    disclosure?.dispatchEvent(new Event('toggle'));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(fixture.workspaces.commandOutput).toHaveBeenCalledWith('session', 'cmd_one', 0);
  expect(disclosure?.textContent).toContain(messages.Preview.noOutput);
});

// Settings › General › Interface density reaches the bottom dock (workbench.md).
it('the preview toolbar takes the interface density', async () => {
  const sizes = async (density: 'default' | 'compact') => {
    const container = await mount(
      <SizeScope size={density}>
        <PreviewView sessionId="session" lease={lease} output={null} inline />
      </SizeScope>,
    );
    return [messages.Preview.refresh, messages.Preview.viewportTablet].map((name) =>
      button(container, name)?.getAttribute('data-size'),
    );
  };
  expect(await sizes('default')).toEqual(['icon', 'default']);
  expect(await sizes('compact')).toEqual(['icon-compact', 'compact']);
});
