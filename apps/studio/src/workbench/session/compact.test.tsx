// @vitest-environment jsdom
import type { RunSummary, WorkSession } from '@corral/core';
import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { setCommands } from '../../commandRegistry.ts';
import { Composer } from './Composer.tsx';

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../../router.tsx', () => ({ sessionRoute: {}, runRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#session">{children}</a>,
  useNavigate: () => fixture.navigate,
  useRouter: () => ({
    invalidate: vi.fn(async () => {}),
    state: { location: { href: '/sessions/session' } },
  }),
}));
vi.mock('../../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: unknown) => useState(initial),
}));
vi.mock('../navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../useModels.ts', () => ({
  useModelProfiles: () => null,
  useTeamRoles: () => [],
}));
vi.mock('../useMentionSearch.ts', () => ({ useMentionSearch: () => async () => [] }));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  setCommands('composer', null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const session: WorkSession = {
  sessionId: 'session',
  projectId: 'project',
  corralId: 'team',
  auto: null,
  title: 'Session',
  objective: '',
  pinned: false,
  revision: 1,
  createdAt: '2026-10-21T00:00:00Z',
  updatedAt: '2026-10-21T00:00:00Z',
  archivedAt: null,
  entries: [],
};
const team = {
  corralId: 'team',
  projectId: 'project',
  name: 'Team',
  definitionRevision: 1,
  nodeCount: 1,
  updatedAt: '2026-10-21T00:00:00Z',
};
const active: RunSummary = {
  runId: 'run_live',
  status: 'running',
  corralId: 'team',
  projectId: 'project',
  sessionId: 'session',
  startedAt: '2026-10-21T00:00:00Z',
};

function projection() {
  const value = emptyProjection('run_live');
  value.mode = 'live';
  value.status = 'running';
  value.controlRevision = 7;
  value.executionOrder = ['exec_writer'];
  value.executions.exec_writer = {
    executionId: 'exec_writer',
    nodeId: 'writer',
    taskId: 'task_writer',
    attemptNo: 3,
    status: 'active',
  } as never;
  return value;
}

async function mount(running: RunSummary | null, snapshot = projection()) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
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
  const sendCommand = vi.fn(async () => ({ error: null, status: 'accepted' }));
  fixture.services = {
    repository: {
      getSession: vi.fn(async () => session),
      get: vi.fn(async () => ({ ...team, definition: linearCorral(['writer']) })),
      updateSession: vi.fn(async () => ({ ok: true, session })),
    },
    transport: {
      sendCommand,
      getSnapshot: vi.fn(async () => ({ projection: snapshot, seq: 1 })),
      getRunDefinition: vi.fn(async () => linearCorral(['writer'])),
      startRun: vi.fn(async () => ({ runId: 'started', receipt: { error: null } })),
    },
    mode: 'server',
    live: true,
    workspaceId: 'host',
    workspaces: null,
    voice: null,
    startAuto: vi.fn(),
    startExplain: vi.fn(),
  };
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
        <Composer
          session={session}
          team={team}
          corrals={[team]}
          runs={running ? [running] : []}
          active={running}
          selectedRunId={running?.runId ?? null}
          queued={[]}
          onChange={() => {}}
          reference={null}
          onReferenceUsed={() => {}}
        />
      </IntlProvider>,
    ),
  );
  return { container, sendCommand };
}

async function chooseCompact(container: HTMLElement) {
  const input = container.querySelector('textarea');
  expect(input).not.toBeNull();
  await act(async () => {
    input?.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '/');
    input?.setSelectionRange(1, 1);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const option = [...document.querySelectorAll('[role="option"]')].find((node) =>
    node.textContent?.includes('/compact'),
  );
  expect(option, document.body.textContent ?? '').toBeDefined();
  await act(async () => {
    option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

it('/compact sends compact_context for the live execution', async () => {
  const { container, sendCommand } = await mount(active);
  await chooseCompact(container);
  expect(sendCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'compact_context',
      runId: 'run_live',
      expectedControlRevision: 7,
      payload: { executionId: 'exec_writer', attemptNo: 3 },
    }),
  );
});

it('/compact says why and sends nothing when no execution is running', async () => {
  const { container, sendCommand } = await mount(null);
  await chooseCompact(container);
  expect(sendCommand).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    'No execution is still running, so compaction was not sent.',
  );
});
