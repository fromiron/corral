// @vitest-environment jsdom
import type { LanguageInspection, LanguageState, WorkspaceTarget } from '@corral/contracts';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import type { DocumentBuffer, DocumentStore } from './documents/store.ts';
import { LanguageSupport } from './LanguageSupport.tsx';

type Copy = {
  state: LanguageState | null;
  inspection: LanguageInspection | null;
  error: string | null;
  busy: boolean;
};
const fixture = vi.hoisted(() => ({ controller: undefined as unknown }));
vi.mock('../services.tsx', () => ({ useServices: () => ({ workspaces: {}, mode: 'server' }) }));
vi.mock('./language/store.ts', () => ({
  languageStore: () => fixture.controller,
  languageCopyKey: (target: WorkspaceTarget) =>
    JSON.stringify([
      target.hostId,
      target.projectId,
      target.bindingId,
      target.sessionId,
      target.copyGeneration,
      '',
    ]),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/settings">{children}</a>,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllGlobals();
});
const target: WorkspaceTarget = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const key = (value: WorkspaceTarget) =>
  JSON.stringify([
    value.hostId,
    value.projectId,
    value.bindingId,
    value.sessionId,
    value.copyGeneration,
    '',
  ]);
const server = {
  id: 'ts',
  name: 'TypeScript',
  languageIds: ['typescript'],
  fileExtensions: ['.ts'],
  argv: ['typescript-language-server', '--stdio'],
  timeoutMs: 30000,
};
const inspection: LanguageInspection = {
  target,
  server,
  configRevision: 1,
  fingerprint: 'a'.repeat(64),
  trusted: false,
};
const available: LanguageState = {
  target,
  available: true,
  unavailableReason: null,
  servers: [server],
  session: null,
};
const idle: Copy = {
  state: available,
  inspection: null,
  error: null,
  busy: false,
};
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const store = createStore<{ copies: Record<string, Copy> }>(() => ({
    copies: { [key(target)]: idle },
  }));
  const patch = (copy: Copy) =>
    store.setState({ copies: { ...store.getState().copies, [key(target)]: copy } });
  const release = vi.fn();
  const controller = Object.assign(store, {
    retain: vi.fn(() => release),
    inspect: vi.fn(async () => patch({ ...idle, inspection })),
    start: vi.fn(async () => {
      patch({
        ...idle,
        state: {
          ...available,
          session: {
            generation: 'generation',
            clientId: 'client',
            serverId: 'ts',
            configRevision: 1,
            fingerprint: inspection.fingerprint,
            state: 'running',
            capabilities: {
              completion: true,
              definition: true,
              references: false,
              diagnostics: true,
              diagnosticPull: false,
              rename: false,
              codeActions: false,
              triggerCharacters: ['.'],
            },
            diagnostics: [],
            error: null,
          },
        },
      });
    }),
    stop: vi.fn(async () => patch(idle)),
  });
  fixture.controller = controller;
  const nextTarget = { ...target, copyGeneration: 2 };
  const owner = createStore(() => ({
    documents: {
      first: { target, path: 'main.ts', model: null } as DocumentBuffer,
      next: { target: nextTarget, path: 'main.ts', model: null } as DocumentBuffer,
    },
  })) as unknown as DocumentStore;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    element.remove();
  });
  const render = async (documentKey: string) => {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <LanguageSupport owner={owner} documentKey={documentKey} />
        </IntlProvider>,
      ),
    );
  };
  const click = async (label: string) => {
    const button = [...element.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  await render('first');
  return { element, render, click, controller, patch, nextTarget, release };
}

it('reviews the command before explicit trust and starts or stops that copy', async () => {
  const view = await mount();
  expect(view.controller.inspect).not.toHaveBeenCalled();
  expect(view.controller.start).not.toHaveBeenCalled();
  await view.click('Review command');
  expect(view.controller.inspect).toHaveBeenCalledWith(target, 'ts');
  expect(view.element.textContent).toContain('typescript-language-server');
  expect(view.element.textContent).toContain(inspection.fingerprint);
  await view.click('Trust and start');
  expect(view.controller.start).toHaveBeenCalledWith(target, true);
  expect(view.element.textContent).toContain('Completion');
  expect(view.element.textContent).not.toContain('References');
  await act(async () =>
    view.patch({
      ...idle,
      state: {
        ...available,
        session: view.controller.getState().copies[key(target)]?.state?.session ?? null,
        available: false,
        unavailableReason: 'untrusted',
      },
    }),
  );
  await view.click('Stop');
  expect(view.controller.stop).toHaveBeenCalledWith(target);
});

it('a recreated copy never shows the previous command review or error', async () => {
  const view = await mount();
  await view.click('Review command');
  await act(async () =>
    view.patch({
      ...idle,
      inspection,
      state: { ...available, available: false, unavailableReason: 'platform' },
    }),
  );
  expect(view.element.textContent).toContain(
    'Language support is currently available on Linux hosts only.',
  );
  expect(view.element.querySelector('button')).toBeNull();
  expect(view.element.textContent).not.toContain(inspection.fingerprint);
  await act(async () => view.patch({ ...idle, inspection, error: 'Old copy failed' }));
  expect(view.element.textContent).toContain('Old copy failed');
  await view.render('next');
  await act(async () => view.patch({ ...idle, inspection, error: 'Late old copy result' }));
  expect(view.element.textContent).not.toContain(inspection.fingerprint);
  expect(view.element.textContent).not.toContain('Old copy failed');
  expect(view.element.textContent).not.toContain('Late old copy result');
  expect(view.controller.start).not.toHaveBeenCalled();
  expect(view.controller.retain).toHaveBeenLastCalledWith(view.nextTarget);
  expect(view.release).toHaveBeenCalled();
});
