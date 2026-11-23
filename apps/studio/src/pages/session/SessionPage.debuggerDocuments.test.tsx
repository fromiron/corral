// @vitest-environment jsdom
import { act, useContext } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SourceNavigationContext } from '../../workbench/context/SourceAttachments.tsx';
import { panelMemoryKey, serializePanelMemory } from '../../workbench/panel/memory.ts';
import type { PanelTab, TabKey } from '../../workbench/panel/tabs.ts';
import {
  createShellWorld,
  type MountedShell,
  mountShell,
  NARROW,
  type ShellWorld,
  settle,
  stubBrowser,
  WIDE,
} from './sessionShell.fixture.tsx';

// A stack frame chosen in the bottom dock's debugger opens its document in the panel
// (features/session-panel.md 하단 도크, 디버그와 문서): no drawer over the dock, no history, and
// the focus stays in the debugger. The debugger stands in as a list of frames; the document's
// editor is the document panel's own, stood in for too.

vi.mock('../../workbench/DockDocumentPanel.tsx', () => ({
  DockDocumentPanel: ({ path }: { path: string }) => <div data-testid="document-leaf">{path}</div>,
}));
vi.mock('../../workbench/DebuggerPanel.tsx', () => ({
  DebuggerPanel: ({ sessionId, projectId }: { sessionId: string; projectId: string }) => {
    const navigation = useContext(SourceNavigationContext);
    const target = {
      hostId: 'host',
      projectId,
      sessionId,
      bindingId: 'binding',
      copyGeneration: 1,
    };
    return (
      <ul data-testid="stack">
        {['a.ts', 'b.ts', 'c.ts'].map((path) => (
          <li key={path}>
            <button type="button" onClick={() => navigation?.openDocument(target, path)}>
              {path}
            </button>
          </li>
        ))}
      </ul>
    );
  },
}));

vi.setConfig({ testTimeout: 20_000 });

const W = {
  files: messages.Docking.files,
  toggle: messages.SessionPanel.toggle,
  tabs: messages.SessionPanel.tabs,
};

const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => cleanups.push(stubBrowser()));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function world() {
  const made = await createShellWorld({ server: true, folder: true });
  const workspaces = made.services.workspaces as unknown as Record<string, unknown>;
  workspaces.binding = async () => ({ trusted: true });
  workspaces.debugState = async () => ({ sessions: [] });
  return made;
}
async function open(at: ShellWorld, address: string, width: number) {
  const shell = await mountShell(at, [address], { width });
  cleanups.push(() => shell.unmount());
  return shell;
}
function remember(sessionId: string, tabs: PanelTab[], selected: TabKey | null, open: boolean) {
  window.localStorage.setItem(
    panelMemoryKey(sessionId),
    serializePanelMemory({ tabs, selected, open }),
  );
}
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
}

const presentation = () =>
  document.querySelector('[data-slot="side-panel-frame"]')?.getAttribute('data-presentation') ??
  null;
const side = () => document.querySelector<HTMLElement>('[data-slot="side-panel-side"]');
const tabs = () => [
  ...(side()
    ?.querySelector(`[role="tablist"][aria-label="${W.tabs}"]`)
    ?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
];
const tabName = (tab: HTMLElement) =>
  (
    tab.querySelector('[data-slot="tabs-closable-label"]')?.textContent ??
    tab.textContent ??
    ''
  ).trim();
const selectedName = () => {
  const tab = tabs().find((item) => item.getAttribute('aria-selected') === 'true');
  return tab ? tabName(tab) : null;
};
const frameButton = (path: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="stack"] button')].find(
    (button) => button.textContent === path,
  ) ?? null;
const toggleButton = () =>
  [...document.querySelectorAll<HTMLElement>('button')].find(
    (button) =>
      button.getAttribute('aria-label') === W.toggle && button.hasAttribute('aria-pressed'),
  ) ?? null;
const search = (shell: MountedShell) =>
  shell.router.state.location.search as Record<string, unknown>;
async function choose(element: HTMLElement | null) {
  expect(element, 'the control is on screen').toBeTruthy();
  await act(async () => {
    element?.focus();
    element?.click();
  });
  await settle();
}

it('자리가 없고 패널은 닫힘이며 하단 도크의 디버그 탭에서 포커스가 프레임에 있다 → 프레임 a.ts를 고른다 → 패널은 닫힘이고 서랍은 뜨지 않으며 주소는 compose 그대로, 기록은 쌓이지 않고 포커스는 그 프레임에 남는다; 여닫기 버튼 → 서랍이 a.ts 탭을 보이며 뜬다', async () => {
  const at = await world();
  remember(at.sessionId, [{ kind: 'files' }], 'files', false);
  const shell = await open(at, `/sessions/${at.sessionId}?panel=debug`, NARROW);
  await until(() => Boolean(frameButton('a.ts')));
  expect(presentation()).toBe('closed');
  const entries = shell.history.length;

  await choose(frameButton('a.ts'));
  await settle();

  expect(presentation()).toBe('closed');
  expect(search(shell).panel).toBeUndefined();
  expect(shell.history.length).toBe(entries);
  expect(document.activeElement).toBe(frameButton('a.ts'));

  await choose(toggleButton());
  await until(() => presentation() === 'drawer');
  expect(presentation()).toBe('drawer');
  expect(tabs().map(tabName)).toEqual([W.files, 'a.ts']);
  expect(selectedName()).toBe('a.ts');
});

it('패널이 옆이고 파일 탭에서 변경 링크를 따라갔으며 하단 도크의 디버그 탭이 열려 있다 → 프레임 a.ts, b.ts, c.ts를 차례로 고른다 → 세 문서 탭이 열리고 c.ts가 선택되며 기록은 쌓이지 않는다; 뒤로 가기 한 번 → 주소는 panel=files이고 파일 탭이 선택된다', async () => {
  const at = await world();
  remember(at.sessionId, [{ kind: 'files' }], 'files', true);
  const shell = await open(at, `/sessions/${at.sessionId}?panel=debug`, WIDE);
  await until(() => Boolean(frameButton('a.ts')) && selectedName() === W.files);
  await until(() => search(shell).panel === 'files');
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: at.sessionId },
      search: { panel: 'changes' } as never,
    });
  });
  await until(() => search(shell).panel === 'changes');
  const entries = shell.history.length;

  for (const path of ['a.ts', 'b.ts', 'c.ts']) {
    await choose(frameButton(path));
    await until(() => selectedName() === path);
  }

  expect(tabs().map(tabName)).toEqual(expect.arrayContaining(['a.ts', 'b.ts', 'c.ts']));
  expect(selectedName()).toBe('c.ts');
  expect(presentation()).toBe('beside');
  expect(search(shell)).toMatchObject({ panel: 'document', file: 'c.ts' });
  expect(shell.history.length).toBe(entries);
  expect(document.activeElement).toBe(frameButton('c.ts'));

  await act(async () => shell.history.back());
  await until(() => search(shell).panel === 'files');
  await settle();
  expect(search(shell).panel).toBe('files');
  expect(selectedName()).toBe(W.files);
});
