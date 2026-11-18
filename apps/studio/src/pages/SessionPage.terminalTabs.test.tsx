// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { dockMemoryKey, serializeDockMemory } from '../workbench/panel/dock.ts';
import { panelMemoryKey, serializePanelMemory } from '../workbench/panel/memory.ts';
import {
  createShellWorld,
  type MountedShell,
  mountShell,
  type ShellWorld,
  settle,
  stubBrowser,
  type TerminalOptions,
  WIDE,
} from './sessionShell.fixture.tsx';

// Terminal tabs in both strips (features/session-panel.md 터미널 탭, "+" 목록, 여는 길, 주소와 기억):
// a terminal's tab is in the panel or the dock, closing it ends the terminal as its state says,
// the ⋯ menu moves it across, and the addresses that name a terminal open it where it is. The
// terminal list is the fixture's fake host; nothing here runs a shell.

vi.mock('../workbench/terminals/TerminalView.tsx', () => ({
  TerminalView: ({ terminalId, onExit }: { terminalId: string; onExit?: () => void }) => (
    <section data-testid="terminal-leaf" data-terminal-screen="" tabIndex={-1}>
      <textarea aria-label="terminal input" data-terminal-input={terminalId} />
      <button type="button" data-leave-terminal="" onClick={onExit}>
        leave
      </button>
      {terminalId}
    </section>
  ),
}));

vi.setConfig({ testTimeout: 20_000 });

const W = {
  dock: messages.SessionPanel.dock,
  dockTabs: messages.SessionPanel.dockTabs,
  panelTabs: messages.SessionPanel.tabs,
  add: messages.SessionPanel.add,
  toggle: messages.SessionPanel.toggle,
  terminal: (n: number) => messages.SessionPanel.terminalTab.replace('{number}', String(n)),
  close: (name: string) => messages.SessionPanel.close.replace('{name}', name),
  debug: messages.SessionPanel.debugTab,
  files: messages.Docking.files,
  terminalRow: messages.Docking.terminal,
  runActive: messages.Terminals.runActive,
  actions: messages.Terminals.actions,
  toDock: messages.Terminals.moveToDock,
  toPanel: messages.Terminals.moveToPanel,
  endBody: messages.Terminals.endBody,
  keep: messages.Terminals.keepRunning,
  end: messages.Terminals.end,
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
const serverWorld = (terminals: TerminalOptions = {}) =>
  createShellWorld({ server: terminals, folder: true });
const server = (world: ShellWorld) => world.server as NonNullable<ShellWorld['server']>;

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
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
  await settle();
}

const dock = () => document.querySelector<HTMLElement>('[data-slot="side-panel-bottom"]');
const side = () => document.querySelector<HTMLElement>('[data-slot="side-panel-side"]');
const frame = () => document.querySelector<HTMLElement>('[data-slot="side-panel-frame"]');
const presentation = () => frame()?.getAttribute('data-presentation') ?? null;
const dockState = () => dock()?.getAttribute('data-state') ?? null;
const dockButton = () =>
  buttons(W.dock).find((button) => button.hasAttribute('aria-pressed')) ?? null;
const toggleButton = () =>
  buttons(W.toggle).find((button) => button.hasAttribute('aria-pressed')) ?? null;
const stripTabs = (scope: HTMLElement | null, label: string) => [
  ...(scope
    ?.querySelector(`[role="tablist"][aria-label="${label}"]`)
    ?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
];
const tabName = (tab: HTMLElement) =>
  (
    tab.querySelector('[data-slot="tabs-closable-label"]')?.textContent ??
    tab.textContent ??
    ''
  ).trim();
const dockTabNames = () => stripTabs(dock(), W.dockTabs).map(tabName);
const panelTabNames = () => stripTabs(side(), W.panelTabs).map(tabName);
const selectedIn = (scope: HTMLElement | null, label: string) => {
  const tab = stripTabs(scope, label).find((item) => item.getAttribute('aria-selected') === 'true');
  return tab ? tabName(tab) : null;
};
const dockSelected = () => selectedIn(dock(), W.dockTabs);
const panelSelected = () => selectedIn(side(), W.panelTabs);
const tabIn = (scope: HTMLElement | null, label: string, name: string) =>
  stripTabs(scope, label).find((tab) => tabName(tab) === name) ?? null;
/** The selected tab's panel in a strip's region. */
const visiblePanel = (scope: HTMLElement | null) => {
  const tab = [...(scope?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find(
    (item) => item.getAttribute('aria-selected') === 'true',
  );
  const id = tab?.getAttribute('aria-controls');
  return id ? document.getElementById(id) : null;
};
const inputIn = (scope: HTMLElement | null) =>
  visiblePanel(scope)?.querySelector<HTMLElement>('[data-terminal-screen] textarea') ?? null;
const menuRow = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    spoken(row).includes(name),
  ) ?? null;
const panelPlus = () =>
  buttons(W.add, side()?.querySelector('[role="tablist"]')?.parentElement ?? null)[0] ??
  buttons(W.add, side())[0] ??
  null;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
const search = (shell: MountedShell) =>
  shell.router.state.location.search as Record<string, unknown>;

/** The panel holds the first listed terminal's tab, selected, beside the conversation. */
function panelHoldsTerminal(world: ShellWorld, open = true) {
  window.localStorage.setItem(
    panelMemoryKey(world.sessionId),
    serializePanelMemory({
      tabs: [{ kind: 'files' }, { kind: 'terminal', terminalId: 'terminal_one' }],
      selected: 'terminal:terminal_one',
      open,
    }),
  );
}
/** The dock holds the first listed terminal's tab, open. */
function dockHoldsTerminal(world: ShellWorld, open = true) {
  window.localStorage.setItem(
    dockMemoryKey(world.sessionId),
    serializeDockMemory({
      tabs: [{ kind: 'terminal', terminalId: 'terminal_one' }],
      selected: 'terminal:terminal_one',
      open,
      height: 240,
    }),
  );
}
async function follow(
  shell: MountedShell,
  world: ShellWorld,
  searchParams: Record<string, string>,
) {
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: searchParams as never,
    });
  });
  await settle();
}

const composerInput = () =>
  document.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer"] textarea');
const noticeButton = () =>
  [
    ...(document
      .querySelector('[data-testid="terminal-writer-notice"]')
      ?.querySelectorAll<HTMLElement>('a, button') ?? []),
  ].find((item) => (item.textContent ?? '').includes(messages.Terminals.openControls)) ?? null;

it('살아 있는 터미널 1의 탭이 패널에서 선택돼 있고 포커스는 컴포저에 있다 → 컴포저 안내의 "터미널 제어 열기" → 포커스가 그 터미널의 입력으로 간다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1) && Boolean(noticeButton()));
  await act(async () => composerInput()?.focus());
  await press(noticeButton());
  await until(() => document.activeElement === inputIn(side()));
  expect(document.activeElement).toBe(inputIn(side()));
  expect(dockTabNames()).toEqual([]);
});

it('살아 있는 터미널 1의 탭이 닫힌 도크에 있다 → "터미널 제어 열기" → 도크가 열려 그 탭이 선택되고 포커스가 그 입력에 있다', async () => {
  const world = await serverWorld();
  dockHoldsTerminal(world, false);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => Boolean(noticeButton()));
  expect(dockState()).toBe('closed');
  await press(noticeButton());
  await until(() => document.activeElement === inputIn(dock()));
  expect(dockState()).toBe('open');
  expect(dockSelected()).toBe(W.terminal(1));
  expect(document.activeElement).toBe(inputIn(dock()));
});

it('살아 있는 터미널 1의 탭이 패널에 있고 파일 탭이 선택돼 있다 → "터미널 제어 열기" → 패널에서 터미널 1 탭이 선택되고 포커스가 그 입력에 있다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1) && Boolean(noticeButton()));
  await press(tabIn(side(), W.panelTabs, W.files));
  await press(noticeButton());
  await until(() => document.activeElement === inputIn(side()));
  expect(panelSelected()).toBe(W.terminal(1));
  expect(document.activeElement).toBe(inputIn(side()));
});

it('패널의 "+" → 터미널, 살아 있는 터미널이 없다 → 첫째 셸로 만들어 패널에 "터미널 1" 탭이 열려 선택되고 포커스는 그 입력에 있으며 도크는 닫힌 채다', async () => {
  const world = await serverWorld({ terminals: [] });
  window.localStorage.setItem(
    panelMemoryKey(world.sessionId),
    serializePanelMemory({ tabs: [{ kind: 'files' }], selected: 'files', open: true }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.files);
  await press(panelPlus());
  await until(() => Boolean(menuRow(W.terminalRow)));
  await press(menuRow(W.terminalRow));
  await until(() => panelSelected() === W.terminal(1));
  expect(panelTabNames()).toEqual([W.files, W.terminal(1)]);
  expect(server(world).created).toEqual(['bash']);
  expect(dockState()).toBe('closed');
  await until(() => document.activeElement === inputIn(side()));
  expect(document.activeElement).toBe(inputIn(side()));
});

it('살아 있는 터미널의 탭이 도크에 있다 → 패널의 "+" → 터미널 → 도크에서 그 탭을 고르고 새로 만들지 않으며 패널은 그대로다', async () => {
  const world = await serverWorld();
  dockHoldsTerminal(world, false);
  window.localStorage.setItem(
    panelMemoryKey(world.sessionId),
    serializePanelMemory({ tabs: [{ kind: 'files' }], selected: 'files', open: true }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.files);
  await press(panelPlus());
  await press(menuRow(W.terminalRow));
  await until(() => dockState() === 'open');
  expect(dockSelected()).toBe(W.terminal(1));
  expect(panelTabNames()).toEqual([W.files]);
  expect(server(world).created).toEqual([]);
});

it('공유 개발 모드에서 실행 중에 패널의 터미널을 고르면 새 터미널이 열린다', async () => {
  const world = await serverWorld({ terminals: [] });
  world.services.sharedDevelopment = true;
  const runId = await world.startRun();
  await world.working(runId, 1);
  await open(world, `/sessions/${world.sessionId}?panel=files`);
  await until(() => panelSelected() === W.files);
  await press(panelPlus());
  await until(() => Boolean(menuRow(W.terminalRow)));
  const row = menuRow(W.terminalRow);
  expect(row?.getAttribute('aria-disabled')).not.toBe('true');
  await press(row);
  await until(() => panelSelected() === W.terminal(1));
  expect(panelSelected()).toBe(W.terminal(1));
  expect(server(world).created).toEqual(['bash']);
});

it('단독 쓰기 서버에서 실행이 진행 중이고 살아 있는 터미널이 없다 → 패널 목록의 터미널은 까닭을 둘째 줄로 보이는 쓸 수 없는 줄이고, 고르면 아무 일도 없다', async () => {
  const world = await createShellWorld({ server: { terminals: [] }, folder: true });
  world.services.sharedDevelopment = false;
  const runId = await world.startRun();
  await world.working(runId, 1);
  window.localStorage.setItem(
    panelMemoryKey(world.sessionId),
    serializePanelMemory({ tabs: [{ kind: 'files' }], selected: 'files', open: true }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.files);
  await press(panelPlus());
  await until(() => Boolean(menuRow(W.terminalRow)));
  const row = menuRow(W.terminalRow);
  expect(row?.getAttribute('aria-disabled')).toBe('true');
  expect(spoken(row as HTMLElement)).toContain(W.runActive);
  await press(row);
  expect(server(world).created).toEqual([]);
  expect(dockState()).toBe('closed');
  expect(panelTabNames()).toEqual([W.files]);
});

it('패널의 실행 중인 터미널 탭을 닫는다, 앞쪽 프로세스가 지금 idle이다 → 묻지 않고 끝내고 탭이 닫힌다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1));
  const reads = server(world).reads.length;
  await press(buttons(W.close(W.terminal(1)), side())[0]);
  await until(() => server(world).stops.length === 1);
  expect(server(world).reads.length).toBe(reads + 1);
  expect(server(world).stops).toEqual(['terminal_one']);
  expect(dialog()).toBeNull();
  expect(panelTabNames()).toEqual([W.files]);
});

it('목록이 idle이라 했어도 닫는 때 다시 읽은 앞쪽 프로세스가 busy다 → "터미널을 끝낼까요?"를 묻고, 그대로 두기와 Escape는 아무것도 보내지 않으며 끝내기가 끝낸다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1));
  server(world).setForeground('terminal_one', 'busy');
  await press(buttons(W.close(W.terminal(1)), side())[0]);
  await until(() => Boolean(dialog()));
  expect(dialog()?.textContent).toContain(W.endBody);
  const actions = [...(dialog()?.querySelectorAll('button') ?? [])].map(nameOf);
  expect(actions.indexOf(W.keep)).toBeLessThan(actions.indexOf(W.end));
  await until(() => document.activeElement === buttons(W.keep, dialog())[0]);
  expect(document.activeElement).toBe(buttons(W.keep, dialog())[0]);
  expect(server(world).stops).toEqual([]);
  await press(buttons(W.keep, dialog())[0]);
  await until(() => !dialog());
  expect(server(world).stops).toEqual([]);
  expect(panelTabNames()).toEqual([W.files, W.terminal(1)]);
  // Again, and Escape.
  await press(buttons(W.close(W.terminal(1)), side())[0]);
  await until(() => Boolean(dialog()));
  await key(document.activeElement as HTMLElement, { key: 'Escape' });
  await until(() => !dialog());
  expect(server(world).stops).toEqual([]);
  expect(panelTabNames()).toEqual([W.files, W.terminal(1)]);
  // And 끝내기.
  await press(buttons(W.close(W.terminal(1)), side())[0]);
  await until(() => Boolean(dialog()));
  await press(buttons(W.end, dialog())[0]);
  await until(() => server(world).stops.length === 1);
  expect(server(world).stops).toEqual(['terminal_one']);
  expect(panelTabNames()).toEqual([W.files]);
});

it.each([
  ['패널, 옆에 파일 탭', 'panel'],
  ['도크, 옆에 터미널 2 탭', 'dock-two'],
  ['도크의 하나뿐인 탭', 'dock-one'],
  ['패널, 포커스는 컴포저에', 'composer'],
] as const)(
  '%s: 닫는 탭에 포커스를 두고 Delete, "끝내기"로 끝낸다 → 포커스는 닫기의 규칙대로 이어서 선택되는 탭, 남은 탭이 없으면 본문 목록의 첫 줄로 가고, 탭 밖에 있었으면 제자리에 있다',
  async (_case, where) => {
    const world = await serverWorld({ terminals: ['running', 'running'] });
    if (where === 'panel' || where === 'composer') panelHoldsTerminal(world);
    else
      window.localStorage.setItem(
        dockMemoryKey(world.sessionId),
        serializeDockMemory({
          tabs:
            where === 'dock-two'
              ? [
                  { kind: 'terminal', terminalId: 'terminal_one' },
                  { kind: 'terminal', terminalId: 'terminal_two' },
                ]
              : [{ kind: 'terminal', terminalId: 'terminal_one' }],
          selected: 'terminal:terminal_one',
          open: true,
          height: 240,
        }),
      );
    const inPanel = where === 'panel' || where === 'composer';
    const scope = inPanel ? side : dock;
    const label = inPanel ? W.panelTabs : W.dockTabs;
    await open(world, `/sessions/${world.sessionId}`);
    await until(() => selectedIn(scope(), label) === W.terminal(1));
    server(world).setForeground('terminal_one', 'busy');
    const closing = tabIn(scope(), label, W.terminal(1)) as HTMLElement;
    const composer = document.querySelector<HTMLElement>('[data-testid="chat-composer"] textarea');
    if (where === 'composer') {
      await act(async () => composer?.focus());
      expect(document.activeElement).toBe(composer);
      await press(buttons(W.close(W.terminal(1)), scope())[0]);
    } else {
      await act(async () => closing.focus());
      expect(document.activeElement).toBe(closing);
      await key(closing, { key: 'Delete' });
    }
    await until(() => Boolean(dialog()));
    await press(buttons(W.end, dialog())[0]);

    await until(() => server(world).stops.length === 1);
    const expected = () =>
      where === 'composer'
        ? composer
        : where === 'panel'
          ? tabIn(side(), W.panelTabs, W.files)
          : where === 'dock-two'
            ? tabIn(dock(), W.dockTabs, W.terminal(2))
            : (dock()?.querySelector<HTMLElement>('[data-dock-list] button') ?? null);
    await until(() => Boolean(expected()) && document.activeElement === expected());
    expect(document.activeElement).toBe(expected());
  },
);

it('다시 읽지 못하면 unknown으로 보고 묻는다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1));
  server(world).setReadsFail(true);
  await press(buttons(W.close(W.terminal(1)), side())[0]);
  await until(() => Boolean(dialog()));
  expect(dialog()?.textContent).toContain(W.endBody);
  expect(server(world).stops).toEqual([]);
});

it.each([
  ['시작 중', 'starting', ['terminal_one']],
  ['종료 확인 필요', 'uncertain', ['terminal_one']],
  ['종료됨', 'exited', []],
] as const)(
  '%s인 터미널의 도크 탭을 닫는다 → 묻지 않고, 보낸 것은 그 상태대로다',
  async (_name, state, stops) => {
    const world = await serverWorld({ terminals: [state] });
    dockHoldsTerminal(world);
    await open(world, `/sessions/${world.sessionId}`);
    await until(() => dockSelected() === W.terminal(1));
    const reads = server(world).reads.length;
    await press(buttons(W.close(W.terminal(1)), dock())[0]);
    await until(() => dockTabNames().length === 0);
    await settle();
    expect(dialog()).toBeNull();
    expect(server(world).stops).toEqual(stops);
    // Only a running terminal's foreground is read at close.
    expect(server(world).reads.length).toBe(reads);
  },
);

it('패널의 터미널 탭에서 ⋯ → 하단 도크로 옮기기 → 같은 터미널의 탭이 도크 오른쪽 끝에 놓여 선택되고 도크가 열리며, 끝내지 않고 포커스는 그 입력에 있다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1));
  await press(buttons(W.actions, visiblePanel(side()))[0]);
  await press(menuRow(W.toDock));
  await until(() => dockSelected() === W.terminal(1));
  expect(dockState()).toBe('open');
  expect(panelTabNames()).toEqual([W.files]);
  expect(dockTabNames()).toEqual([W.terminal(1)]);
  expect(server(world).stops).toEqual([]);
  expect(visiblePanel(dock())?.textContent).toContain('terminal_one');
  await until(() => document.activeElement === inputIn(dock()));
  expect(document.activeElement).toBe(inputIn(dock()));
  // And back, by the dock tab's own ⋯.
  await press(buttons(W.actions, visiblePanel(dock()))[0]);
  await press(menuRow(W.toPanel));
  await until(() => panelSelected() === W.terminal(1));
  expect(panelTabNames()).toEqual([W.files, W.terminal(1)]);
  expect(dockTabNames()).toEqual([]);
  expect(server(world).stops).toEqual([]);
  // Moving the dock's last tab out hides the dock, unlike closing it.
  expect(dockState()).toBe('closed');
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('false');
  await until(() => document.activeElement === inputIn(side()));
  expect(document.activeElement).toBe(inputIn(side()));
});

it('터미널 탭은 패널에서도 도크에서처럼 그 상태를 아이콘 자리의 표시와 탭의 설명으로 말하고, 접근 이름은 "터미널 n" 그대로다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1));
  const tab = tabIn(side(), W.panelTabs, W.terminal(1));
  expect(tab?.getAttribute('aria-description')).toBe(messages.Terminals.state.running);
  expect(tabName(tab as HTMLElement)).toBe(W.terminal(1));
  expect(tab?.querySelector('[data-terminal-state="running"]')).not.toBeNull();
  // The same terminal in the dock says it the same way.
  await press(buttons(W.actions, visiblePanel(side()))[0]);
  await press(menuRow(W.toDock));
  await until(() => dockSelected() === W.terminal(1));
  expect(tabIn(dock(), W.dockTabs, W.terminal(1))?.getAttribute('aria-description')).toBe(
    messages.Terminals.state.running,
  );
  expect(
    tabIn(dock(), W.dockTabs, W.terminal(1))?.querySelector('[data-terminal-state="running"]'),
  ).not.toBeNull();
});

it('Shift+Escape로 터미널에서 나오면 포커스는 그 탭 줄의 그 터미널 탭으로 간다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1));
  await press(visiblePanel(side())?.querySelector<HTMLElement>('[data-leave-terminal]'));
  expect(document.activeElement).toBe(tabIn(side(), W.panelTabs, W.terminal(1)));
});

it('panel=terminal과 그 터미널을 실은 앱 안의 링크 → 패널에 탭이 있으면 패널에서, 도크에 있으면 도크에서 고르고 포커스는 그 입력에 있다', async () => {
  const inPanel = await serverWorld();
  panelHoldsTerminal(inPanel, false);
  const first = await open(inPanel, `/sessions/${inPanel.sessionId}`);
  await follow(first, inPanel, { panel: 'terminal', terminal: 'terminal_one' });
  await until(() => panelSelected() === W.terminal(1) && presentation() === 'beside');
  expect(dockState()).toBe('closed');
  await until(() => document.activeElement === inputIn(side()));
  expect(document.activeElement).toBe(inputIn(side()));
  await first.unmount();
  window.localStorage.clear();

  const inDock = await serverWorld();
  dockHoldsTerminal(inDock, false);
  const second = await open(inDock, `/sessions/${inDock.sessionId}`);
  await follow(second, inDock, { panel: 'terminal', terminal: 'terminal_one' });
  await until(() => dockState() === 'open');
  expect(dockSelected()).toBe(W.terminal(1));
  expect(presentation()).toBe('closed');
  // The address goes back to the panel's look.
  expect(search(second).compose).toBe(true);
  expect(search(second).terminal).toBeUndefined();
  await until(() => document.activeElement === inputIn(dock()));
  expect(document.activeElement).toBe(inputIn(dock()));
});

it('어디에도 탭이 없는 터미널을 가리키는 링크 → 목록에 있으면 도크에 열고, 없으면 아무것도 열지 않는다', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await follow(shell, world, { panel: 'terminal', terminal: 'terminal_one' });
  await until(() => dockSelected() === W.terminal(1));
  expect(dockState()).toBe('open');
  expect(presentation()).toBe('closed');
  await press(dockButton());
  await follow(shell, world, { panel: 'terminal', terminal: 'terminal_nine' });
  await settle(20);
  expect(dockState()).toBe('closed');
  expect(dockTabNames()).toEqual([W.terminal(1)]);
  expect(search(shell).terminal).toBeUndefined();
});

it('panel=debug 링크 → 하단 도크의 디버그 탭이 열린다', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await follow(shell, world, { panel: 'debug' });
  await until(() => dockSelected() === W.debug);
  expect(dockState()).toBe('open');
  expect(presentation()).toBe('closed');
  expect(search(shell).panel).toBeUndefined();
});

it('terminal 없는 panel=terminal → 살아 있는 터미널의 탭이 패널에 있으면 패널에서 고르고 옮기지 않으며, 탭이 없으면 도크에 열고, 살아 있는 터미널이 없으면 도크에 만든다', async () => {
  const inPanel = await serverWorld();
  panelHoldsTerminal(inPanel, false);
  const first = await open(inPanel, `/sessions/${inPanel.sessionId}`);
  await follow(first, inPanel, { panel: 'terminal' });
  await until(() => panelSelected() === W.terminal(1) && presentation() === 'beside');
  expect(dockState()).toBe('closed');
  await first.unmount();
  window.localStorage.clear();

  const none = await serverWorld({ terminals: [] });
  const second = await open(none, `/sessions/${none.sessionId}`);
  await follow(second, none, { panel: 'terminal' });
  await until(() => dockSelected() === W.terminal(1));
  expect(server(none).created).toEqual(['bash']);
  expect(presentation()).toBe('closed');
});

it('panel=terminal은 파일 탭을 열지 않는다: 파일 탭에는 터미널 창이 없다', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await follow(shell, world, { panel: 'terminal', terminal: 'terminal_one' });
  await until(() => dockSelected() === W.terminal(1));
  expect(panelTabNames()).toEqual([]);
  expect(side()?.querySelector('[data-testid="terminal-leaf"]') ?? null).toBeNull();
});

it('살아 있는 터미널 1의 탭이 패널에 있고 도크에는 탭이 없다 → Mod+J → 도크가 열려 목록을 보이고 탭은 패널에 그대로이며 만들지 않는다; 도크 본문의 터미널 줄 → 패널에서 터미널 1 탭이 선택되고 옮겨지지 않는다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1));
  await press(tabIn(side(), W.panelTabs, W.files));
  await key(document.activeElement ?? document.body, { key: 'j', code: 'KeyJ', ctrlKey: true });
  await until(() => dockState() === 'open');
  const row = () =>
    [...(dock()?.querySelectorAll<HTMLElement>('[data-dock-list] button') ?? [])].find((item) =>
      (item.textContent ?? '').trim().startsWith(W.terminalRow),
    ) ?? null;
  await until(() => Boolean(row()));
  await settle();
  expect(dockTabNames()).toEqual([]);
  expect(panelTabNames()).toEqual([W.files, W.terminal(1)]);
  expect(server(world).created).toEqual([]);
  await press(row());
  await until(() => panelSelected() === W.terminal(1));
  expect(panelTabNames()).toEqual([W.files, W.terminal(1)]);
  expect(dockTabNames()).toEqual([]);
  expect(server(world).stops).toEqual([]);
  expect(server(world).created).toEqual([]);
});

it('실행 중인 터미널의 탭이 화면에 있는 패널의 선택된 탭이면 도크가 닫혀 있어도 버튼에 점이 없다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1));
  await settle();
  expect(dockButton()?.querySelector('[data-dock-dot]')).toBeNull();
  await press(tabIn(side(), W.panelTabs, W.files));
  await until(() => Boolean(dockButton()?.querySelector('[data-dock-dot="running"]')));
  expect(dockButton()?.querySelector('[data-dock-dot="running"]')).not.toBeNull();
});

const TOGGLE_KEY = { key: 'b', ctrlKey: true, altKey: true };

it('터미널 탭이 닫힌 패널에 있다 → 대화 안의 panel=terminal 링크가 패널을 연다 → 포커스가 패널 안에 있을 때 패널을 닫으면 포커스는 그 링크로 간다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world, false);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  const link = document.createElement('a');
  link.href = '#terminal';
  link.textContent = 'to the terminal';
  document.body.append(link);
  cleanups.push(() => link.remove());
  link.focus();
  await follow(shell, world, { panel: 'terminal', terminal: 'terminal_one' });
  await until(() => panelSelected() === W.terminal(1) && presentation() === 'beside');
  await until(() => document.activeElement === inputIn(side()));
  // The panel's toggle key is not heard while typing: from the terminal's tab instead.
  await act(async () => tabIn(side(), W.panelTabs, W.terminal(1))?.focus());
  await key(document.activeElement as HTMLElement, TOGGLE_KEY);
  await until(() => presentation() === 'closed');
  expect(document.activeElement).toBe(link);
});

it('대화 A에서 panel=terminal 링크로 패널을 열었다 → 패널이 옆에 되살아나는 대화 B에서 그 탭에 포커스를 두고 패널을 닫는다 → A의 링크는 B의 것이 아니어서 포커스는 여닫기 버튼으로 간다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world, false);
  const other = await world.createConversation('Other');
  window.localStorage.setItem(
    panelMemoryKey(other),
    serializePanelMemory({ tabs: [{ kind: 'changes' }], selected: 'changes', open: true }),
  );
  const shell = await open(world, `/sessions/${world.sessionId}`);
  const link = document.createElement('a');
  link.href = '#terminal';
  link.textContent = 'to the terminal';
  document.body.append(link);
  cleanups.push(() => link.remove());
  link.focus();
  await follow(shell, world, { panel: 'terminal', terminal: 'terminal_one' });
  await until(() => panelSelected() === W.terminal(1));
  await act(async () => {
    void shell.router.navigate({ to: '/sessions/$sessionId', params: { sessionId: other } });
  });
  await settle();
  const changes = messages.Docking.changes;
  await until(() => panelSelected() === changes);
  await act(async () => tabIn(side(), W.panelTabs, changes)?.focus());
  await key(document.activeElement as HTMLElement, TOGGLE_KEY);
  await until(() => presentation() === 'closed');
  expect(document.activeElement).toBe(toggleButton());
});

// 탭의 순서와 옮기기: the strips' own drag (pointer events, never an HTML5 drag) and
// Mod+Shift+←/→. The panel's strip lies at y 0–40 and the dock's at y 100–140; tabs are 100px wide
// from x 0.
function layOutStrips() {
  const original = Element.prototype.getBoundingClientRect;
  const box = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    }) as DOMRect;
  const tops: Record<string, number> = { [W.panelTabs]: 0, [W.dockTabs]: 100 };
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const strip = this.closest<HTMLElement>('[data-slot="tabs-closable"]');
    const label = strip?.querySelector('[role="tablist"]')?.getAttribute('aria-label') ?? '';
    const top = tops[label];
    if (top !== undefined && this.getAttribute('role') === 'tab')
      return box(Number((this as HTMLElement).dataset.fluidHoverIndex) * 100, top + 6, 100, 28);
    if (top !== undefined && this === strip) return box(0, top, 600, 40);
    return original.call(this);
  };
  cleanups.push(() => {
    Element.prototype.getBoundingClientRect = original;
  });
}
const at = (x: number, y: number) => ({
  bubbles: true,
  cancelable: true,
  pointerId: 1,
  pointerType: 'mouse',
  button: 0,
  buttons: 1,
  clientX: x,
  clientY: y,
});
async function drag(tab: HTMLElement | null, from: [number, number], to: [number, number]) {
  expect(tab, 'the tab to drag is on screen').toBeTruthy();
  const target = tab as HTMLElement;
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', at(...from)));
    target.dispatchEvent(new PointerEvent('pointermove', at(...to)));
    target.dispatchEvent(new PointerEvent('pointerup', at(...to)));
  });
  await settle();
}
const historyLength = (shell: MountedShell) => shell.router.history.length;

it('하단 도크의 터미널 1 탭을 패널의 탭 줄로 끌어 파일 탭 앞에 놓는다 → 패널의 파일 탭 앞에 선택돼 있고 같은 터미널이며, 도크는 닫혀 버튼이 눌리지 않은 상태이고, 기록은 쌓이지 않는다', async () => {
  const world = await serverWorld();
  window.localStorage.setItem(
    panelMemoryKey(world.sessionId),
    serializePanelMemory({ tabs: [{ kind: 'files' }], selected: 'files', open: true }),
  );
  dockHoldsTerminal(world);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => dockSelected() === W.terminal(1) && panelSelected() === W.files);
  layOutStrips();
  const before = historyLength(shell);
  await drag(tabIn(dock(), W.dockTabs, W.terminal(1)), [50, 120], [10, 20]);
  await until(() => panelTabNames().length === 2);
  expect(panelTabNames()).toEqual([W.terminal(1), W.files]);
  expect(panelSelected()).toBe(W.terminal(1));
  expect(visiblePanel(side())?.textContent).toContain('terminal_one');
  expect(dockTabNames()).toEqual([]);
  expect(dockState()).toBe('closed');
  expect(dockButton()?.getAttribute('aria-pressed')).toBe('false');
  expect(server(world).stops).toEqual([]);
  expect(historyLength(shell)).toBe(before);
  expect(search(shell).panel).toBe('terminal');
});

it('패널의 터미널 탭을 도크의 탭 줄로 끌어 놓으면 도크의 그 자리에 선택돼 놓이고, 파일 탭을 도크로 끌어 놓으면 아무것도 바뀌지 않는다', async () => {
  const world = await serverWorld({ terminals: ['running', 'running'] });
  panelHoldsTerminal(world);
  window.localStorage.setItem(
    dockMemoryKey(world.sessionId),
    serializeDockMemory({
      tabs: [{ kind: 'terminal', terminalId: 'terminal_two' }],
      selected: 'terminal:terminal_two',
      open: true,
      height: 240,
    }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1) && dockSelected() === W.terminal(2));
  layOutStrips();
  await drag(tabIn(side(), W.panelTabs, W.files), [50, 20], [10, 120]);
  expect(panelTabNames()).toEqual([W.files, W.terminal(1)]);
  expect(dockTabNames()).toEqual([W.terminal(2)]);
  await drag(tabIn(side(), W.panelTabs, W.terminal(1)), [150, 20], [10, 120]);
  await until(() => dockTabNames().length === 2);
  expect(dockTabNames()).toEqual([W.terminal(1), W.terminal(2)]);
  expect(dockSelected()).toBe(W.terminal(1));
  expect(panelTabNames()).toEqual([W.files]);
  expect(server(world).stops).toEqual([]);
});

it('패널의 탭을 끌어 같은 줄의 다른 자리에 놓으면 순서가 바뀌고 선택과 기록은 그대로다; 줄 밖에 놓으면 아무것도 바뀌지 않는다', async () => {
  const world = await serverWorld();
  panelHoldsTerminal(world);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelSelected() === W.terminal(1));
  layOutStrips();
  const before = historyLength(shell);
  await drag(tabIn(side(), W.panelTabs, W.terminal(1)), [150, 20], [10, 20]);
  await until(() => panelTabNames()[0] === W.terminal(1));
  expect(panelTabNames()).toEqual([W.terminal(1), W.files]);
  expect(panelSelected()).toBe(W.terminal(1));
  expect(historyLength(shell)).toBe(before);
  // Let go outside any strip: nothing moves.
  await drag(tabIn(side(), W.panelTabs, W.files), [150, 20], [150, 400]);
  expect(panelTabNames()).toEqual([W.terminal(1), W.files]);
  expect(dockTabNames()).toEqual([]);
});

it.each([
  ['패널', 'panel'],
  ['하단 도크', 'dock'],
] as const)(
  '%s의 탭에 포커스를 두고 Mod+Shift+← · → → 그 탭이 한 자리 옮겨 가고 포커스는 그 탭에 남으며 낭독기가 새 자리를 알린다; 줄의 끝에서는 옮겨 가지 않는다',
  async (_where, where) => {
    const world = await serverWorld({ terminals: ['running', 'running'] });
    if (where === 'panel') panelHoldsTerminal(world);
    else
      window.localStorage.setItem(
        dockMemoryKey(world.sessionId),
        serializeDockMemory({
          tabs: [
            { kind: 'terminal', terminalId: 'terminal_one' },
            { kind: 'terminal', terminalId: 'terminal_two' },
          ],
          selected: 'terminal:terminal_two',
          open: true,
          height: 240,
        }),
      );
    await open(world, `/sessions/${world.sessionId}`);
    const scope = where === 'panel' ? side : dock;
    const label = where === 'panel' ? W.panelTabs : W.dockTabs;
    const names = () => stripTabs(scope(), label).map(tabName);
    const [firstName, lastName] =
      where === 'panel' ? [W.files, W.terminal(1)] : [W.terminal(1), W.terminal(2)];
    await until(() => names().length === 2);
    const moving = tabIn(scope(), label, lastName) as HTMLElement;
    await act(async () => moving.focus());
    await key(moving, { key: 'ArrowLeft', ctrlKey: true, shiftKey: true });
    await until(() => names()[0] === lastName);
    expect(names()).toEqual([lastName, firstName]);
    expect(document.activeElement).toBe(tabIn(scope(), label, lastName));
    const announcer = scope()?.querySelector('[data-slot="tabs-closable-announcer"]');
    expect(announcer?.textContent).toBe(
      messages.SessionPanel.tabPosition
        .replace('{label}', lastName)
        .replace('{n}', '1')
        .replace('{count}', '2'),
    );
    // At the strip's start it goes no further.
    await key(document.activeElement as HTMLElement, {
      key: 'ArrowLeft',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(names()).toEqual([lastName, firstName]);
  },
);
