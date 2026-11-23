// @vitest-environment jsdom
import { act, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { registeredCommands } from '../../commandRegistry.ts';
import { dockMemoryKey, serializeDockMemory } from '../../workbench/panel/dock.ts';
import { panelMemoryKey, serializePanelMemory } from '../../workbench/panel/memory.ts';
import { WORKSPACE_CHANGED } from '../../workbench/workspaceEvents.ts';
import {
  createShellWorld,
  type MountedShell,
  mountShell,
  NARROW,
  type ShellWorld,
  settle,
  stubBrowser,
  type TerminalOptions,
  WIDE,
} from './sessionShell.fixture.tsx';

// The bottom dock in the session screen (features/session-panel.md 하단 도크): its button, its
// shortcut, its memory and what an empty dock shows when it opens. The terminal list is the
// fixture's fake host; nothing here runs a shell.

// A screen can be held back, as a real one attaches only once its terminal has loaded.
const screens = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const value = { held: false };
  return {
    value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    hold() {
      value.held = true;
    },
    release() {
      value.held = false;
      for (const listener of listeners) listener();
    },
  };
});
vi.mock('../../workbench/terminals/TerminalView.tsx', () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) => {
    const held = useSyncExternalStore(screens.subscribe, () => screens.value.held);
    return held ? null : (
      <section data-testid="terminal-leaf" data-terminal-screen="" tabIndex={-1}>
        <textarea aria-label="terminal input" data-terminal-input={terminalId} />
        {terminalId}
      </section>
    );
  },
}));

vi.setConfig({ testTimeout: 20_000 });

const W = {
  dock: messages.SessionPanel.dock,
  dockToggle: messages.SessionPanel.dockToggle,
  dockTabs: messages.SessionPanel.dockTabs,
  add: messages.SessionPanel.add,
  terminal: (n: number) => messages.SessionPanel.terminalTab.replace('{number}', String(n)),
  debug: messages.SessionPanel.debugTab,
  runningDot: messages.Terminals.runningTab,
  uncertainDot: messages.Terminals.uncertainTab,
  runActive: messages.Terminals.runActive,
  noCopy: messages.Files.noCopyTitle,
  makeCopy: messages.Files.makeCopyThere,
  runNumber: (n: number) => messages.Workbench.runNumber.replace('{number}', String(n)),
  toggle: messages.SessionPanel.toggle,
  maximize: messages.SessionPanel.maximize,
  terminalRow: messages.Docking.terminal,
  close: (name: string) => messages.SessionPanel.close.replace('{name}', name),
  listFailed: messages.Terminals.listUnread,
  retry: messages.Terminals.retryList,
  loading: messages.Terminals.loading,
  createPending: messages.Terminals.createPending,
  checkCreate: messages.Terminals.checkCreate,
  retryCreate: messages.Terminals.retryCreate,
};

const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  cleanups.push(stubBrowser());
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  screens.release();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(world: ShellWorld, address: string, width = WIDE) {
  const shell = await mountShell(world, [address], { width });
  cleanups.push(() => shell.unmount());
  return shell;
}

async function serverWorld(terminals: TerminalOptions = {}, folder = true) {
  return createShellWorld({ server: terminals, folder });
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
}

function spoken(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
  return [...node.childNodes].map(spoken).join('');
}
const nameOf = (element: Element) => (element.getAttribute('aria-label') ?? spoken(element)).trim();
function buttons(name: string, scope: ParentNode | null = document): HTMLElement[] {
  if (!scope) return [];
  return [
    ...scope.querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="menuitem"], [role="tab"]',
    ),
  ].filter((element) => nameOf(element) === name);
}

async function press(element: HTMLElement | null | undefined) {
  expect(element, 'the control to press is on screen').toBeTruthy();
  const target = element as HTMLElement;
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(event);
      if (type === 'mousedown' && !event.defaultPrevented) target.focus();
    }
    target.click();
  });
  await settle();
}
async function key(target: EventTarget, init: KeyboardEventInit & { key: string }) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await settle();
  return event;
}
const DOCK_KEY = { key: 'j', code: 'KeyJ', ctrlKey: true };

const dock = () => document.querySelector<HTMLElement>('[data-slot="side-panel-bottom"]');
const dockState = () => dock()?.getAttribute('data-state') ?? null;
const dockButton = () =>
  buttons(W.dock).find((button) => button.hasAttribute('aria-pressed')) ?? null;
const dockStrip = () =>
  dock()?.querySelector<HTMLElement>(`[role="tablist"][aria-label="${W.dockTabs}"]`) ?? null;
const dockTabs = () => [...(dockStrip()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
const tabName = (tab: HTMLElement) =>
  (
    tab.querySelector('[data-slot="tabs-closable-label"]')?.textContent ??
    tab.textContent ??
    ''
  ).trim();
const dockTabNames = () => dockTabs().map(tabName);
const dockSelected = () => {
  const tab = dockTabs().find((item) => item.getAttribute('aria-selected') === 'true');
  return tab ? tabName(tab) : null;
};
const dockPlus = () => buttons(W.add, dock()?.querySelector('[data-dock-head]') ?? null)[0] ?? null;
const composerInput = () =>
  document.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer"] textarea');
const terminalInput = () =>
  dock()?.querySelector<HTMLElement>('[data-terminal-screen] textarea') ?? null;
const frame = () => document.querySelector<HTMLElement>('[data-slot="side-panel-frame"]');
const presentation = () => frame()?.getAttribute('data-presentation') ?? null;
/** The body of a dock with no tab: its list of what it can open, or its one line. */
const dockList = () => dock()?.querySelector<HTMLElement>('[data-dock-list]') ?? null;
const dockLine = () => dock()?.querySelector<HTMLElement>('[data-dock-line]') ?? null;
/** The body list's 터미널 row (an unavailable one says why after its name). */
const terminalListRow = () =>
  [...(dockList()?.querySelectorAll<HTMLElement>('button') ?? [])].find((row) =>
    spoken(row).trim().startsWith(W.terminalRow),
  ) ?? null;
const menuRow = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    spoken(row).includes(name),
  ) ?? null;
/**
 * The dock's toggles only show it: a terminal's tab comes from its body's 터미널 row (the live
 * terminal where its tab is, or a new one, the first shell if it lists several).
 */
async function dockTerminal() {
  if (dockState() !== 'open') await press(dockButton());
  await until(() => Boolean(terminalListRow()));
  await press(terminalListRow());
  const shell = document.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]');
  if (shell) await press(shell);
  await until(() => dockSelected() !== null);
}

it('Paddock이 있고 터미널이 없으며 도크가 닫혀 있다 → 하단 도크 버튼 → 240px 도크에 탭도 "+"도 없이 목록만 있고 만들지 않는다; 터미널 줄 → 새 "터미널 1" 탭이 선택된다', async () => {
  const world = await serverWorld({ terminals: [] });
  await open(world, `/sessions/${world.sessionId}`);
  expect(dockState()).toBe('closed');
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('false');
  await press(dockButton());
  await until(() => Boolean(terminalListRow()));
  expect(dockState()).toBe('open');
  expect(dock()?.style.height).toBe('240px');
  expect(dockTabs()).toEqual([]);
  expect(dockPlus()).toBeNull();
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('true');
  await settle(20);
  expect(world.server?.created).toEqual([]);
  await until(() => document.activeElement === terminalListRow());
  expect(document.activeElement).toBe(terminalListRow());
  await press(terminalListRow());
  await until(() => dockSelected() === W.terminal(1));
  expect(dockTabNames()).toEqual([W.terminal(1)]);
  expect(dockSelected()).toBe(W.terminal(1));
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('true');
  expect(world.server?.created).toEqual(['bash']);
  // The person opened it: the focus is in the new terminal's input.
  await until(() => document.activeElement === terminalInput());
  expect(document.activeElement).toBe(terminalInput());
});

it('터미널 화면이 붙기 전에 사람이 포커스를 옮겼다 → 화면이 붙어도 포커스는 옮긴 곳에 남는다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`);
  screens.hold();
  await dockTerminal();
  // The wait for the input has looked at least once, then the person goes to the composer.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  await act(async () => {
    composerInput()?.focus();
  });
  await act(async () => {
    screens.release();
  });
  await until(() => Boolean(terminalInput()));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  expect(terminalInput()).not.toBeNull();
  expect(document.activeElement).toBe(composerInput());
});

it('셸이 둘이고 살아 있는 터미널이 없다 → 하단 도크 버튼 → 본문에 목록만 있고 만들지 않는다; 터미널 줄 → 셸을 고르는 하위 목록이 열린다', async () => {
  const world = await serverWorld({ terminals: [], shells: ['zsh', 'bash'] });
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => Boolean(terminalListRow()));
  await settle(20);
  expect(dockTabs()).toEqual([]);
  expect(world.server?.created).toEqual([]);
  await press(terminalListRow());
  await until(() => document.querySelectorAll('[role="menu"] [role="menuitem"]').length === 2);
  expect(document.querySelectorAll('[role="menu"] [role="menuitem"]')).toHaveLength(2);
  expect(world.server?.created).toEqual([]);
});

it('도크에 실행 중인 터미널 1 탭이 있다 → 버튼으로 닫는다 → 명령은 없고 버튼에 실행 중 점이 있어 설명으로 읽힌다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`);
  await dockTerminal();
  // The running terminal's tab opened: nothing was created.
  expect(dockSelected()).toBe(W.terminal(1));
  expect(world.server?.created).toEqual([]);
  expect(dockButton()?.getAttribute('aria-description') ?? '').toBe('');
  const calls = [...(world.server?.terminalCalls ?? [])];
  await press(dockButton());
  expect(dockState()).toBe('closed');
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('false');
  expect(
    world.server?.terminalCalls.filter((call) => call === 'stop' || call === 'create'),
  ).toEqual(calls.filter((call) => call === 'stop' || call === 'create'));
  expect(dockButton()?.getAttribute('aria-description')).toBe(W.runningDot);
  expect(dockButton()?.querySelector('[data-dock-dot="running"]')).not.toBeNull();
});

it('종료 확인이 필요한 터미널이 화면에 없으면 버튼의 점은 주의 점이고, 시작 중인 터미널에는 점이 없다', async () => {
  const uncertain = await serverWorld({ terminals: ['uncertain'] });
  const first = await open(uncertain, `/sessions/${uncertain.sessionId}`);
  await until(() => Boolean(dockButton()?.getAttribute('aria-description')));
  expect(dockButton()?.getAttribute('aria-description')).toBe(W.uncertainDot);
  expect(dockButton()?.querySelector('[data-dock-dot="warning"]')).not.toBeNull();
  await first.unmount();
  const starting = await serverWorld({ terminals: ['starting'] });
  await open(starting, `/sessions/${starting.sessionId}`);
  await settle();
  expect(dockButton()?.getAttribute('aria-description') ?? '').toBe('');
  expect(dockButton()?.querySelector('[data-dock-dot]')).toBeNull();
});

it('Paddock이 없는 대화이고 도크에 탭이 없다 → 버튼 → 탭도 "+"도 없고 목록 대신 한 줄 안내와 버튼 하나이며 포커스는 그 버튼에 있고, 터미널은 만들지 않는다', async () => {
  const world = await serverWorld({ terminals: [], noCopy: true });
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => dockState() === 'open');
  expect(dockState()).toBe('open');
  expect(dockTabs()).toEqual([]);
  expect(dockPlus()).toBeNull();
  expect(dockList()).toBeNull();
  const body = dockLine();
  expect(body?.textContent).toContain(W.noCopy);
  expect(body?.querySelectorAll('button')).toHaveLength(1);
  expect(buttons(W.makeCopy, body ?? null)).toHaveLength(1);
  await until(() => document.activeElement === buttons(W.makeCopy, body ?? null)[0]);
  expect(document.activeElement).toBe(buttons(W.makeCopy, body ?? null)[0]);
  expect(world.server?.created).toEqual([]);
});

it('살아 있는 터미널이 없고 실행이 진행 중이다 → 버튼 → 머리에 "+"가 없고 본문 목록의 터미널 줄이 까닭을 둘째 줄로 보이는 쓸 수 없는 줄이며 포커스가 그 줄에 있다; 실행이 끝나도 만들지 않고 그 줄로 만든다', async () => {
  const world = await createShellWorld({ server: { terminals: [] }, folder: true });
  const runId = await world.startRun();
  await world.working(runId, 1);
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => Boolean(terminalListRow()));
  expect(dockTabs()).toEqual([]);
  expect(dockPlus()).toBeNull();
  // No separate reason line: the row says why.
  expect(dockLine()).toBeNull();
  const row = terminalListRow();
  expect(row?.getAttribute('aria-disabled')).toBe('true');
  expect(row?.textContent).toContain(W.runActive);
  await until(() => document.activeElement === terminalListRow());
  expect(document.activeElement).toBe(terminalListRow());
  await press(terminalListRow());
  expect(world.server?.created).toEqual([]);
  expect(dockTabs()).toEqual([]);
  await world.releaseReplies();
  await world.runReaches(runId, ['succeeded']);
  await settle(20);
  // A run that ends makes no terminal by itself; the row only becomes usable.
  expect(world.server?.created).toEqual([]);
  await until(() => terminalListRow()?.getAttribute('aria-disabled') !== 'true');
  expect(terminalListRow()?.textContent).not.toContain(W.runActive);
  await press(terminalListRow());
  await until(() => dockSelected() === W.terminal(1));
  expect(dockSelected()).toBe(W.terminal(1));
  expect(world.server?.created).toEqual(['bash']);
});

it('터미널 목록을 읽지 못한다 → 하단 도크 버튼 → 목록 대신 읽지 못한 까닭 한 줄과 "다시 시도"이고 포커스는 그 버튼에 있으며, 누를 때만 다시 읽어 읽으면 본문은 목록이 되고 터미널은 만들지 않는다', async () => {
  const world = await serverWorld({ terminals: [] });
  world.server?.setReadsFail(true);
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => Boolean(dockLine()));
  expect(dockState()).toBe('open');
  expect(dockPlus()).toBeNull();
  expect(dockList()).toBeNull();
  expect(dockLine()?.textContent).toContain(W.listFailed);
  expect(dockLine()?.querySelectorAll('button')).toHaveLength(1);
  const retry = () => buttons(W.retry, dockLine())[0] ?? null;
  await until(() => document.activeElement === retry());
  expect(document.activeElement).toBe(retry());
  // Nothing reads the list again by itself.
  const asked = world.server?.lists() ?? 0;
  await settle(20);
  expect(world.server?.lists()).toBe(asked);

  world.server?.setReadsFail(false);
  await press(retry());
  await until(() => Boolean(terminalListRow()));
  expect(world.server?.lists()).toBe(asked + 1);
  expect(dockLine()).toBeNull();
  expect(terminalListRow()?.getAttribute('aria-disabled')).not.toBe('true');
  expect(dockTabs()).toEqual([]);
  expect(world.server?.created).toEqual([]);
});

it('도크 본문의 터미널 줄로 보낸 만들기의 응답을 잃었다 → 도크를 다시 열면 본문은 그 한 줄과 "생성 결과 확인"이고 포커스는 그 버튼에 있으며, 호스트에 그 요청이 없으면 "기존 생성 요청 다시 시도"가 같은 요청 ID로 다시 보낸다', async () => {
  const world = await serverWorld({ terminals: [], loseCreate: 'absent' });
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => Boolean(terminalListRow()));
  await press(terminalListRow());
  await until(() => Boolean(dockLine()?.textContent?.includes(W.createPending)));
  await press(dockButton());
  expect(dockState()).toBe('closed');
  await press(dockButton());
  await until(() => dockState() === 'open');
  const check = () => buttons(W.checkCreate, dockLine())[0] ?? null;
  expect(dockLine()?.textContent).toContain(W.createPending);
  expect(dockList()).toBeNull();
  await until(() => document.activeElement === check());
  expect(document.activeElement).toBe(check());
  // Nothing new is made while the first creation is unconfirmed.
  expect(world.server?.createIds).toHaveLength(1);
  expect(buttons(W.retryCreate, dockLine())).toHaveLength(0);

  await press(check());
  await until(() => buttons(W.retryCreate, dockLine()).length === 1);
  await press(buttons(W.retryCreate, dockLine())[0]);
  await until(() => (world.server?.createIds.length ?? 0) === 2);
  const [first, again] = world.server?.createIds ?? [];
  expect(again).toBe(first);
});

it('만든 터미널 1의 결과를 확인하지 못했다 → "생성 결과 확인"에 호스트가 터미널 1을 돌려준다 → 본문은 목록이 되고 터미널은 더 만들어지지 않는다', async () => {
  const world = await serverWorld({ terminals: [], loseCreate: 'made' });
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => Boolean(terminalListRow()));
  await press(terminalListRow());
  await until(() => buttons(W.checkCreate, dockLine()).length === 1);
  await press(buttons(W.checkCreate, dockLine())[0]);
  await until(() => Boolean(dockList()));
  expect(dockLine()).toBeNull();
  expect(world.server?.createIds).toHaveLength(1);
  // The list now knows terminal 1: its row selects it rather than making another.
  await press(terminalListRow());
  await until(() => dockSelected() === W.terminal(1));
  expect(world.server?.createIds).toHaveLength(1);
});

it('대화에 막 들어와 터미널 목록이 아직 답하지 않았다 → 하단 도크 버튼 → 본문이 잠깐 "터미널 여는 중…"이고, 목록이 답하면 본문은 목록이 되어 탭은 열리지 않고 만들지 않는다; 터미널 줄 → 터미널 1의 탭이 열린다', async () => {
  const world = await serverWorld({ holdLists: true });
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => dockState() === 'open');
  expect(dockLine()?.textContent).toContain(W.loading);
  await act(async () => world.server?.releaseLists());
  await until(() => Boolean(terminalListRow()));
  await settle(20);
  expect(dockTabs()).toEqual([]);
  expect(world.server?.created).toEqual([]);
  await press(terminalListRow());
  await until(() => dockSelected() === W.terminal(1));
  expect(dockSelected()).toBe(W.terminal(1));
  expect(world.server?.created).toEqual([]);
});

it('터미널 목록을 읽지 못해 도크 본문이 그 한 줄이다 → 그 대화의 Paddock이 없어진다 → 목록을 다시 읽어 본문은 Paddock이 없는 한 줄이 되고, Paddock을 만들면 목록이 되며 터미널은 만들지 않는다', async () => {
  const world = await serverWorld({ terminals: [] });
  world.server?.setReadsFail(true);
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => Boolean(dockLine()?.textContent?.includes(W.listFailed)));
  world.server?.setReadsFail(false);
  world.server?.setNoCopy(true);
  await act(async () => {
    window.dispatchEvent(new Event(WORKSPACE_CHANGED));
  });
  await until(() => Boolean(dockLine()?.textContent?.includes(W.noCopy)));
  expect(buttons(W.makeCopy, dockLine())).toHaveLength(1);
  world.server?.setNoCopy(false);
  await act(async () => {
    window.dispatchEvent(new Event(WORKSPACE_CHANGED));
  });
  await until(() => Boolean(dockList()));
  expect(dockLine()).toBeNull();
  expect(world.server?.created).toEqual([]);
});

it('도크에 탭이 없고 닫혀 있다 → 명령 팔레트의 "터미널 열기", 터미널 목록을 읽지 못한다 → 도크가 열려 그 한 줄과 "다시 시도"를 보이고, 아무 탭도 열지 않았으므로 포커스는 제자리에 있다', async () => {
  const world = await serverWorld({ terminals: [] });
  world.server?.setReadsFail(true);
  await open(world, `/sessions/${world.sessionId}`);
  await settle(20);
  await act(async () => composerInput()?.focus());
  const command = registeredCommands().find((item) => item.id === 'panel:terminal');
  await act(async () => void command?.run());
  await until(() => Boolean(dockLine()));
  expect(dockState()).toBe('open');
  expect(buttons(W.retry, dockLine())).toHaveLength(1);
  expect(dockPlus()).toBeNull();
  await settle(20);
  expect(document.activeElement).toBe(composerInput());
  expect(world.server?.created).toEqual([]);
});

it('도크의 마지막 탭을 닫는다 → 도크는 열린 채 머리에 "+"가 없고 본문에 목록을 보이며, 포커스는 목록의 첫 줄로 간다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`);
  await dockTerminal();
  // An idle terminal: closing its tab ends it without asking.
  await press(buttons(W.close(W.terminal(1)), dock())[0]);
  await until(() => dockTabs().length === 0);
  expect(dockState()).toBe('open');
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('true');
  expect(dockPlus()).toBeNull();
  expect(terminalListRow()).not.toBeNull();
  await until(() => document.activeElement === terminalListRow());
  expect(document.activeElement).toBe(terminalListRow());
  expect(world.server?.stops).toEqual(['terminal_one']);
});

it('도크가 열려 있고 포커스가 터미널 1의 입력에 있다 → Mod+J → 도크가 닫히고, 컴포저에서는 Mod+J가 아무것도 하지 않는다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`);
  await dockTerminal();
  await until(() => document.activeElement === terminalInput());
  expect(document.activeElement).toBe(terminalInput());
  await key(document.activeElement as HTMLElement, DOCK_KEY);
  expect(dockState()).toBe('closed');
  // The focus left the dock with it: back to what opened it.
  expect(document.activeElement).toBe(dockButton());
  composerInput()?.focus();
  await key(composerInput() as HTMLElement, DOCK_KEY);
  expect(dockState()).toBe('closed');
});

it('명령 팔레트에 "하단 도크 여닫기"가 있고 그 단축키는 Mod+J다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`);
  const command = registeredCommands().find((item) => item.title === W.dockToggle);
  expect(command?.shortcutId).toBe('view.dock');
  await act(async () => void command?.run());
  await until(() => dockState() === 'open');
  expect(dockState()).toBe('open');
});

it('자리가 없고 패널이 서랍이며 도크가 닫혀 있다 → 하단 도크 버튼 → 서랍이 닫히고 도크가 열린다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`, NARROW);
  await press(buttons(W.toggle).find((button) => button.hasAttribute('aria-pressed')));
  await until(() => presentation() === 'drawer');
  expect(presentation()).toBe('drawer');
  await press(dockButton());
  await until(() => dockState() === 'open');
  expect(presentation()).toBe('closed');
  expect(dockState()).toBe('open');
  // The dock's rule wins over the drawer's: the focus is on the dock's list.
  await until(() => document.activeElement === terminalListRow());
  expect(document.activeElement).toBe(terminalListRow());
});

it('자리가 없고 하단 도크가 열린 채 서랍이 그 위를 덮고 있다 → 하단 도크 버튼 → 서랍이 닫히고, 도크는 닫히지 않고 열린 채 보이며 버튼은 눌린 상태다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`, NARROW);
  await dockTerminal();
  expect(dockState()).toBe('open');
  await press(buttons(W.toggle).find((button) => button.hasAttribute('aria-pressed')));
  await until(() => presentation() === 'drawer');
  expect(dockState()).toBe('open');
  await press(dockButton());
  await until(() => presentation() === 'closed');
  await settle(20);
  expect(presentation()).toBe('closed');
  expect(dockState()).toBe('open');
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('true');
  expect(dockSelected()).toBe(W.terminal(1));
  await until(() => document.activeElement === terminalInput());
  expect(document.activeElement).toBe(terminalInput());
});

it('넓힘에서 하단 도크 버튼은 상단 줄에 그대로 있고, 누르면 도크만 닫히고 패널은 넓힘 그대로다', async () => {
  const world = await serverWorld();
  window.localStorage.setItem(
    panelMemoryKey(world.sessionId),
    serializePanelMemory({ tabs: [{ kind: 'files' }], selected: 'files', open: true }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => dockState() === 'open');
  await press(buttons(W.maximize)[0]);
  await until(() => presentation() === 'maximized');
  expect(dockState()).toBe('open');
  expect(dockButton()).not.toBeNull();
  await press(dockButton());
  expect(dockState()).toBe('closed');
  expect(presentation()).toBe('maximized');
});

it('대화의 기억에 도크의 터미널 3 탭이 있고 그 터미널은 목록에 없다 → 들어오면 탭이 버려지고 도크는 닫혀 버튼이 눌리지 않으며, 터미널은 만들어지지 않는다', async () => {
  const world = await serverWorld();
  window.localStorage.setItem(
    dockMemoryKey(world.sessionId),
    serializeDockMemory({
      tabs: [{ kind: 'terminal', terminalId: 'terminal_three' }],
      selected: 'terminal:terminal_three',
      open: true,
      height: 300,
    }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => dockState() === 'closed');
  await settle(20);
  expect(dockState()).toBe('closed');
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('false');
  expect(dockTabs()).toEqual([]);
  expect(world.server?.created).toEqual([]);
});

it('대화의 기억에 도크의 실행 중인 터미널 1 탭이 있다 → 터미널 목록이 답하기 전에 그 탭을 닫는다 → 목록이 답해도 도크는 열린 채 목록을 보이고, 터미널은 끝난다', async () => {
  const world = await serverWorld({ holdLists: true });
  window.localStorage.setItem(
    dockMemoryKey(world.sessionId),
    serializeDockMemory({
      tabs: [{ kind: 'terminal', terminalId: 'terminal_one' }],
      selected: 'terminal:terminal_one',
      open: true,
      height: 240,
    }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => dockTabs().length === 1);
  await press(buttons(W.close(W.terminal(1)), dock())[0]);
  await act(async () => world.server?.releaseLists());
  await until(() => (world.server?.stops.length ?? 0) > 0);
  await settle(20);
  expect(dockTabs()).toEqual([]);
  expect(dockState()).toBe('open');
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('true');
  expect(world.server?.stops).toEqual(['terminal_one']);
});

it('대화의 기억에 탭 없이 열린 도크와 패널의 실행 중인 터미널 1 탭이 있다 → 들어오면 도크는 닫혀 있고, 터미널 1 탭은 패널에 그대로이며, 아무것도 만들거나 끝내지 않는다', async () => {
  const world = await serverWorld();
  window.localStorage.setItem(
    dockMemoryKey(world.sessionId),
    serializeDockMemory({ tabs: [], selected: null, open: true, height: 240 }),
  );
  window.localStorage.setItem(
    panelMemoryKey(world.sessionId),
    serializePanelMemory({
      tabs: [{ kind: 'terminal', terminalId: 'terminal_one' }],
      selected: 'terminal:terminal_one',
      open: true,
    }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await settle(20);
  expect(dockState()).toBe('closed');
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('false');
  expect(dockTabs()).toEqual([]);
  const panelTabs = [
    ...(document
      .querySelector(`[data-slot="side-panel-side"] [role="tablist"]`)
      ?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
  ].map(tabName);
  expect(panelTabs).toEqual([W.terminal(1)]);
  expect(world.server?.created).toEqual([]);
  expect(world.server?.stops).toEqual([]);
});

it('대화의 기억에 탭 없이 열린 도크가 있고 살아 있는 터미널이 없다 → 들어오면 도크는 닫혀 있고 만들지 않으며, 버튼을 눌러도 도크가 열려 목록을 보일 뿐 만들지 않는다', async () => {
  const world = await serverWorld({ terminals: [] });
  window.localStorage.setItem(
    dockMemoryKey(world.sessionId),
    serializeDockMemory({ tabs: [], selected: null, open: true, height: 240 }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await settle(20);
  expect(dockState()).toBe('closed');
  expect(world.server?.created).toEqual([]);
  await press(dockButton());
  await until(() => Boolean(terminalListRow()));
  await settle(20);
  expect(dockState()).toBe('open');
  expect(dockTabs()).toEqual([]);
  expect(world.server?.created).toEqual([]);
});

it('대화 A의 도크가 열려 있고 대화 B의 도크는 닫혀 있다 → B로 갔다가 A로 돌아오면 같은 탭과 높이로 열려 있다', async () => {
  const world = await serverWorld();
  const other = await world.createConversation('Other');
  window.localStorage.setItem(
    dockMemoryKey(world.sessionId),
    serializeDockMemory({
      tabs: [{ kind: 'terminal', terminalId: 'terminal_one' }],
      selected: 'terminal:terminal_one',
      open: true,
      height: 300,
    }),
  );
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => dockSelected() === W.terminal(1));
  expect(dockState()).toBe('open');
  expect(dock()?.style.height).toBe('300px');
  await act(async () => {
    void shell.router.navigate({ to: '/sessions/$sessionId', params: { sessionId: other } });
  });
  await settle();
  expect(dockState()).toBe('closed');
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
    });
  });
  await settle();
  await until(() => dockState() === 'open');
  expect(dockState()).toBe('open');
  expect(dockSelected()).toBe(W.terminal(1));
  expect(dock()?.style.height).toBe('300px');
});

it('만드는 동안 도크를 닫았다 → 늦게 만들어진 터미널의 탭은 도크에 있되 도크를 다시 열지 않고, 거듭 열어도 하나만 만든다', async () => {
  const world = await serverWorld({ terminals: [], holdCreate: true });
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => Boolean(terminalListRow()));
  await press(terminalListRow());
  await until(() => (world.server?.created.length ?? 0) === 1);
  await press(dockButton());
  expect(dockState()).toBe('closed');
  await press(dockButton());
  await press(dockButton());
  expect(world.server?.created).toEqual(['bash']);
  expect(dockState()).toBe('closed');
  await act(async () => world.server?.releaseCreate());
  await settle();
  expect(dockState()).toBe('closed');
  await press(dockButton());
  await until(() => dockState() === 'open');
  expect(dockTabNames()).toEqual([W.terminal(1)]);
  expect(world.server?.created).toEqual(['bash']);
});

it('신뢰한 Paddock의 도크 "+"에서 디버그를 고르면 디버그 탭이 열려 선택된다', async () => {
  const world = await serverWorld();
  const workspaces = world.services.workspaces as unknown as Record<string, unknown>;
  workspaces.binding = async () => ({ trusted: true });
  workspaces.debugState = async () => ({ sessions: [] });
  await open(world, `/sessions/${world.sessionId}`);
  await dockTerminal();
  expect(dockSelected()).toBe(W.terminal(1));
  await press(dockPlus());
  await press(menuRow(W.debug));
  await until(() => dockSelected() === W.debug);
  expect(dockTabNames()).toEqual([W.terminal(1), W.debug]);
});

it('도크의 높이는 대화마다 기억되고 주소에는 실리지 않는다', async () => {
  const world = await serverWorld();
  const shell: MountedShell = await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => dockState() === 'open');
  const remembered = JSON.parse(
    window.localStorage.getItem(dockMemoryKey(world.sessionId)) ?? 'null',
  ) as Record<string, unknown> | null;
  expect(remembered).toMatchObject({ v: 1, open: true, height: 240 });
  expect(Object.keys(remembered ?? {}).sort()).toEqual(['height', 'open', 'selected', 'tabs', 'v']);
  const search = shell.router.state.location.search as Record<string, unknown>;
  expect(Object.keys(search).some((name) => name.toLowerCase().includes('dock'))).toBe(false);
});

it.each([
  ['컴포저를 쓸 수 있다', 'composer'],
  ['컴포저를 쓸 수 없고 패널에 파일 탭이 선택돼 있다', 'tab'],
] as const)(
  '포커스가 도크의 터미널 입력에 있고 %s → 창이 낮아져 도크가 물러난다 → 포커스는 그 순서의 첫 자리로 가고, 버튼은 눌린 채 점이 없다',
  async (_case, expected) => {
    // The frame is as tall as `height`; main's chrome below the messages is 100px, so the
    // messages' 160px floor leaves the dock `height - 260`px.
    let height = 800;
    // Only the frame's and main's own measures are told of the change.
    const observers: { targets: Element[]; fire: () => void }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly targets: Element[] = [];
        readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
          observers.push(this as unknown as { targets: Element[]; fire: () => void });
        }
        fire() {
          this.callback();
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const measured = (target: Element) =>
      target.getAttribute('data-slot') === 'side-panel-frame' ||
      target.querySelector('[data-testid="chat-composer"]') !== null;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.slot === 'side-panel-frame' ? height : 0;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      // The empty conversation's composer, 100px under 500px of message area; nothing else
      // in its view (no notices above).
      const composer = this.getAttribute('data-testid') === 'chat-composer';
      const top = composer ? 500 : 0;
      const besideTimeline =
        this.parentElement?.hasAttribute('data-chat-view') &&
        this.getAttribute('data-testid') !== 'chat-timeline';
      const tall = composer ? 100 : besideTimeline ? 0 : 600;
      return { top, height: tall, width: 600, left: 0, right: 600, bottom: top + tall } as DOMRect;
    });
    const world = await serverWorld({ terminals: ['running'] });
    if (expected === 'tab')
      window.localStorage.setItem(
        panelMemoryKey(world.sessionId),
        serializePanelMemory({ tabs: [{ kind: 'files' }], selected: 'files', open: true }),
      );
    await open(world, `/sessions/${world.sessionId}`);
    await press(dockButton());
    await until(() => document.activeElement === terminalInput());
    expect(dockState()).toBe('open');
    // A composer that cannot take input, as while it is held.
    if (expected === 'tab') (composerInput() as HTMLTextAreaElement).disabled = true;
    const filesTab = () =>
      document.querySelector<HTMLElement>(
        '[data-slot="side-panel-side"] [role="tab"][aria-selected="true"]',
      );
    const target = () => (expected === 'composer' ? composerInput() : filesTab());
    if (expected === 'tab') expect(filesTab()).not.toBeNull();
    height = 300;
    await act(async () => {
      for (const observer of observers) if (observer.targets.some(measured)) observer.fire();
    });
    await until(() => document.activeElement === target());
    expect(dockState()).toBe('withdrawn');
    expect(document.activeElement).toBe(target());
    expect(dockButton()?.getAttribute('aria-pressed')).toBe('true');
    expect(dockButton()?.querySelector('[data-dock-dot]')).toBeNull();
  },
);

it('명령 팔레트의 "{탭 이름} 열기"는 그 탭의 이름을 그대로 쓴다: 하단 도크의 디버그 탭도', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`);
  await settle(20);
  const title = (id: string) => registeredCommands().find((item) => item.id === id)?.title;
  const opens = (name: string) => messages.Commands.openPanel.replace('{panel}', name);

  expect(title('panel:debug')).toBe(opens(W.debug));
  expect(title('panel:files')).toBe(opens(messages.Docking.files));
  expect(title('panel:changes')).toBe(opens(messages.Docking.changes));
  expect(title('panel:tools')).toBe(opens(messages.Docking.tools));
  expect(title('panel:artifacts')).toBe(opens(messages.Docking.artifacts));
});
