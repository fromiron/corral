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
import { PANEL_WIDTH_KEY } from '../workbench/panel/width.ts';
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
vi.mock('../workbench/PierreCode.tsx', () => ({
  SourceCode: ({ text }: { text: string }) => <pre data-testid="source-code">{text}</pre>,
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

const original = (path: string): PanelTab => ({ kind: 'document', source: 'original', path });
const sourceShown = () => side()?.querySelector('[data-testid="source-code"]')?.textContent ?? null;

it('새 페이지를 panel=document와 file=README.md와 target=original 주소로 연다 → 원본 폴더의 README.md 읽기 전용 탭이 열려 선택되고 그 파일을 보인다', async () => {
  const { world: at } = await world();
  const shell = await open(
    at,
    `/sessions/${at.sessionId}?panel=document&file=README.md&target=original`,
  );
  await until(() => Boolean(sourceShown()));

  expect(tabNames()).toEqual(['README.md']);
  expect(selectedName()).toBe('README.md');
  expect(sourceShown()).toContain('# Release notes');
  expect(side()?.querySelector('[data-testid="document-leaf"]')).toBeNull();
  const search = shell.router.state.location.search as Record<string, unknown>;
  expect(search).toMatchObject({ panel: 'document', file: 'README.md', target: 'original' });
});

it('사본의 README.md 탭이 열려 있다 → 원본 폴더의 README.md 탭을 연다 → 두 탭이 따로 있고 원본 탭은 묻지 않고 닫힌다', async () => {
  const { world: at } = await world();
  remember(at.sessionId, [doc('README.md')], 'document:copy:README.md');
  const shell = await open(
    at,
    `/sessions/${at.sessionId}?panel=document&file=README.md&target=original`,
  );
  await until(() => tabNames().length === 2 && Boolean(sourceShown()));
  expect(tabNames()).toEqual(['README.md', 'README.md']);

  const close = side()?.querySelectorAll<HTMLElement>('[data-slot="tabs-closable-close"]')[1];
  expect(close).toBeTruthy();
  await act(async () => close?.click());
  await settle();
  expect(tabNames()).toEqual(['README.md']);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(leaf()).toBe('README.md');
  expect(shell.router.state.location.search).not.toHaveProperty('target');
});

it('대화의 기억에 원본 폴더의 README.md와 gone.md 탭이 있고 원본 폴더에 gone.md가 없다 → 그 대화를 연다 → gone.md 탭은 버려지고 README.md 탭은 남는다', async () => {
  const { world: at, server } = await world();
  server.removeFile('gone.md');
  remember(at.sessionId, [original('gone.md'), original('README.md')], 'document:original:gone.md');
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames().length === 1);

  expect(tabNames()).toEqual(['README.md']);
  expect(selectedName()).toBe('README.md');
  await settle();
  expect(tabNames()).toEqual(['README.md']);
});

it('대화의 기억에 원본 폴더의 README.md 탭이 있다 → 그 대화를 열고 README.md를 읽지 못한다 → 탭은 남고 읽지 못한 까닭을 보인다', async () => {
  const { world: at, server } = await world();
  server.failRead('README.md');
  remember(at.sessionId, [original('README.md')], 'document:original:README.md');
  await open(at, `/sessions/${at.sessionId}`);
  const reason = () => side()?.querySelector('[role="alert"]')?.textContent ?? null;
  await until(() => Boolean(reason()));

  expect(tabNames()).toEqual(['README.md']);
  await settle();
  expect(tabNames()).toEqual(['README.md']);
});

const refreshFiles = () =>
  side()?.querySelector<HTMLButtonElement>(
    `button[aria-label="${messages.Desktop.refreshFiles}"]`,
  ) ?? null;
const files: PanelTab = { kind: 'files' };
/** A 900px panel: the tree is a column beside the selected 문서 tab, so the tab stays on screen. */
async function openWide(at: ShellWorld, address: string) {
  window.localStorage.setItem(PANEL_WIDTH_KEY, '900');
  const shell = await mountShell(at, [address], { width: 1600 });
  cleanups.push(() => shell.unmount());
  return shell;
}

it('원본 폴더의 README.md 탭이 열려 있고 그 첫 줄은 "# 옛 제목"이다 → Corral 밖에서 그 첫 줄을 "# 새 제목"으로 고친 뒤 파일 탭의 "파일 새로고침"을 누른다 → README.md 탭의 첫 줄은 "# 새 제목"이다', async () => {
  const { world: at, server } = await world();
  server.editSource('README.md', '# 옛 제목\n');
  remember(at.sessionId, [files, original('README.md')], 'document:original:README.md');
  await openWide(at, `/sessions/${at.sessionId}`);
  await until(() => Boolean(sourceShown()?.includes('# 옛 제목')) && Boolean(refreshFiles()));
  expect(refreshFiles()).not.toBeNull();

  server.editSource('README.md', '# 새 제목\n');
  await act(async () => refreshFiles()?.click());
  await until(() => Boolean(sourceShown()?.includes('# 새 제목')));

  expect(sourceShown()).toContain('# 새 제목');
  expect(tabNames()).toEqual(['README.md']);
});

it('원본 폴더의 gone.md와 README.md 탭이 열려 있고 gone.md를 보고 있다 → Corral 밖에서 gone.md를 지우고 "파일 새로고침"을 누른다 → gone.md 탭은 버려지고 남은 README.md 탭이 선택되며, 기록은 쌓이지 않는다', async () => {
  const { world: at, server } = await world();
  remember(
    at.sessionId,
    [files, original('gone.md'), original('README.md')],
    'document:original:gone.md',
  );
  const shell = await openWide(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames().length === 2 && Boolean(refreshFiles()));
  await settle();
  expect(tabNames()).toEqual(['gone.md', 'README.md']);
  const before = entries(shell);

  server.removeFile('gone.md');
  await act(async () => refreshFiles()?.click());
  await until(() => tabNames().length === 1);

  expect(tabNames()).toEqual(['README.md']);
  expect(selectedName()).toBe('README.md');
  const search = shell.router.state.location.search as Record<string, unknown>;
  expect(search).toMatchObject({ panel: 'document', file: 'README.md', target: 'original' });
  expect(entries(shell)).toBe(before);
});

it('좁은 패널에서 파일 탭을 보고 있고 원본 폴더의 README.md와 gone.md 탭도 열려 있다 → gone.md를 지우고 "파일 새로고침"을 누른다 → 보이지 않던 gone.md 탭도 버려지고 파일 탭은 선택된 채 남는다', async () => {
  const { world: at, server } = await world();
  remember(at.sessionId, [files, original('README.md'), original('gone.md')], 'files');
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames().length === 3 && Boolean(refreshFiles()));
  await settle();

  server.removeFile('gone.md');
  await act(async () => refreshFiles()?.click());
  await until(() => tabNames().length === 2);

  expect(tabNames()).toEqual([W.files, 'README.md']);
  expect(selectedName()).toBe(W.files);
});

it('원본 폴더의 README.md 탭이 열려 있다 → "파일 새로고침"을 누르고 README.md를 읽지 못한다 → 파일이 없다는 답이 아니므로 탭은 남고 읽지 못한 까닭을 보인다 (반례)', async () => {
  const { world: at, server } = await world();
  remember(at.sessionId, [files, original('README.md')], 'document:original:README.md');
  await openWide(at, `/sessions/${at.sessionId}`);
  await until(() => Boolean(sourceShown()) && Boolean(refreshFiles()));

  server.failRead('README.md');
  await act(async () => refreshFiles()?.click());
  const reason = () => side()?.querySelector('[role="alert"]')?.textContent ?? null;
  await until(() => Boolean(reason()));
  await settle();

  expect(reason()).toBeTruthy();
  expect(tabNames()).toEqual(['README.md']);
});

it('Paddock이 없는 대화에서 빠른 열기로 원본 폴더의 README.md를 고른다 → 파일 탭은 열리지 않고 README.md 읽기 전용 탭이 열려 선택된다', async () => {
  const at = await createShellWorld({ folder: true });
  await open(at, `/sessions/${at.sessionId}`);
  await act(async () => {
    window.dispatchEvent(new Event('corral:quick-open'));
  });
  const option = () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (row) => row.textContent?.trim() === 'README.md',
    );
  await until(() => Boolean(option()));
  await act(async () => option()?.click());
  await until(() => Boolean(sourceShown()));

  expect(tabNames()).toEqual(['README.md']);
  expect(selectedName()).toBe('README.md');
  expect(sourceShown()).toContain('# Release notes');
});

it('대화의 기억에 원본 폴더의 README.md 탭이 있다 → 그 대화를 열고 원본 폴더가 그 읽기를 잘못된 요청으로 거절한다 → 파일이 없다는 답이 아니므로 탭은 남는다 (반례)', async () => {
  const { world: at, server } = await world();
  server.refuseRead('README.md');
  remember(at.sessionId, [original('README.md')], 'document:original:README.md');
  await open(at, `/sessions/${at.sessionId}`);
  const reason = () => side()?.querySelector('[role="alert"]')?.textContent ?? null;
  await until(() => Boolean(reason()));
  await settle();

  expect(tabNames()).toEqual(['README.md']);
});

const tabNamedAt = (index: number) => tabs()[index] ?? null;
/** Which icon a tab draws: its Lucide name (its stroke follows the selection). */
const iconOf = (tab: HTMLElement | null) =>
  tab
    ?.querySelector('[data-slot="tabs-closable-icon"] svg')
    ?.getAttribute('class')
    ?.split(' ')
    .find((name) => name.startsWith('lucide-')) ?? null;
const markOf = (tab: HTMLElement | null) =>
  tab?.querySelector('[data-slot="tabs-closable-mark"]') ?? null;

it('대화의 기억에 사본의 api/index.ts와 web/index.ts 탭이 있다 → 그 대화를 연다 → 두 탭의 이름과 접근 이름은 "index.ts — api"와 "index.ts — web"이다', async () => {
  const { world: at } = await world();
  remember(at.sessionId, [doc('api/index.ts'), doc('web/index.ts')], 'document:copy:api/index.ts');
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames().length === 2);

  expect(tabNames()).toEqual(['index.ts — api', 'index.ts — web']);
  for (const tab of tabs()) expect(tab.hasAttribute('aria-label')).toBe(false);
});

it('사본의 README.md 탭이 열려 있다 → 원본 폴더의 README.md 탭을 연다 → 원본 탭만 원본 폴더 표시를 달고 두 탭의 접근 이름은 "README.md"와 "README.md, project source folder"다', async () => {
  const { world: at } = await world();
  remember(at.sessionId, [{ kind: 'files' }, doc('README.md')], 'document:copy:README.md');
  await open(at, `/sessions/${at.sessionId}?panel=document&file=README.md&target=original`);
  await until(() => tabNames().length === 3);

  expect(tabNames()).toEqual([W.files, 'README.md', 'README.md']);
  expect(tabNamedAt(1)?.hasAttribute('aria-label')).toBe(false);
  expect(tabNamedAt(2)?.getAttribute('aria-label')).toBe(
    `README.md, ${messages.SessionPanel.sourceFolderSuffix}`,
  );
  // Its sign is a file's, never the 파일 tab's folder: two folders side by side would mislead.
  expect(iconOf(tabNamedAt(1))).toBeTruthy();
  expect(iconOf(tabNamedAt(2))).not.toBe(iconOf(tabNamedAt(1)));
  expect(iconOf(tabNamedAt(2))).not.toBe(iconOf(tabNamedAt(0)));
  expect(markOf(tabNamedAt(1))).toBeNull();
});

it('주소로 연 사본의 문서를 고치고 저장하지 않았다 → 그 탭은 미저장 표시를 달고 그 뜻을 설명으로 읽히며 이름은 그대로다', async () => {
  const { world: at, server } = await world();
  await open(at, `/sessions/${at.sessionId}?panel=document&file=${server.path}`);
  await until(() => leaf() === server.path);
  const tab = () => tabNamedAt(0);
  expect(tab()?.getAttribute('aria-description')).toBeNull();
  expect(markOf(tab())).toBeNull();

  const docKey = () => Object.keys(server.documents.getState().documents)[0] as string;
  await until(() => Boolean(server.documents.getState().documents[docKey()]?.model));
  await act(async () => {
    server.documents.getState().documents[docKey()]?.model?.setValue('first line\nedited\n');
  });
  await until(() => tab()?.getAttribute('aria-description') === messages.Documents.dirty);

  expect(tab()?.getAttribute('aria-description')).toBe(messages.Documents.dirty);
  expect(tabNames()).toEqual([server.path]);
  expect(tab()?.hasAttribute('aria-label')).toBe(false);
  expect(markOf(tab())).not.toBeNull();
});

it('문서 탭이 20개 열려 있다 → 빠른 열기로 다른 파일을 연다 → 새 탭은 열리지 않고 패널에 20개 한도의 안내가 보이며, 문서 탭 하나를 닫으면 안내가 사라진다', async () => {
  const { world: at, server } = await world();
  const twenty = Array.from({ length: 20 }, (_, n) => doc(`src/f${n}.ts`));
  remember(at.sessionId, twenty, 'document:copy:src/f0.ts');
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames().length === 20);
  const notice = () =>
    [...(side()?.querySelectorAll('[role="status"]') ?? [])].find(
      (node) => node.textContent === messages.Docking.tabLimit,
    ) ?? null;
  expect(notice()).toBeNull();

  await act(async () => {
    window.dispatchEvent(new Event('corral:quick-open'));
  });
  const option = () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes(server.path),
    );
  await until(() => Boolean(option()));
  await act(async () => option()?.click());
  await until(() => Boolean(notice()));

  expect(tabNames()).toHaveLength(20);
  expect(tabNames()).not.toContain(server.path);
  expect(notice()).not.toBeNull();

  const close = side()?.querySelector<HTMLElement>('[data-slot="tabs-closable-close"]');
  await act(async () => close?.click());
  await until(() => !notice());
  expect(tabNames()).toHaveLength(19);
  expect(notice()).toBeNull();
});

/** The fixture's file, opened by its address and changed without saving. */
async function editedDocument() {
  const { world: at, server } = await world();
  await open(at, `/sessions/${at.sessionId}?panel=document&file=${server.path}`);
  await until(() => leaf() === server.path);
  const docKey = () => Object.keys(server.documents.getState().documents)[0] as string;
  await until(() => Boolean(server.documents.getState().documents[docKey()]?.model));
  await act(async () => {
    server.documents.getState().documents[docKey()]?.model?.setValue('first line\nedited\n');
  });
  await until(() => server.documents.getState().documents[docKey()]?.dirty === true);
  const buffer = () => server.documents.getState().documents[docKey()];
  return { at, server, buffer };
}
const closeDialog = () =>
  document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
const dialogButton = (name: string) =>
  [...(closeDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.textContent === name,
  ) ?? null;
async function closeSelected() {
  const close = side()?.querySelector<HTMLElement>('[data-slot="tabs-closable-close"]');
  await act(async () => close?.click());
  await until(() => Boolean(closeDialog()));
}

it('사본의 문서 탭에 저장하지 않은 변경이 있다 → 그 탭을 닫는다 → 저장할지 묻고 포커스는 "계속 편집"에 있으며 탭은 그대로다; Escape → 대화상자가 닫히고 탭과 초안이 그대로이며 포커스는 그 탭에 있다', async () => {
  const { server, buffer } = await editedDocument();
  await closeSelected();

  expect(closeDialog()?.textContent).toContain(
    messages.Documents.closeTitle.replace('{path}', server.path),
  );
  await until(() => document.activeElement === dialogButton(messages.Documents.cancel));
  expect(document.activeElement).toBe(dialogButton(messages.Documents.cancel));
  expect(tabNames()).toEqual([server.path]);

  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  await until(() => !closeDialog());
  await settle();
  expect(closeDialog()).toBeNull();
  expect(tabNames()).toEqual([server.path]);
  expect(buffer()?.dirty).toBe(true);
  await until(() => document.activeElement === tabs()[0]);
  expect(document.activeElement).toBe(tabs()[0]);
});

it('닫기 확인이 떠 있다 → "저장하고 닫기"를 고르고 저장이 실패한다 → 대화상자는 닫히지 않고 실패를 알리며 탭과 초안은 그대로다', async () => {
  const { server, buffer } = await editedDocument();
  await closeSelected();
  await act(async () => dialogButton(messages.Documents.saveClose)?.click());
  await until(() => Boolean(closeDialog()?.querySelector('[role="alert"]')));

  expect(closeDialog()?.querySelector('[role="alert"]')?.textContent).toBe(
    messages.Documents.closeFailed,
  );
  expect(tabNames()).toEqual([server.path]);
  expect(buffer()?.dirty || Boolean(buffer()?.pendingSave)).toBe(true);
});

it('닫기 확인이 떠 있다 → "변경 버리기"를 고른다 → 탭이 닫히고 그 초안은 버려진다', async () => {
  const { buffer } = await editedDocument();
  await closeSelected();
  await act(async () => dialogButton(messages.Documents.discard)?.click());
  await until(() => tabNames().length === 0 && !closeDialog());

  expect(tabNames()).toEqual([]);
  expect(closeDialog()).toBeNull();
  expect(buffer()?.dirty ?? false).toBe(false);
});
