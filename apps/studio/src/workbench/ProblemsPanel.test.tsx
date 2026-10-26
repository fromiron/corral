// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SourceNavigationContext } from './context/SourceAttachments.tsx';
import { ProblemsPanel } from './ProblemsPanel.tsx';

const fixture = vi.hoisted(() => ({ workspaces: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaceId: 'host', workspaces: fixture.workspaces }),
}));
const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 2,
};
// The dock shows only documents its store holds; the row opens the file there first.
const open = vi.hoisted(() => vi.fn(async (_session: string, path: string) => `key:${path}`));
vi.mock('./documents/store.ts', () => ({
  documentStore: () => ({
    open,
    getState: () => ({ documents: { 'key:src/a.ts': { target, path: 'src/a.ts' } } }),
  }),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

it('gathers check and task locations, marks stale ones and opens the exact line', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.workspaces = {
    worktree: vi.fn(async () => ({ bindingId: 'binding', copyGeneration: 2, missing: false })),
    verifications: vi.fn(async () => [
      {
        verificationId: 'v1',
        name: 'Typecheck',
        state: 'failed',
        stale: true,
        tree: 'a'.repeat(40),
        output: 'src/a.ts(3,2): error TS1005: semicolon expected.\n/etc/hosts:1:1: error elsewhere',
      },
    ]),
    tasks: vi.fn(async () => ({
      candidates: { packageManager: 'npm', scripts: [] },
      tasks: [{ operationId: 'task_1', script: 'test', state: 'failed' }],
    })),
    taskOutput: vi.fn(async () => ({
      text: ' ❯ test/x.test.ts:8:17',
      nextOffset: 0,
      bytes: 0,
      truncated: false,
    })),
  };
  const openDocument = vi.fn(() => true);
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
        <SourceNavigationContext.Provider value={{ openDocument, openTerminal: () => {} }}>
          <ProblemsPanel sessionId="session" />
        </SourceNavigationContext.Provider>
      </IntlProvider>,
    ),
  );
  expect(container.textContent).toContain('Typecheck');
  expect(container.textContent).toContain(messages.Problems.stale);
  expect(container.textContent).toContain('test');
  expect(container.textContent).not.toContain('/etc/hosts');
  const row = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes('src/a.ts:3:2'),
  );
  await act(async () => row?.click());
  expect(openDocument).toHaveBeenCalledWith(
    {
      hostId: 'host',
      projectId: 'project',
      bindingId: 'binding',
      sessionId: 'session',
      copyGeneration: 2,
    },
    'src/a.ts',
    { startLine: 3, startColumn: 2, endLine: 3, endColumn: 2 },
  );
});

it('a task log is of unknown version and a check run under other settings is not current', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.workspaces = {
    worktree: vi.fn(async () => ({ bindingId: 'binding', copyGeneration: 2, missing: false })),
    verifications: vi.fn(async () => [
      {
        verificationId: 'v1',
        name: 'Typecheck',
        state: 'failed',
        stale: false,
        configChanged: true,
        tree: 'a'.repeat(40),
        output: 'src/a.ts(3,2): error TS1005: semicolon expected.',
      },
    ]),
    tasks: vi.fn(async () => ({
      candidates: { packageManager: 'npm', scripts: [] },
      tasks: [{ operationId: 'task_1', script: 'dev', state: 'running' }],
    })),
    taskOutput: vi.fn(async () => ({
      text: 'src/b.ts(2,1): error TS2304: Cannot find name.',
      nextOffset: 0,
      bytes: 0,
      truncated: false,
    })),
  };
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
        <ProblemsPanel sessionId="session" />
      </IntlProvider>,
    ),
  );
  const heading = (name: string) =>
    [...container.querySelectorAll('h3')].find((item) => item.textContent?.includes(name));
  expect(heading('Typecheck')?.textContent).toContain(messages.Problems.configChanged);
  expect(heading('Typecheck')?.textContent).not.toContain(messages.Problems.stale);
  expect(heading('dev')?.textContent).toContain(messages.Problems.versionUnknown);
});
