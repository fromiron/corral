// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { WriterHeld } from './WriterHeld.tsx';

const fixture = vi.hoisted(() => ({ workspaces: {} as Record<string, unknown> }));
vi.mock('../../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaceId: 'host', workspaces: fixture.workspaces }),
}));
afterEach(() => vi.unstubAllGlobals());

it('[TC-WBD-011-N] a save held by a running task offers to stop that task, then leaves saving to the person', async () => {
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
        <WriterHeld sessionId="session" onReleased={onReleased} />
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
