// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { publishTreeSource } from '../DocumentHeader.tsx';
import { OriginalDocumentTab } from './OriginalDocumentTab.tsx';
import { readSourceFilesAgain } from './sourceReread.ts';

Element.prototype.getAnimations ??= () => [];

// The read-only 문서 tab of the project's source folder (workbench.md 파일과 문서 탭): the file as
// the folder holds it, with a more menu that references lines into the conversation's input.
const host = vi.hoisted(() => ({
  readFile: vi.fn(async (_scope: unknown, path: string) => ({
    path,
    content: { kind: 'text', text: `# ${path}\nsecond\n` } as unknown,
  })),
  open: vi.fn(),
}));
vi.mock('../../services.tsx', () => {
  const services = {
    mode: 'server',
    workspaceId: 'local',
    workspaces: { readFile: host.readFile },
  };
  return { useServices: () => services };
});
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    search,
    ...props
  }: {
    children?: React.ReactNode;
    to: string;
    params?: { sessionId: string };
    search?: { panel?: string };
  }) => (
    <a
      {...props}
      href={`${to.replace('$sessionId', params?.sessionId ?? '')}?panel=${search?.panel ?? ''}`}
    >
      {children}
    </a>
  ),
}));
vi.mock('../documents/store.ts', () => ({ documentStore: () => ({ open: host.open }) }));
vi.mock('../PierreCode.tsx', () => ({
  SourceCode: ({ text }: { text: string }) => <pre data-source>{text}</pre>,
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  host.readFile.mockClear();
  host.open.mockClear();
  vi.unstubAllGlobals();
});

async function mount(path: string, onReference = vi.fn(), noCopy = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
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
        <OriginalDocumentTab
          projectId="project"
          sessionId="session"
          path={path}
          noCopy={noCopy}
          onReference={onReference}
        />
      </IntlProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, onReference };
}

it("shows the source folder's file read-only, read from the folder and never as a buffer", async () => {
  const { container } = await mount('README.md');

  expect(host.readFile).toHaveBeenCalledExactlyOnceWith(
    { kind: 'project', id: 'project' },
    'README.md',
  );
  expect(host.open).not.toHaveBeenCalled();
  expect(container.querySelector('[data-source]')?.textContent).toBe('# README.md\nsecond\n');
  const head = container.querySelector('[data-testid="document-header"]');
  expect(head?.textContent).toContain('README.md');
  expect(head?.textContent).toContain(messages.Files.readOnlyPreview);
  expect(container.querySelector('textarea, [contenteditable="true"]')).toBeNull();
});

it('its more menu references the lines typed into the conversation’s input', async () => {
  const { container, onReference } = await mount('README.md');
  const more = container.querySelector<HTMLElement>(
    `[aria-label="${messages.Documents.moreActions.replace('{path}', 'README.md')}"]`,
  );
  await act(async () => more?.click());
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => node.getAttribute('aria-label') === messages.Documents.referenceLinesMenu,
  );
  expect(row).toBeDefined();
  await act(async () => row?.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  const action = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (node) => node.textContent === messages.Desktop.referenceLines,
  );
  expect(action).toBeDefined();
  await act(async () => action?.click());

  expect(onReference).toHaveBeenCalledExactlyOnceWith({ path: 'README.md', start: 1, end: 1 });
});

it('a file the folder cannot read says why; another path reads that file', async () => {
  host.readFile.mockRejectedValueOnce(new Error('the file is unavailable'));
  const { container } = await mount('gone.md');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('the file is unavailable');
  expect(container.querySelector('[data-source]')).toBeNull();
});

it('beside a tree that shows the source folder its head does not name the source again; beside one showing the copy it does', async () => {
  const sourceName = messages.Desktop.sourceFolder;
  const badge = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="document-header"] *')].some(
      (node) => node.children.length === 0 && node.textContent === sourceName,
    );
  const withdraw = publishTreeSource('session', 'source');
  cleanups.push(async () => withdraw());
  const { container } = await mount('README.md');
  expect(badge(container)).toBe(false);

  await act(async () => {
    withdraw();
    const copy = publishTreeSource('session', 'copy');
    cleanups.push(async () => copy());
  });
  expect(badge(container)).toBe(true);
});

it("reads the file again when its conversation's tree is refreshed; another conversation's refresh reads nothing", async () => {
  const { container } = await mount('README.md');
  expect(host.readFile).toHaveBeenCalledTimes(1);
  host.readFile.mockImplementationOnce(async (_scope: unknown, path: string) => ({
    path,
    content: { kind: 'text', text: 'changed outside Corral\n' } as unknown,
  }));

  await act(async () => readSourceFilesAgain('other session'));
  expect(host.readFile).toHaveBeenCalledTimes(1);

  await act(async () => readSourceFilesAgain('session'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(host.readFile).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-source]')?.textContent).toBe('changed outside Corral\n');
});

it('without a Paddock, says under its head why it is read-only and links to the file-work setup', async () => {
  const { container } = await mount('README.md', vi.fn(), true);
  const note = container.querySelector('[data-slot="banner"]');
  expect(note?.textContent).toContain(messages.Files.noCopyReadOnly);
  const link = note?.querySelector('a');
  expect(link?.textContent).toBe(messages.Sessions.prepareWorkingCopy);
  expect(link?.getAttribute('href')).toBe('/sessions/session?panel=changes');
  const head = container.querySelector('[data-testid="document-header"]');
  expect(head?.compareDocumentPosition(note as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  await act(async () => link?.click());
  expect(host.readFile).toHaveBeenCalledTimes(1);
});

it('with a Paddock, has no setup note', async () => {
  const { container } = await mount('README.md');
  expect(container.querySelector('[data-slot="banner"]')).toBeNull();
});
