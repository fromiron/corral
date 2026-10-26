// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { WriterHeld } from './WriterHeld.tsx';

const fixture = vi.hoisted(() => ({
  workspaces: {} as Record<string, unknown>,
  terminals: { list: vi.fn(async () => ({ terminals: [] as unknown[] })) },
  transport: { listRuns: vi.fn(async () => [] as unknown[]) },
}));
vi.mock('../../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaceId: 'host', ...fixture }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    search,
    children,
    ...props
  }: {
    to: string;
    params: { sessionId: string };
    search: Record<string, string>;
    children?: ReactNode;
  }) => (
    <a
      {...props}
      href={`${to.replace('$sessionId', params.sessionId)}?${new URLSearchParams(search)}`}
    >
      {children}
    </a>
  ),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};

it('a save held by a running task offers to stop that task, then leaves saving to the person', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const running = { operationId: 'task_1', script: 'dev', state: 'running' };
  let tasks = [running, { operationId: 'task_0', script: 'build', state: 'succeeded' }];
  const stopTask = vi.fn(async () => {
    tasks = [{ ...running, state: 'cancelled' }];
    return { ...running, state: 'cancelled', cleanupConfirmed: true };
  });
  fixture.workspaces = {
    tasks: vi.fn(async () => ({ candidates: { packageManager: 'pnpm', scripts: [] }, tasks })),
    stopTask,
  };
  const onReleased = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <WriterHeld target={target} onReleased={onReleased} />
      </IntlProvider>,
    ),
  );
  expect(container.textContent).toContain(messages.Documents.writerHeld);
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.map((button) => button.textContent)).toEqual(['Stop dev']);
  await act(async () => buttons[0]?.click());
  expect(stopTask).toHaveBeenCalledWith('session', 'task_1');
  expect(onReleased).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll('button')).toHaveLength(0);
  await act(async () => root.unmount());
  container.remove();
});

it('offers same-copy terminal and same-session active Run controls without stopping or saving', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.workspaces = { tasks: vi.fn(async () => ({ tasks: [] })), stopTask: vi.fn() };
  fixture.terminals.list.mockResolvedValue({
    terminals: [
      { state: 'running', target, terminalId: 'current' },
      { state: 'exited', target, terminalId: 'finished' },
    ],
  });
  fixture.transport.listRuns.mockResolvedValue([
    { runId: 'current', sessionId: 'session', status: 'running' },
    { runId: 'finished', sessionId: 'session', status: 'succeeded' },
    { runId: 'elsewhere', sessionId: 'other', status: 'running' },
  ]);
  const onReleased = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <WriterHeld target={target} onReleased={onReleased} />
        </IntlProvider>,
      ),
    );
  try {
    await render();
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/sessions/session?panel=terminal',
      '/sessions/session?panel=run&run=current&view=run',
    ]);
    expect(fixture.terminals.list).toHaveBeenCalledWith('session');
    expect(fixture.workspaces.stopTask).not.toHaveBeenCalled();
    expect(onReleased).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    fixture.terminals.list.mockResolvedValue({
      terminals: [
        { state: 'running', target: { ...target, copyGeneration: 2 }, terminalId: 'other-copy' },
        { state: 'exited', target, terminalId: 'finished' },
      ],
    });
    fixture.transport.listRuns.mockResolvedValue([]);
    const otherRoot = createRoot(container);
    await act(async () =>
      otherRoot.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <WriterHeld target={target} />
        </IntlProvider>,
      ),
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
    await act(async () => otherRoot.unmount());
  } finally {
    container.remove();
  }
});
