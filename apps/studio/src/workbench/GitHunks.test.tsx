// @vitest-environment jsdom
import type { GitHunksRequest, GitHunks as GitHunksView } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GitHunks } from './GitHunks.tsx';

const services = vi.hoisted(() => ({ value: {} as object }));
vi.mock('../services.tsx', () => ({ useServices: () => services.value }));
vi.mock('use-intl', () => {
  const translate = (key: string, values?: { reason?: string }) =>
    values?.reason ? `${key}: ${values.reason}` : key;
  return { useTranslations: () => translate };
});
const request: GitHunksRequest = {
  target: {
    kind: 'session',
    hostId: 'host',
    projectId: 'project',
    bindingId: 'binding',
    sessionId: 'session',
    copyGeneration: 1,
  },
  side: 'unstaged',
  path: 'file.ts',
  head: 'a'.repeat(40),
  indexHash: 'b'.repeat(64),
};
const hunks = (input: GitHunksRequest): GitHunksView => ({
  ...input,
  kind: 'hunks',
  identity: 'c'.repeat(64),
  workingHash: 'd'.repeat(64),
  hunks: [
    { id: 'e'.repeat(64), header: '@@ -1 +1 @@', patch: '@@ -1 +1 @@\n-before\n+after' },
    { id: 'f'.repeat(64), header: '@@ -20 +20 @@', patch: '@@ -20 +20 @@\n-old\n+new' },
  ],
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllGlobals();
});
async function mount(read: (sessionId: string, request: GitHunksRequest) => Promise<GitHunksView>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  services.value = { mode: 'server', workspaceId: 'host', workspaces: { gitHunks: read } };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const onCommand = vi.fn(async () => {});
  const render = async (input = request, disabled = false) => {
    await act(async () =>
      root.render(
        <GitHunks sessionId="session" request={input} disabled={disabled} onCommand={onCommand} />,
      ),
    );
  };
  await render();
  cleanups.push(async () => {
    await act(async () => root.unmount());
    element.remove();
  });
  const submit = () =>
    [...element.querySelectorAll('button')].find((button) =>
      ['stage', 'unstage'].includes(button.textContent ?? ''),
    );
  return { element, onCommand, render, submit };
}

it('sends only checked hunks with the reviewed target and patch identity to the parent', async () => {
  const read = vi.fn(async (_session: string, input: GitHunksRequest) => hunks(input));
  const view = await mount(read);
  expect(view.submit()?.disabled).toBe(true);
  const pick = () => view.element.querySelectorAll<HTMLElement>('[role=checkbox][aria-label]')[1];
  await act(async () => pick()?.click());
  await view.render(request, true);
  expect(view.submit()?.disabled).toBe(true);
  await act(async () => view.submit()?.click());
  expect(view.onCommand).not.toHaveBeenCalled();
  await view.render();
  await act(async () => view.submit()?.click());
  const { kind: _kind, ...target } = request.target;
  expect(view.onCommand).toHaveBeenCalledWith({
    kind: 'stage_hunks',
    target,
    expect: { head: request.head, indexHash: request.indexHash },
    path: request.path,
    identity: 'c'.repeat(64),
    hunkIds: ['f'.repeat(64)],
  });
  await view.render({ ...request, side: 'staged' });
  expect(pick()?.getAttribute('aria-checked')).toBe('false');
  await act(async () => pick()?.click());
  await act(async () => view.submit()?.click());
  expect(view.onCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: 'unstage_hunks' }),
  );
  expect(read).toHaveBeenCalledTimes(2);
});

it('discards late or mismatched snapshots and explains unsupported file actions', async () => {
  let resolve!: (value: GitHunksView) => void;
  const read = vi.fn(
    async (_session: string, input: GitHunksRequest): Promise<GitHunksView> => ({
      ...input,
      kind: 'unsupported',
      reason: 'binary',
    }),
  );
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = await mount(read);
  await view.render({ ...request, path: 'image.png' });
  await act(async () => resolve(hunks(request)));
  expect(view.element.textContent).toContain('unsupported: reason.binary');
  expect(view.element.textContent).not.toContain('+after');
  expect(view.submit()).toBeUndefined();
  read.mockImplementationOnce(async (_session, input) => ({
    ...hunks(input),
    indexHash: '0'.repeat(64),
  }));
  await view.render({ ...request, path: 'changed.ts' });
  expect(view.element.textContent).toContain('changed');
  expect(view.element.querySelector('input')).toBeNull();
  expect(view.onCommand).not.toHaveBeenCalled();
});
