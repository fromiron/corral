// @vitest-environment jsdom
import { ApiError, type DevelopmentState } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { DevelopmentMode } from './DevelopmentMode.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllGlobals();
});
const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 's1',
  copyGeneration: 1,
};
const strict: DevelopmentState = { target, available: true, operation: null };
const shared: DevelopmentState = {
  ...strict,
  operation: {
    operationId: 'dev1',
    target,
    kind: 'development',
    requestHash: 'hash',
    state: 'running',
    result: null,
    createdAt: 'x',
    updatedAt: 'x',
  },
};
async function mount(api: Record<string, unknown>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.services = {
    workspaces: { worktree: async () => ({ missing: false }), ...api },
    workspaceId: 'host',
    mode: 'server',
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    element.remove();
  });
  const render = async (sessionId: string) => {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <DevelopmentMode sessionId={sessionId} />
        </IntlProvider>,
      ),
    );
  };
  await render('s1');
  return { element, render, button: () => element.querySelector('button') };
}
it('[TC-WBD-017-H] explicitly enables the returned target and shows external-write limits', async () => {
  let state = strict;
  const start = vi.fn(async () => {
    state = shared;
    return state;
  });
  const finish = vi.fn(async () => {
    state = strict;
    return state;
  });
  const view = await mount({
    developmentState: async () => state,
    startDevelopment: start,
    finishDevelopment: finish,
  });
  await act(async () => view.button()?.click());
  expect(start).toHaveBeenCalledWith('s1', expect.objectContaining({ target }));
  expect(view.element.textContent).toContain(messages.Development.sharedNote);
  await act(async () => view.button()?.click());
  expect(finish).toHaveBeenCalledWith('s1', 'dev1', target);
});
it('[TC-WBD-017-N] disabled hosts cannot opt in; uncertain state offers only explicit reconciliation', async () => {
  const enter = vi.fn();
  const view = await mount({
    developmentState: async (id: string) =>
      id === 's1'
        ? { ...strict, available: false }
        : {
            ...shared,
            target: { ...target, sessionId: id },
            operation: {
              ...shared.operation,
              target: { ...target, sessionId: id },
              state: 'uncertain',
            },
          },
    startDevelopment: enter,
    finishDevelopment: vi.fn(async () => {
      throw new ApiError(409, 'RUN_ALREADY_ACTIVE', 'task termination unconfirmed');
    }),
  });
  expect(view.button()).toBeNull();
  await view.render('s2');
  expect(view.element.textContent).toContain(messages.Development.uncertain);
  await act(async () => view.button()?.click());
  expect(view.element.textContent).toContain(messages.Development.blocked);
  expect(enter).not.toHaveBeenCalled();
});
it('[TC-WBD-017-F] an old session response never activates the new session', async () => {
  let resolve!: (state: DevelopmentState) => void;
  const view = await mount({
    developmentState: (id: string) =>
      id === 's1'
        ? new Promise<DevelopmentState>((done) => {
            resolve = done;
          })
        : Promise.resolve({ ...strict, target: { ...target, sessionId: id } }),
  });
  await view.render('s2');
  await act(async () => resolve(shared));
  expect(view.element.textContent).not.toContain(messages.Development.sharedNote);
});

it('[TC-WBD-017-N] a session without a working copy waits until one is created before reading development state', async () => {
  let hasCopy = false;
  const developmentState = vi.fn(async () => strict);
  const view = await mount({
    worktree: async () => (hasCopy ? { missing: false } : null),
    developmentState,
  });
  expect(developmentState).not.toHaveBeenCalled();
  expect(view.button()).toBeNull();
  hasCopy = true;
  await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
  expect(developmentState).toHaveBeenCalledExactlyOnceWith('s1');
  expect(view.button()).not.toBeNull();
});
