// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { registeredCommands } from '../commandRegistry.ts';
import { dockMemoryKey, serializeDockMemory } from '../workbench/panel/dock.ts';
import { panelMemoryKey, serializePanelMemory } from '../workbench/panel/memory.ts';
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

vi.mock('../workbench/terminals/TerminalView.tsx', () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) => (
    <section data-testid="terminal-leaf" data-terminal-screen="" tabIndex={-1}>
      <textarea aria-label="terminal input" data-terminal-input={terminalId} />
      {terminalId}
    </section>
  ),
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
};

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
const menuRow = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    spoken(row).includes(name),
  ) ?? null;

it('Paddock이 있고 터미널이 없으며 도크가 닫혀 있다 → 하단 도크 버튼 → 240px 도크에 새 "터미널 1" 탭이 선택돼 있고 버튼은 눌린 상태다', async () => {
  const world = await serverWorld({ terminals: [] });
  await open(world, `/sessions/${world.sessionId}`);
  expect(dockState()).toBe('closed');
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('false');
  await press(dockButton());
  await until(() => dockSelected() === W.terminal(1));
  expect(dockState()).toBe('open');
  expect(dock()?.style.height).toBe('240px');
  expect(dockTabNames()).toEqual([W.terminal(1)]);
  expect(dockSelected()).toBe(W.terminal(1));
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('true');
  expect(world.server?.created).toEqual(['bash']);
  // The person opened it: the focus is in the new terminal's input.
  await until(() => document.activeElement === terminalInput());
  expect(document.activeElement).toBe(terminalInput());
});

it('셸이 둘이고 살아 있는 터미널이 없다 → 하단 도크 버튼 → 셸을 묻지 않고 첫째 셸로 만든다', async () => {
  const world = await serverWorld({ terminals: [], shells: ['zsh', 'bash'] });
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => dockSelected() === W.terminal(1));
  expect(world.server?.created).toEqual(['zsh']);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('도크에 실행 중인 터미널 1 탭이 있다 → 버튼으로 닫는다 → 명령은 없고 버튼에 실행 중 점이 있어 설명으로 읽힌다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => dockSelected() === W.terminal(1));
  // The running terminal was taken in: nothing was created.
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

it('Paddock이 없는 대화이고 도크에 탭이 없다 → 버튼 → 탭도 "+"도 없고 한 줄 안내와 버튼 하나, 터미널은 만들지 않는다', async () => {
  const world = await serverWorld({ terminals: [], noCopy: true });
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => dockState() === 'open');
  expect(dockState()).toBe('open');
  expect(dockTabs()).toEqual([]);
  expect(dockPlus()).toBeNull();
  const body = dock()?.querySelector<HTMLElement>('[data-dock-reason]');
  expect(body?.textContent).toContain(W.noCopy);
  expect(body?.querySelectorAll('button')).toHaveLength(1);
  expect(buttons(W.makeCopy, body ?? null)).toHaveLength(1);
  expect(world.server?.created).toEqual([]);
});

it('살아 있는 터미널이 없고 실행이 진행 중이다 → 버튼 → "+"가 있는 머리와 동작 없는 한 줄, 실행이 끝나도 만들지 않고 "+"의 터미널로 만든다', async () => {
  const world = await createShellWorld({ server: { terminals: [] }, folder: true });
  const runId = await world.startRun();
  await world.working(runId, 1);
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => Boolean(dock()?.querySelector('[data-dock-reason]')));
  const body = () => dock()?.querySelector<HTMLElement>('[data-dock-reason]');
  expect(body()?.textContent).toContain(W.runActive);
  expect(body()?.querySelectorAll('button')).toHaveLength(0);
  expect(dockTabs()).toEqual([]);
  expect(dockPlus()).not.toBeNull();
  expect(world.server?.created).toEqual([]);
  await world.releaseReplies();
  await world.runReaches(runId, ['succeeded']);
  await settle(20);
  // A run that ends makes no terminal by itself.
  expect(world.server?.created).toEqual([]);
  await press(dockPlus());
  // Once the run list says the run ended, the row can make a terminal.
  await until(() => menuRow(W.terminalRow)?.getAttribute('aria-disabled') !== 'true');
  await press(menuRow(W.terminalRow));
  await until(() => dockSelected() === W.terminal(1));
  expect(dockSelected()).toBe(W.terminal(1));
  expect(world.server?.created).toEqual(['bash']);
});

it('도크가 열려 있고 포커스가 터미널 1의 입력에 있다 → Mod+J → 도크가 닫히고, 컴포저에서는 Mod+J가 아무것도 하지 않는다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`);
  await press(dockButton());
  await until(() => document.activeElement === terminalInput());
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
  // The dock's rule wins over the drawer's: the focus is in the dock's terminal.
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

it('대화의 기억에 도크의 터미널 3 탭이 있고 그 터미널은 목록에 없다 → 들어오면 탭이 버려지고 도크는 숨는다', async () => {
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
  expect(dockState()).toBe('closed');
  expect(dockTabs()).toEqual([]);
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
  await press(dockButton());
  await until(() => dockSelected() === W.terminal(1));
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
      const top = this.getAttribute('data-testid') === 'chat-composer' ? 500 : 0;
      return { top, height: 600, width: 600, left: 0, right: 600, bottom: 600 } as DOMRect;
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
