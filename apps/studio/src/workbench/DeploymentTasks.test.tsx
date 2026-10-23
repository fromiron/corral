// @vitest-environment jsdom
import { ApiError } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { DeploymentTasks } from './DeploymentTasks.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

const fixture = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaceId: 'host', workspaces: fixture.api }),
}));
vi.mock('use-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { has: () => true }),
}));
const documents = createStore(() => ({ documents: {} }));
vi.mock('./documents/store.ts', () => ({ documentStore: () => documents }));
const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const profile = {
  id: 'preview',
  name: 'Preview',
  environment: 'test',
  argv: ['node', 'deploy.mjs'],
  readbackArgv: ['node', 'check.mjs'],
  envRefs: ['DEPLOY_TOKEN'],
  timeoutMs: 30000,
};
const plan = {
  target,
  profile,
  configRevision: 1,
  fingerprint: 'a'.repeat(64),
  source: { commit: 'b'.repeat(40), tree: 'c'.repeat(64), dirty: true },
};
const receipt = {
  operationId: 'deploy_1',
  target,
  state: 'uncertain',
  plan,
  phase: 'settled',
  exitCode: 0,
  cleanupConfirmed: true,
  readback: null,
  reason: null,
  createdAt: '2026-10-23T00:00:00Z',
  updatedAt: '2026-10-23T00:00:00Z',
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  documents.setState({ documents: {} });
  vi.unstubAllGlobals();
});
async function mount(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.api = {
    deployments: vi.fn(async () => ({ profiles: [profile], deployments: [] })),
    worktree: vi.fn(async () => ({ bindingId: 'binding', copyGeneration: 1, missing: false })),
    inspectDeployment: vi.fn(async () => plan),
    startDeployment: vi.fn(async (_session, input) => ({
      ...receipt,
      operationId: input.operationId,
    })),
    deployment: vi.fn(async (_session, operationId) => ({ ...receipt, operationId })),
    checkDeployment: vi.fn(async (_session, operationId) => ({
      ...receipt,
      operationId,
      state: 'succeeded',
      readback: {
        operationId,
        sourceCommit: plan.source.commit,
        sourceTree: plan.source.tree,
        deploymentId: 'remote_1',
        environment: 'test',
        status: 'succeeded',
        url: 'https://example.test/app',
      },
    })),
    stopDeployment: vi.fn(),
    ...overrides,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async (sessionId = 'session') =>
    act(async () => root.render(<DeploymentTasks sessionId={sessionId} projectId="project" />));
  await render();
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === text,
    );
  return { container, button, render };
}

it('[TC-WBD-024-H] [TC-WBD-024-N] reviews source and credential references before an explicit start, then checks a separate result', async () => {
  const f = await mount();
  expect(fixture.api.inspectDeployment).not.toHaveBeenCalled();
  expect(fixture.api.startDeployment).not.toHaveBeenCalled();
  await act(async () => f.button('review')?.click());
  expect(f.container.textContent).toContain('DEPLOY_TOKEN');
  expect(f.container.textContent).toContain(plan.source.commit);
  expect(f.button('start')?.disabled).toBe(true);
  await act(async () =>
    f.container.querySelector<HTMLInputElement>('input[type=checkbox]')?.click(),
  );
  await act(async () => f.button('start')?.click());
  expect(fixture.api.startDeployment).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({ target, fingerprint: plan.fingerprint, allowDirty: true }),
  );
  expect(fixture.api.checkDeployment).not.toHaveBeenCalled();
  expect(f.container.textContent).toContain('unverified');
  await act(async () => f.button('checkResult')?.click());
  expect(f.container.querySelector('a')?.href).toBe('https://example.test/app');
  expect(f.container.textContent).toContain('result.succeeded');
});

it('[TC-WBD-024-F] keeps a lost start on the same operation and does not redeploy during receipt recovery', async () => {
  const f = await mount();
  fixture.api.startDeployment = vi.fn(async () => {
    throw new Error('Connection lost');
  });
  await act(async () => f.button('review')?.click());
  await act(async () =>
    f.container.querySelector<HTMLInputElement>('input[type=checkbox]')?.click(),
  );
  await act(async () => f.button('start')?.click());
  const start = vi.mocked(fixture.api.startDeployment as (...args: unknown[]) => Promise<unknown>);
  const input = start.mock.calls[0]?.[1] as { operationId: string } | undefined;
  expect(input).toBeDefined();
  const id = input?.operationId;
  expect(f.button('start')).toBeUndefined();
  await act(async () => f.button('refreshReceipt')?.click());
  expect(fixture.api.deployment).toHaveBeenCalledWith('session', id);
  expect(start).toHaveBeenCalledTimes(1);
});

it('[TC-WBD-024-N] ignores a late review after a session change and blocks unsaved buffers', async () => {
  const f = await mount();
  let resolve: (value: typeof plan) => void = () => {};
  fixture.api.inspectDeployment = vi.fn(
    () =>
      new Promise((accept) => {
        resolve = accept;
      }),
  );
  await act(async () => f.button('review')?.click());
  await f.render('other');
  await act(async () => resolve(plan));
  expect(f.container.textContent).not.toContain(plan.source.commit);
  await f.render();
  await act(async () => documents.setState({ documents: { file: { target, dirty: true } } }));
  expect(f.button('review')?.disabled).toBe(true);
});

it('[TC-WBD-024-N] rechecks unsaved buffers immediately before starting after a target lookup', async () => {
  const f = await mount();
  await act(async () => f.button('review')?.click());
  await act(async () =>
    f.container.querySelector<HTMLInputElement>('input[type=checkbox]')?.click(),
  );
  let resolve: (value: unknown) => void = () => {};
  fixture.api.worktree = vi.fn(
    () =>
      new Promise((accept) => {
        resolve = accept;
      }),
  );
  await act(async () => f.button('start')?.click());
  await act(async () => documents.setState({ documents: { file: { target, dirty: true } } }));
  await act(async () => resolve({ bindingId: 'binding', copyGeneration: 1, missing: false }));
  expect(fixture.api.startDeployment).not.toHaveBeenCalled();
});

it('[TC-WBD-024-F] ending local verification preserves an unknown external result without offering an ineffective check', async () => {
  const f = await mount();
  fixture.api.stopDeployment = vi.fn(async (_session, operationId) => ({
    ...receipt,
    operationId,
    state: 'cancelled',
    reason: 'stopped_remote_unknown',
  }));
  await act(async () => f.button('review')?.click());
  await act(async () =>
    f.container.querySelector<HTMLInputElement>('input[type=checkbox]')?.click(),
  );
  await act(async () => f.button('start')?.click());
  await act(async () => f.button('finish')?.click());
  expect(fixture.api.stopDeployment).toHaveBeenCalledOnce();
  expect(f.button('checkResult')).toBeUndefined();
  expect(f.container.textContent).toContain('unverified');
  expect(f.container.textContent).toContain('reason.stopped_remote_unknown');
  expect(fixture.api.startDeployment).toHaveBeenCalledTimes(1);
});

it('[TC-WBD-024-N] a definitive admission refusal requires a fresh review instead of trapping recovery on an absent operation', async () => {
  const f = await mount();
  fixture.api.startDeployment = vi.fn(async () => {
    throw new ApiError(409, 'REVISION_CONFLICT', 'Source changed');
  });
  await act(async () => f.button('review')?.click());
  await act(async () =>
    f.container.querySelector<HTMLInputElement>('input[type=checkbox]')?.click(),
  );
  await act(async () => f.button('start')?.click());
  expect(f.button('refreshReceipt')).toBeUndefined();
  expect(f.button('review')?.disabled).toBe(false);
  expect(f.button('start')).toBeUndefined();
  expect(fixture.api.startDeployment).toHaveBeenCalledTimes(1);
});

it('[TC-WBD-024-N] a session without a working copy does not read deployments until a copy is created', async () => {
  let hasCopy = false;
  const f = await mount({
    worktree: async () =>
      hasCopy ? { bindingId: 'binding', copyGeneration: 1, missing: false } : null,
  });
  expect(fixture.api.deployments).not.toHaveBeenCalled();
  expect(f.container.querySelector('[data-testid="deployment-tasks"]')).toBeNull();
  hasCopy = true;
  await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
  expect(fixture.api.deployments).toHaveBeenCalledExactlyOnceWith('session');
  expect(f.button('review')).toBeDefined();
});
