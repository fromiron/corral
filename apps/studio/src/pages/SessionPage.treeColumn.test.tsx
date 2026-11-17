// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { panelMemoryKey, serializePanelMemory } from '../workbench/panel/memory.ts';
import type { PanelTab, TabKey } from '../workbench/panel/tabs.ts';
import { PANEL_WIDTH_KEY } from '../workbench/panel/width.ts';
import {
  createShellWorld,
  type MountedShell,
  mountShell,
  type ServerParts,
  type ShellWorld,
  settle,
  stubBrowser,
} from './sessionShell.fixture.tsx';

// The wide panel's tree column (features/session-panel.md 파일 탭과 트리 열): from 800px the tree is a
// 300px column beside the selected 문서 tab, and 파일 leaves the strip while a 문서 tab is open.
// The document's editor is the document panel's own, stood in for here.

vi.mock('../workbench/DockDocumentPanel.tsx', () => ({
  DockDocumentPanel: ({ path }: { path: string }) => <div data-testid="document-leaf">{path}</div>,
}));

vi.setConfig({ testTimeout: 20_000 });

const W = {
  files: messages.Docking.files,
  closeFiles: messages.SessionPanel.close.replace('{name}', messages.Docking.files),
  maximize: messages.SessionPanel.maximize,
  restore: messages.SessionPanel.restore,
};
/** Beside the conversation at this work area, with 900px remembered, the panel is 900px wide. */
const ROOMY = 1600;
/** At this one it is 740px: narrow. */
const TIGHT = 1300;
const COPY = { bindingId: 'binding', generation: 1 };

const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  cleanups.push(stubBrowser());
  window.localStorage.setItem(PANEL_WIDTH_KEY, '900');
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function world() {
  const made = await createShellWorld({ server: true, folder: true });
  return { world: made, server: made.server as ServerParts };
}
async function open(at: ShellWorld, address: string, width = ROOMY) {
  const shell = await mountShell(at, [address], { width });
  cleanups.push(() => shell.unmount());
  return shell;
}
function remember(sessionId: string, tabs: PanelTab[], selected: TabKey | null) {
  window.localStorage.setItem(
    panelMemoryKey(sessionId),
    serializePanelMemory({ tabs, selected, open: true }),
  );
}
const doc = (path: string): PanelTab => ({ kind: 'document', source: 'copy', path, copy: COPY });
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
}

const side = () => document.querySelector<HTMLElement>('[data-slot="side-panel-side"]');
function tabs(): HTMLElement[] {
  const strip = side()?.querySelector(
    `[role="tablist"][aria-label="${messages.SessionPanel.tabs}"]`,
  );
  return [...(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
}
const tabName = (tab: HTMLElement) =>
  (
    tab.querySelector('[data-slot="tabs-closable-label"]')?.textContent ??
    tab.textContent ??
    ''
  ).trim();
const tabNames = () => tabs().map(tabName);
const selectedTab = () => tabs().find((item) => item.getAttribute('aria-selected') === 'true');
const selectedName = () => {
  const tab = selectedTab();
  return tab ? tabName(tab) : null;
};
const column = () =>
  side()?.querySelector<HTMLElement>(`[role="region"][aria-label="${W.files}"]`) ?? null;
const leaf = () => side()?.querySelector('[data-testid="document-leaf"]')?.textContent ?? null;
const search = (shell: MountedShell) =>
  shell.router.state.location.search as Record<string, unknown>;
const button = (name: string) =>
  [...(side()?.querySelectorAll<HTMLElement>('button') ?? [])].find(
    (node) => node.getAttribute('aria-label') === name,
  ) ?? null;
const visible = (element: HTMLElement | null) => Boolean(element && !element.closest('[hidden]'));

it('패널 폭이 900px이고 파일 · a.ts · b.ts 탭이 열려 a.ts가 선택돼 있다 → 탭 줄에는 a.ts와 b.ts만 있고 트리가 a.ts 왼쪽의 열에 있다; b.ts를 고르면 트리 열은 b.ts 옆에 있다', async () => {
  const { world: at } = await world();
  remember(at.sessionId, [{ kind: 'files' }, doc('a.ts'), doc('b.ts')], 'document:copy:a.ts');
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => leaf() === 'a.ts' && Boolean(column()));

  expect(tabNames()).toEqual(['a.ts', 'b.ts']);
  expect(visible(column())).toBe(true);
  // The column comes before the document: the tree first in the Tab order.
  const content = side()?.querySelector('[data-testid="document-leaf"]');
  expect(
    (column()?.compareDocumentPosition(content as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const panel = column();

  await act(async () => tabs()[1]?.click());
  await until(() => leaf() === 'b.ts' || selectedName() === 'b.ts');
  await until(() => side()?.querySelectorAll('[data-testid="document-leaf"]').length === 2);
  expect(selectedName()).toBe('b.ts');
  expect(visible(column())).toBe(true);
  // The same tree: not mounted again.
  expect(column()).toBe(panel);
});

it('패널 폭이 900px이고 파일 탭만 열려 있다 → 파일 탭이 탭 줄에 있고 트리가 본문을 채운다; 문서를 열면 파일 탭은 탭 줄에서 빠지고 트리는 그 옆의 열이 된다', async () => {
  const { world: at, server } = await world();
  remember(at.sessionId, [{ kind: 'files' }], 'files');
  const shell = await open(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames().length === 1);
  expect(tabNames()).toEqual([W.files]);
  expect(column()).toBeNull();
  const tree = side()?.querySelector(`#${CSS.escape('session-panel-panel-files')}`);

  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: at.sessionId },
      search: { panel: 'document', file: server.path } as never,
    });
  });
  await until(() => leaf() === server.path && Boolean(column()));

  expect(tabNames()).toEqual([server.path]);
  expect(visible(column())).toBe(true);
  // The same tree, not mounted again: the 파일 tab's own panel turned into the column.
  expect(column()).toBe(tree);
});

it('패널 폭이 900px이고 파일 · a.ts 탭이 열려 트리 열이 있다 → 트리 열 머리의 "파일 닫기" → 트리 열이 없어지고 파일 탭은 닫히며 a.ts가 선택된 채 포커스는 탭 줄의 a.ts 탭에 있다', async () => {
  const { world: at } = await world();
  remember(at.sessionId, [{ kind: 'files' }, doc('a.ts')], 'document:copy:a.ts');
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => Boolean(column()) && Boolean(button(W.closeFiles)));

  await act(async () => button(W.closeFiles)?.focus());
  await act(async () => button(W.closeFiles)?.click());
  await until(() => !column());
  await settle();

  expect(column()).toBeNull();
  expect(tabNames()).toEqual(['a.ts']);
  expect(selectedName()).toBe('a.ts');
  await until(() => document.activeElement === selectedTab());
  expect(document.activeElement).toBe(selectedTab());
});

it('패널 폭이 900px이고 파일 · a.ts 탭이 열려 a.ts가 선택돼 있다 → a.ts 탭을 닫는다 → 파일 탭이 다시 그려져 선택되고 트리가 본문을 채운다', async () => {
  const { world: at } = await world();
  remember(at.sessionId, [{ kind: 'files' }, doc('a.ts')], 'document:copy:a.ts');
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => Boolean(column()));

  const close = side()?.querySelector<HTMLElement>('[data-slot="tabs-closable-close"]');
  await act(async () => close?.click());
  await until(() => tabNames().length === 1 && selectedName() === W.files);

  expect(tabNames()).toEqual([W.files]);
  expect(column()).toBeNull();
  expect(
    visible(
      side()?.querySelector<HTMLElement>(`#${CSS.escape('session-panel-panel-files')}`) ?? null,
    ),
  ).toBe(true);
});

it('패널이 옆이고 폭이 740px이며 파일 · a.ts 탭에서 파일 탭이 선택돼 있다 → 넓히기 → a.ts가 선택되고 트리는 그 옆의 열이며 기록은 쌓이지 않는다; 넓히기를 풀면 파일 탭이 a.ts 앞에 다시 그려지고 a.ts가 선택된 채다', async () => {
  const { world: at } = await world();
  remember(at.sessionId, [{ kind: 'files' }, doc('a.ts')], 'files');
  const shell = await open(at, `/sessions/${at.sessionId}`, TIGHT);
  await until(() => tabNames().length === 2);
  expect(tabNames()).toEqual([W.files, 'a.ts']);
  expect(selectedName()).toBe(W.files);
  const entries = shell.history.length;

  await act(async () => button(W.maximize)?.click());
  await until(() => Boolean(column()) && selectedName() === 'a.ts');

  expect(tabNames()).toEqual(['a.ts']);
  expect(search(shell)).toMatchObject({ panel: 'document', file: 'a.ts' });
  expect(shell.history.length).toBe(entries);

  await act(async () => button(W.restore)?.click());
  await until(() => tabNames().length === 2);
  expect(tabNames()).toEqual([W.files, 'a.ts']);
  expect(selectedName()).toBe('a.ts');
  expect(column()).toBeNull();
});

it('패널 폭이 740px이다 → 파일 · a.ts 탭이 열려 있어도 트리 열은 없고 파일 탭이 탭 줄에 있다 (반례)', async () => {
  const { world: at } = await world();
  remember(at.sessionId, [{ kind: 'files' }, doc('a.ts')], 'document:copy:a.ts');
  await open(at, `/sessions/${at.sessionId}`, TIGHT);
  await until(() => tabNames().length === 2);
  await settle();

  expect(tabNames()).toEqual([W.files, 'a.ts']);
  expect(column()).toBeNull();
});
