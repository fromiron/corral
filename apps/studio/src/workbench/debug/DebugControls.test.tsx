// @vitest-environment jsdom
import type { DebugSession, DebugState } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DebugControls } from './DebugControls.tsx';
import type { DebugCopy, DebugStore } from './store.ts';

vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) => <span>{children as string}</span>,
}));
vi.mock('../navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const configuration = {
  id: 'app',
  name: 'App',
  adapterId: 'adapter',
  runtime: 'node' as const,
  request: 'launch' as const,
  cwd: '.',
  program: 'app.js',
};
const session: DebugSession = {
  generation: 'debug_one',
  clientId: 'client',
  configId: 'app',
  configRevision: 1,
  fingerprint: 'a'.repeat(64),
  runtime: 'node',
  ownership: 'launched',
  state: 'paused',
  revision: 2,
  pauseId: 1,
  pausedThreadId: 'thread',
  canDisconnect: false,
  canStop: true,
  breakpoints: [],
  output: '',
  error: null,
};
const state: DebugState = {
  target,
  available: true,
  unavailableReason: null,
  configurations: [configuration],
  session: null,
};
const initial = {
  state,
  inspection: {
    target,
    configuration,
    adapter: { id: 'adapter', name: 'Adapter', argv: ['node', 'adapter.js'], timeoutMs: 30000 },
    configRevision: 1,
    fingerprint: session.fingerprint,
    trusted: false,
  },
  inspectionInput: { target, configId: 'app' },
  error: null,
  busy: false,
  pendingCommandId: null,
  commandResult: null,
  frame: null,
} as DebugCopy;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllGlobals();
});
async function mount(copy = initial) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const store = {
    clientId: 'client',
    inspect: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    command: vi.fn(async () => null),
    query: vi.fn(async () => ({
      generation: session.generation,
      pauseId: 1,
      revision: 2,
      frames: [
        {
          id: 'frame',
          name: 'main',
          source: {
            path: 'main.ts',
            name: 'main.ts',
            sha256: 'b'.repeat(64),
            line: 1,
            column: 1,
            mapped: true,
            reason: null,
          },
        },
      ],
    })),
    openFrame: vi.fn(async () => false),
    checkCommand: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  };
  const api = {
    tasks: vi.fn(async () => ({ tasks: [], candidates: { packageManager: null, scripts: [] } })),
    previews: vi.fn(async () => []),
  };
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const render = async (value = copy) =>
    act(async () =>
      root.render(
        <DebugControls
          api={api}
          target={target}
          copy={value}
          store={store as unknown as DebugStore}
        />,
      ),
    );
  await render();
  cleanups.push(async () => {
    await act(async () => root.unmount());
    node.remove();
  });
  const button = (key: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === key,
    );
  const click = async (key: string) => {
    expect(button(key), key).toBeDefined();
    await act(async () => button(key)?.click());
  };
  return { store, render, click, button };
}
it('[TC-WBD-023-H] requires reviewed trust before launching and distinguishes owned stop from task disconnect', async () => {
  const f = await mount();
  expect(f.store.start).not.toHaveBeenCalled();
  await f.click('review');
  expect(f.store.inspect).toHaveBeenCalledWith(target, 'app', {});
  expect(document.body.textContent).toContain('adapter.js');
  await f.click('trustStart');
  expect(f.store.start).toHaveBeenCalledWith(target, true);
  await f.render({ ...initial, state: { ...state, session } });
  expect(f.button('disconnect')).toBeUndefined();
  await f.click('stop');
  expect(f.store.command).toHaveBeenLastCalledWith(target, {
    generation: 'debug_one',
    revision: 2,
    pauseId: 1,
    kind: 'stop',
    threadId: 'thread',
  });
  await f.render({
    ...initial,
    busy: true,
    pendingCommandId: 'uncertain_evaluate',
    state: {
      ...state,
      session: { ...session, ownership: 'attached', canDisconnect: true, canStop: false },
    },
  });
  expect(f.button('stop')).toBeUndefined();
  await f.click('disconnect');
  expect(f.store.command).toHaveBeenLastCalledWith(
    target,
    expect.objectContaining({ kind: 'disconnect' }),
  );
});
it('[TC-WBD-023-F] clears an old paused view and never evaluates text until explicit submission', async () => {
  const f = await mount({ ...initial, state: { ...state, session } });
  const input = document.querySelector<HTMLInputElement>('input[aria-label="expression"]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'value + 1',
    );
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(f.store.command).not.toHaveBeenCalled();
  expect(f.button('evaluate')?.disabled).toBe(true);
  expect(document.body.textContent).toContain('selectFrame');
  await act(async () =>
    input?.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(f.store.command).not.toHaveBeenCalled();
  await f.click('mainmain.ts:1:1');
  expect(f.button('evaluate')?.disabled).toBe(false);
  await f.click('evaluate');
  expect(f.store.command).toHaveBeenCalledWith(
    target,
    expect.objectContaining({
      kind: 'evaluate',
      expression: 'value + 1',
      generation: 'debug_one',
      pauseId: 1,
      frameId: 'frame',
    }),
  );
  await f.render({
    ...initial,
    state: { ...state, session: { ...session, state: 'running', revision: 3 } },
  });
  expect(f.button('evaluate')?.disabled).toBe(true);
  expect(document.body.textContent).not.toContain('stackFrames');
});
