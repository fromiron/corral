// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import {
  panelMemoryKey,
  parsePanelMemory,
  serializePanelMemory,
} from '../workbench/panel/memory.ts';
import type { PanelTab, TabKey } from '../workbench/panel/tabs.ts';
import {
  createShellWorld,
  type MountedShell,
  mountShell,
  type ServerParts,
  type ShellWorld,
  settle,
  stubBrowser,
  WIDE,
} from './sessionShell.fixture.tsx';

// The 문서 tabs of a conversation's Paddock (features/session-panel.md 문서 탭, 주소와 기억):
// `panel=document&file=…` opens the file's tab; a restored tab stays until its file is read and is
// dropped when the file is gone or its copy is no longer the conversation's Paddock, opening 파일
// in its place when it leaves a draft. The editor inside is the document panel's own (its tests
// cover it), stood in for here.

vi.mock('../workbench/DockDocumentPanel.tsx', () => ({
  DockDocumentPanel: ({ path }: { path: string }) => <div data-testid="document-leaf">{path}</div>,
}));

vi.setConfig({ testTimeout: 20_000 });

const W = {
  files: messages.Docking.files,
  runNumber: (n: number) => messages.Workbench.runNumber.replace('{number}', String(n)),
  recovery: messages.Documents.recovery,
};
/** The copy the fixture's conversation has now, and one it had before. */
const NOW = { bindingId: 'binding', generation: 1 };
const BEFORE = { bindingId: 'binding_before', generation: 1 };

const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  cleanups.push(stubBrowser());
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
async function open(at: ShellWorld, address: string) {
  const shell = await mountShell(at, [address], { width: WIDE });
  cleanups.push(() => shell.unmount());
  return shell;
}
function remember(sessionId: string, tabs: PanelTab[], selected: TabKey | null) {
  window.localStorage.setItem(
    panelMemoryKey(sessionId),
    serializePanelMemory({ tabs, selected, open: true }),
  );
}
const doc = (path: string, copy = NOW): PanelTab => ({
  kind: 'document',
  source: 'copy',
  path,
  copy,
});
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
const selectedName = () => {
  const tab = tabs().find((item) => item.getAttribute('aria-selected') === 'true');
  return tab ? tabName(tab) : null;
};
const leaf = () => side()?.querySelector('[data-testid="document-leaf"]')?.textContent ?? null;
const remembered = (sessionId: string) =>
  parsePanelMemory(window.localStorage.getItem(panelMemoryKey(sessionId)));
const entries = (shell: MountedShell) => shell.history.length;

it('새 페이지를 panel=document와 file=notes.md 주소로 연다 → 그 파일의 문서 탭이 열려 선택되고 그 문서를 보인다', async () => {
  const { world: at, server } = await world();
  const shell = await open(at, `/sessions/${at.sessionId}?panel=document&file=${server.path}`);
  await until(() => leaf() === server.path);

  expect(tabNames()).toEqual([server.path]);
  expect(selectedName()).toBe(server.path);
  expect(leaf()).toBe(server.path);
  const search = shell.router.state.location.search as Record<string, unknown>;
  expect(search.panel).toBe('document');
  expect(search.file).toBe(server.path);
  // Once read, the tab carries the copy it was read from.
  await until(() => Boolean(remembered(at.sessionId)?.tabs.some((tab) => 'copy' in tab)));
  expect(remembered(at.sessionId)?.tabs).toEqual([doc(server.path)]);
});

it('대화의 기억에 사본의 문서 a.ts와 b.ts 탭이 있고 지금 Paddock에는 a.ts가 없다 → 그 대화를 열고 두 파일을 읽는다 → a.ts 탭은 버려지고 b.ts 탭은 남으며 파일 탭은 열리지 않고 기록은 쌓이지 않는다', async () => {
  const { world: at, server } = await world();
  server.removeFile('a.ts');
  remember(at.sessionId, [doc('a.ts'), doc('b.ts')], 'document:copy:b.ts');
  const shell = await open(at, `/sessions/${at.sessionId}`);
  const before = entries(shell);
  await until(() => tabNames().length === 1);

  expect(tabNames()).toEqual(['b.ts']);
  expect(selectedName()).toBe('b.ts');
  await settle();
  expect(tabNames()).toEqual(['b.ts']);
  expect(entries(shell)).toBe(before);
});

it('대화의 기억에 사본의 문서 a.ts 탭과 실행 #1 탭이 이 순서로 있고 a.ts가 선택돼 있으며 a.ts에 저장하지 않은 초안이 남아 있고, 그 뒤 Paddock이 다시 만들어졌다 → 그 대화를 연다 → a.ts 탭이 버려진 자리에 파일 탭이 열려 선택되고 복구 카드에 a.ts의 초안이 보인다', async () => {
  const { world: at, server } = await world();
  const runId = await at.startRun();
  server.keepDraft('a.ts', BEFORE);
  remember(at.sessionId, [doc('a.ts', BEFORE), { kind: 'run', runId }], 'document:copy:a.ts');
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames()[0] === W.files);

  expect(tabNames()).toEqual([W.files, W.runNumber(1)]);
  expect(selectedName()).toBe(W.files);
  const card = () => side()?.querySelector(`section[aria-label="${W.recovery}"]`);
  await until(() => Boolean(card()));
  expect(card()?.querySelector('summary')?.textContent).toBe('a.ts');
});

it('대화의 기억에 사본의 문서 a.ts 탭과 실행 #1 탭이 있고 a.ts에는 저장하지 않은 초안이 없으며, 그 뒤 Paddock이 다시 만들어졌다 → 그 대화를 연다 → a.ts 탭은 버려지고 파일 탭은 열리지 않는다', async () => {
  const { world: at } = await world();
  const runId = await at.startRun();
  remember(at.sessionId, [doc('a.ts', BEFORE), { kind: 'run', runId }], 'document:copy:a.ts');
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames().length === 1);

  expect(tabNames()).toEqual([W.runNumber(1)]);
  expect(selectedName()).toBe(W.runNumber(1));
  await settle();
  expect(tabNames()).toEqual([W.runNumber(1)]);
});

it('대화의 기억에 사본의 문서 a.ts 탭이 있다 → 그 대화를 열고 a.ts를 읽지 못한다 → a.ts 탭은 남고 읽지 못한 까닭을 보인다', async () => {
  const { world: at, server } = await world();
  server.failRead('a.ts');
  remember(
    at.sessionId,
    [{ kind: 'document', source: 'copy', path: 'a.ts' }],
    'document:copy:a.ts',
  );
  await open(at, `/sessions/${at.sessionId}`);
  const reason = () => side()?.querySelector('[role="alert"]')?.textContent ?? null;
  await until(() => Boolean(reason()));

  expect(tabNames()).toEqual(['a.ts']);
  expect(reason()).toBeTruthy();
  await settle();
  expect(tabNames()).toEqual(['a.ts']);
});
