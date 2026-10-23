// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { WorkbenchTasks } from './WorkbenchTasks.tsx';

const fixture = vi.hoisted(() => ({ workspaces: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaceId: 'host', workspaces: fixture.workspaces }),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <WorkbenchTasks sessionId="session" projectId="project" />
      </IntlProvider>,
    ),
  );
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.getAttribute('aria-label') === name,
    );
  return { container, button };
}

const task = (state: string) => ({
  operationId: 'task_1',
  script: 'dev',
  command: 'vite',
  packageManager: 'pnpm',
  state,
  createdAt: 'x',
  updatedAt: 'x',
});

it('[TC-WBD-011-H] [TC-WBD-011-N] lists scripts without running them and starts one only on request', async () => {
  let tasks: ReturnType<typeof task>[] = [];
  const startTask = vi.fn(async () => {
    tasks = [task('running')];
    return tasks[0];
  });
  const stopTask = vi.fn(async () => {
    tasks = [task('cancelled')];
    return tasks[0];
  });
  fixture.workspaces = {
    worktree: vi.fn(async () => ({ bindingId: 'binding', copyGeneration: 2, missing: false })),
    tasks: vi.fn(async () => ({
      candidates: { packageManager: 'pnpm', scripts: [{ name: 'dev', command: 'vite' }] },
      tasks,
    })),
    taskOutput: vi.fn(async () => ({
      text: 'ready on 5173',
      nextOffset: 13,
      bytes: 13,
      truncated: false,
    })),
    startTask,
    stopTask,
  };
  const f = await mount();
  expect(f.container.textContent).toContain('dev');
  expect(startTask).not.toHaveBeenCalled();
  await act(async () => f.button('Run dev')?.click());
  expect(startTask).toHaveBeenCalledWith('session', {
    operationId: expect.stringMatching(/^task_/),
    target: {
      hostId: 'host',
      projectId: 'project',
      bindingId: 'binding',
      sessionId: 'session',
      copyGeneration: 2,
    },
    script: 'dev',
  });
  expect(f.container.textContent).toContain('ready on 5173');
  await act(async () => f.button('Stop dev')?.click());
  expect(stopTask).toHaveBeenCalledWith('session', 'task_1');
});
