// @vitest-environment jsdom
import { collaborationCorral } from '@corral/testkit';
import { act, type ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { panelMemoryKey, serializePanelMemory } from '../workbench/panel/memory.ts';
import type { PanelTab, TabKey } from '../workbench/panel/tabs.ts';
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

// The session shell on the whole app (features/session-panel.md): the conversation always on
// screen, one panel of tabs beside it, and run controls standing in one operable place. These
// run the real router, the real cancel-confirmation hook over this window's sessionStorage,
// and an in-process runtime with scripted agents; only the work area's width is given.

// The composer's whole-run confirmation, watched as it renders: a test can tell it never
// mounted open, not only that it is gone once React settles.
const stopDialog = vi.hoisted(() => ({ openRenders: 0, open: false }));
vi.mock('../workbench/session/composer/dialogs.tsx', async (original) => {
  const actual = await original<typeof import('../workbench/session/composer/dialogs.tsx')>();
  return {
    ...actual,
    StopRunDialog: (props: ComponentProps<typeof actual.StopRunDialog>) => {
      stopDialog.open = props.open;
      if (props.open) stopDialog.openRenders += 1;
      return <actual.StopRunDialog {...props} />;
    },
  };
});

// The editor and the terminal's screen are leaves: what they draw is their own specs' business,
// and jsdom runs neither Monaco nor xterm. The stores beneath them are the real ones.
vi.mock('../workbench/DockDocumentPanel.tsx', () => ({
  DockDocumentPanel: ({ path }: { path: string }) => <div data-testid="document-leaf">{path}</div>,
}));
vi.mock('../workbench/terminals/TerminalView.tsx', () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-leaf">{terminalId}</div>
  ),
}));

// Words from the catalogue.
const W = {
  files: messages.Docking.files,
  changes: messages.Docking.changes,
  results: messages.Docking.artifacts,
  run: messages.Docking.run,
  runNumber: (n: number) => messages.Workbench.runNumber.replace('{number}', String(n)),
  stop: messages.Activity.stop,
  cancelRun: messages.Reins.cancelRun,
  pause: messages.Reins.pause,
  composerPause: messages.Activity.pause,
  cancelRunExplain: messages.Reins.cancelRunExplain,
  settings: messages.Desktop.settings,
  timeline: messages.RunMonitor.time,
  toggle: messages.SessionPanel.toggle,
  maximize: messages.SessionPanel.maximize,
  restore: messages.SessionPanel.restore,
  add: messages.SessionPanel.add,
  runHistory: messages.Docking.history,
};

// Each case waits a while for what today's screen never shows.
vi.setConfig({ testTimeout: 20_000 });

const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  stopDialog.openRenders = 0;
  stopDialog.open = false;
  cleanups.push(stubBrowser());
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

// --- the app -----------------------------------------------------------------------------------

async function open(world: ShellWorld, address: string, width = WIDE) {
  const shell = await mountShell(world, [address], { width });
  cleanups.push(() => shell.unmount());
  return shell;
}

async function reload(shell: MountedShell) {
  const next = await shell.reload();
  cleanups.push(() => next.unmount());
  await settle();
  return next;
}

/** What the conversation remembers, written as the panel writes it. */
function remember(
  sessionId: string,
  tabs: PanelTab[],
  selected: TabKey | null,
  openPanel = true,
): void {
  window.localStorage.setItem(
    panelMemoryKey(sessionId),
    serializePanelMemory({ tabs, selected, open: openPanel }),
  );
}

/**
 * Goes to a conversation as the sidebar's links do: an in-app link with neither panel nor
 * compose. (The sidebar's rows are virtualized and none mount in jsdom.)
 */
async function sidebarLink(shell: MountedShell, sessionId: string) {
  await act(async () => {
    void shell.router.navigate({ to: '/sessions/$sessionId', params: { sessionId } });
  });
  await settle();
}

async function back(shell: MountedShell) {
  await act(async () => shell.history.back());
  await settle();
}

const search = (shell: MountedShell) =>
  shell.router.state.location.search as Record<string, unknown>;

/** Waits, a little at a time, until `check` holds; the caller asserts it after. */
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
}

// --- what is on screen -------------------------------------------------------------------------

/** Text a person reads: the kit draws some labels twice, once hidden to reserve their width. */
function readText(element: Element) {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent?.trim();
}

const frame = () => document.querySelector<HTMLElement>('[data-slot="side-panel-frame"]');
const presentation = () => frame()?.getAttribute('data-presentation') ?? null;
const side = () => document.querySelector<HTMLElement>('[data-slot="side-panel-side"]');
const main = () => document.querySelector<HTMLElement>('[data-slot="side-panel-main"]');

function tabs(): HTMLElement[] {
  const strip = side()?.querySelector(
    `[role="tablist"][aria-label="${messages.SessionPanel.tabs}"]`,
  );
  return [...(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
}
function tabName(tab: HTMLElement) {
  return (
    tab.querySelector('[data-slot="tabs-closable-label"]')?.textContent ??
    tab.textContent ??
    ''
  ).trim();
}
const tabNames = () => tabs().map(tabName);
const selectedTab = () => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true');
const selectedName = () => {
  const tab = selectedTab();
  return tab ? tabName(tab) : null;
};
const tabNamed = (name: string) => tabs().find((tab) => tabName(tab) === name) ?? null;

/** Visible words of an element, without its aria-hidden parts (the kit doubles some labels). */
function spoken(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
  return [...node.childNodes].map(spoken).join('');
}
function nameOf(element: Element) {
  return (element.getAttribute('aria-label') ?? spoken(element)).trim();
}
function buttons(name: string, scope: ParentNode | null = document): HTMLElement[] {
  if (!scope) return [];
  return [
    ...scope.querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="menuitem"], [role="tab"]',
    ),
  ].filter((element) => nameOf(element) === name);
}

/** Shown, reachable and enabled: not inside an inert, hidden or aria-hidden region. */
function operable(element: HTMLElement) {
  if ((element as HTMLButtonElement).disabled) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.inert || node.hasAttribute('inert') || node.hidden) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    if (node.style.visibility === 'hidden') return false;
  }
  return true;
}

const toggleButton = () => buttons(W.toggle).find((button) => button.hasAttribute('aria-pressed'));
const maximizeButton = () => {
  const head = side();
  return head ? [...buttons(W.maximize, head), ...buttons(W.restore, head)][0] : undefined;
};
const composer = () => document.querySelector<HTMLElement>('[data-testid="chat-composer"]');
const composerStop = () => {
  const box = composer();
  return box ? buttons(W.stop, box)[0] : undefined;
};
/** The answer row's "Run #n" in the conversation. */
const answerRunLink = (n: number) => {
  const conversation = main() ?? document.body;
  return buttons(W.runNumber(n), conversation).find((button) => !side()?.contains(button));
};
const runHeader = () => side()?.querySelector<HTMLElement>('[data-testid="run-header"]') ?? null;
/** Whether the selected run tab shows its results view (the run screen's results pane). */
const resultsShown = () => {
  const panel = [...(side()?.querySelectorAll<HTMLElement>('[role="tabpanel"]') ?? [])].find(
    (element) => !element.hidden && element.id.startsWith('session-panel-panel-run:'),
  );
  const pane = panel?.querySelector<HTMLElement>('[data-testid="run-document"]');
  return Boolean(pane && !pane.hidden);
};
/** Every operable whole-run stop on the screen: the composer's Stop and any run head's cancel. */
const operableStops = () =>
  [...buttons(W.stop), ...buttons(W.cancelRun)].filter((button) => operable(button));

/** Whole-run command receipts on the screen, by where they stand. */
const receipts = (scope: ParentNode | null) => [
  ...(scope?.querySelectorAll<HTMLElement>('[data-testid^="receipt-"]') ?? []),
];

/** The run tab head's confirmation: its popover beside the head's cancel. */
const headAsks = () =>
  Boolean(document.querySelector(`[role="dialog"][aria-label="${W.cancelRun}"]`));
/** The composer's confirmation: its modal dialog. */
const composerAsks = () =>
  stopDialog.open &&
  [...document.querySelectorAll('[role="dialog"]')].some(
    (dialog) =>
      !dialog.hasAttribute('aria-label') && dialog.textContent?.includes(W.cancelRunExplain),
  );
const pending = (runId: string) =>
  window.sessionStorage.getItem(`corral:cancel-confirmation:${runId}`) === 'pending';
const cancels = (world: ShellWorld) =>
  world.commands.filter((command) => command.type === 'cancel');

// --- doing things ------------------------------------------------------------------------------

async function press(element: HTMLElement | null | undefined) {
  expect(element, 'the control to press is on screen').toBeTruthy();
  const target = element as HTMLElement;
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(event);
      // As a browser does: a press on a control that is not prevented focuses it.
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
const STOP_KEY = { key: '.', ctrlKey: true };
const TOGGLE_KEY = { key: 'b', ctrlKey: true, altKey: true };

async function middleClick(element: HTMLElement) {
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick'])
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 1 }));
  });
  await settle();
}

/** A conversation with one run of two (or more) working executions: the composer asks to stop it. */
async function busyRun() {
  const world = await createShellWorld({
    definition: collaborationCorral('team'),
    holds: (nodeId) => nodeId !== 'research',
  });
  const runId = await world.startRun();
  await world.working(runId, 2);
  return { world, runId };
}

/** A conversation with one run of one working execution: the composer stops it at once. */
async function quietRun(options: { folder?: boolean } = {}) {
  const world = await createShellWorld(options);
  const runId = await world.startRun();
  await world.working(runId, 1);
  return { world, runId };
}

/** Opens the run's tab from its answer row. */
async function openRunTab(n = 1) {
  await until(() => Boolean(answerRunLink(n)));
  await press(answerRunLink(n));
  await until(() => selectedName() === W.runNumber(n));
  expect(selectedName(), 'the run tab is open and selected').toBe(W.runNumber(n));
}

const headCancelButton = () => {
  const header = runHeader();
  return header ? buttons(W.cancelRun, header)[0] : undefined;
};

/** Presses the run tab head's cancel; the head asks. */
async function headCancel() {
  await until(() => Boolean(headCancelButton()));
  await press(headCancelButton());
  await until(headAsks);
}

// --- control -----------------------------------------------------------------------------------

it('대조: 대화를 열면 컴포저가 있다 (오늘도 통과한다)', async () => {
  const { world } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`);
  expect(composer()).not.toBeNull();
});

// --- the composer's confirmation and the panel ------------------------------------------------

it('패널이 닫힘인 대화에서 답 행의 "실행 #1"로 패널을 옆으로 열었고 컴포저가 전체 중지 확인을 묻고 있다 → 뒤로 가기 → 패널은 닫힘이 되고 확인 대기는 남으며 취소는 보내지지 않았다', async () => {
  const { world, runId } = await busyRun();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  expect(presentation()).toBe('beside');
  await until(() => Boolean(composerStop() && operable(composerStop() as HTMLElement)));
  await press(composerStop());
  await until(composerAsks);
  expect(composerAsks()).toBe(true);

  await back(shell);

  expect(presentation()).toBe('closed');
  expect(pending(runId)).toBe(true);
  expect(composerAsks()).toBe(true);
  expect(cancels(world)).toEqual([]);
});

it('패널이 옆이고 확인이 떠 있지 않다 → 패널 여닫기 단축키 → 패널은 닫힘이 된다 (아래 경우의 대조)', async () => {
  const { world } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  expect(presentation()).toBe('beside');

  // Pressed where the case below presses it: on whatever holds the focus.
  await key(document.activeElement ?? window, TOGGLE_KEY);

  expect(presentation()).toBe('closed');
});

it('패널이 옆이고 실행 단위 둘이 일하는 실행 #1에 대해 컴포저가 전체 중지 확인을 묻고 있다 → 패널 여닫기 단축키 → 패널의 상태는 바뀌지 않고, 확인을 거둔 뒤 같은 단축키는 패널을 닫는다', async () => {
  const { world } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  expect(presentation()).toBe('beside');
  await until(() => Boolean(composerStop() && operable(composerStop() as HTMLElement)));
  await press(composerStop());
  await until(composerAsks);
  expect(composerAsks()).toBe(true);

  await key(document.activeElement ?? window, TOGGLE_KEY);

  expect(presentation()).toBe('beside');
  expect(composerAsks()).toBe(true);
  // The same key, once the confirmation is dismissed, does what the control case does.
  await key(document.activeElement ?? window, { key: 'Escape' });
  await until(() => !composerAsks());
  expect(composerAsks()).toBe(false);
  await key(document.activeElement ?? window, TOGGLE_KEY);
  expect(presentation()).toBe('closed');
});

it('패널이 옆이고 실행 #1의 탭이 선택돼 있으며 실행 단위 둘이 일한다 → 컴포저의 중지를 누른다 → 컴포저가 묻고 실행 #1 탭은 묻지 않는다', async () => {
  const { world, runId } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  expect(presentation()).toBe('beside');

  await until(() => Boolean(composerStop() && operable(composerStop() as HTMLElement)));
  await press(composerStop());
  await until(composerAsks);

  expect(composerAsks()).toBe(true);
  expect(headAsks()).toBe(false);
  expect(pending(runId)).toBe(true);
});

// --- the head's confirmation loses its place ----------------------------------------------------

it('패널이 넓힘이고 파일 · 실행 #1 탭이 열려 있으며 실행 #1의 탭 머리가 묻고 있다 → 파일 탭을 골랐다가 실행 #1 탭으로 돌아온다 → 확인 대기는 버려졌고 취소는 보내지지 않았으며 머리도 컴포저도 묻지 않는다', async () => {
  const { world, runId } = await busyRun();
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'run', runId }], `run:${runId}`);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  expect(tabNames()).toEqual([W.files, W.runNumber(1)]);
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');
  await headCancel();
  expect(pending(runId)).toBe(true);

  await press(tabNamed(W.files));
  expect(pending(runId)).toBe(false);
  await press(tabNamed(W.runNumber(1)));

  expect(pending(runId)).toBe(false);
  expect(headAsks()).toBe(false);
  expect(composerAsks()).toBe(false);
  expect(stopDialog.openRenders).toBe(0);
  expect(cancels(world)).toEqual([]);
});

it('패널이 넓힘이고 실행 #1의 탭 머리가 전체 중지 확인을 묻고 있다 → 넓히기를 푼다 → 확인 대기는 버려지고 취소는 보내지지 않으며 컴포저의 확인은 한 번도 뜨지 않는다', async () => {
  const { world, runId } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');
  await headCancel();
  expect(pending(runId)).toBe(true);

  await press(maximizeButton());

  expect(presentation()).toBe('beside');
  expect(pending(runId)).toBe(false);
  // Watched as it rendered: the composer's dialog never mounted open, even for one commit.
  expect(stopDialog.openRenders).toBe(0);
  expect(composerAsks()).toBe(false);
  expect(cancels(world)).toEqual([]);
});

it('패널이 서랍이고 실행 #1의 탭 머리가 전체 중지 확인을 묻고 있다 → 서랍을 닫는다 → 확인 대기는 버려지고 취소는 보내지지 않으며 컴포저의 확인은 한 번도 뜨지 않는다', async () => {
  const { world, runId } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`, NARROW);
  await openRunTab();
  expect(presentation()).toBe('drawer');
  await headCancel();
  expect(pending(runId)).toBe(true);

  await press(toggleButton());

  expect(presentation()).toBe('closed');
  expect(pending(runId)).toBe(false);
  expect(stopDialog.openRenders).toBe(0);
  expect(cancels(world)).toEqual([]);
});

it('패널이 서랍이고 실행 #1의 탭 머리가 전체 중지 확인을 묻고 있다 → 창이 넓어져 자리가 생긴다 → 패널은 옆이 되고 확인 대기는 버려지며 컴포저의 확인은 한 번도 뜨지 않는다', async () => {
  const { world, runId } = await busyRun();
  const shell = await open(world, `/sessions/${world.sessionId}`, NARROW);
  await openRunTab();
  expect(presentation()).toBe('drawer');
  await headCancel();
  expect(pending(runId)).toBe(true);

  await shell.setWidth(WIDE);

  expect(presentation()).toBe('beside');
  expect(pending(runId)).toBe(false);
  expect(stopDialog.openRenders).toBe(0);
  expect(cancels(world)).toEqual([]);
});

it('패널이 넓힘이고 실행 #1이 대화의 지금 실행이며 실행 단위 둘이 일하고 그 탭 머리가 묻고 있다 → 새로 고친다 → 넓힘이 아니고 확인 대기는 실행 #1에 남아 컴포저가 묻고, 그 탭의 실행을 다 읽은 뒤에도 묻는다', async () => {
  const { world, runId } = await busyRun();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');
  await headCancel();
  expect(pending(runId)).toBe(true);

  const reloaded = await reload(shell);
  await until(composerAsks);

  expect(presentation()).toBe('beside');
  expect(selectedName()).toBe(W.runNumber(1));
  expect(pending(runId)).toBe(true);
  expect(composerAsks()).toBe(true);
  // The tab's run has loaded: its head is drawn, without controls, and the composer still asks.
  await until(() => Boolean(runHeader()));
  expect(runHeader()).not.toBeNull();
  await settle();
  expect(composerAsks()).toBe(true);
  expect(headAsks()).toBe(false);
  expect(cancels(world)).toEqual([]);
  expect(search(reloaded).panel).toBe('run');
});

// --- one operable place -------------------------------------------------------------------------

it('패널이 옆이고 진행 중인 실행 #1의 탭이 선택돼 있으며 Run 전체 명령의 receipt 하나가 적용을 기다린다 → 그 탭에는 일시정지 · 중지와 receipt가 없고, 조작할 수 있는 중지는 컴포저의 것 하나이며 일시정지 명령의 receipt는 그 탭에 서지 않는다', async () => {
  const { world } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  expect(presentation()).toBe('beside');
  await until(() => Boolean(runHeader()));
  // The composer's Reins controls stand in its activity details. A pause waits for the active
  // work to settle: the command is accepted, not applied.
  await until(() => Boolean(main()?.querySelector('[data-activity-toggle]')));
  await press(main()?.querySelector<HTMLElement>('[data-activity-toggle]'));
  const pause = () => buttons(W.composerPause, main()).find(operable);
  await until(() => Boolean(pause()));
  await press(pause());
  await until(() => world.commands.some((command) => command.type === 'pause'));

  const stops = operableStops();
  expect(stops).toHaveLength(1);
  expect(composer()?.contains(stops[0] as HTMLElement)).toBe(true);
  expect(buttons(W.pause, runHeader())).toEqual([]);
  expect(buttons(W.cancelRun, runHeader())).toEqual([]);
  // The composer has no receipt place of its own (it says the run's state on its activity line);
  // what this case pins is that the receipt does not stand in the run tab beside it.
  expect(receipts(side())).toEqual([]);
  // The receipt is there, waiting: maximized, the run tab's head carries it.
  await press(maximizeButton());
  await until(() => receipts(side()).length > 0);
  expect(receipts(side()).length).toBeGreaterThan(0);
});

it('패널이 넓힘이고 진행 중인 실행 #1의 탭이 선택돼 있다 → 조작할 수 있는 중지는 그 탭 머리의 것 하나이고 실행 조작과 receipt 자리도 그곳에 있다', async () => {
  const { world } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');
  await until(() => Boolean(headCancelButton()));

  const stops = operableStops();
  expect(stops).toHaveLength(1);
  expect(runHeader()?.contains(stops[0] as HTMLElement)).toBe(true);
  // The run's controls and their receipts region: in the head, and nowhere operable besides.
  const controls = [
    ...document.querySelectorAll<HTMLElement>(
      `section[aria-label="${messages.Reins.runControls}"]`,
    ),
  ].filter(operable);
  expect(controls).toHaveLength(1);
  expect(runHeader()?.contains(controls[0] as HTMLElement)).toBe(true);
  // A pause from the head: its receipt stands in the head, not by the hidden composer.
  await press(buttons(W.pause, runHeader()).find(operable));
  await until(() => receipts(runHeader()).length > 0);
  expect(receipts(runHeader()).length).toBeGreaterThan(0);
  // Only there: no other place on the screen carries one.
  expect(receipts(document).length).toBe(receipts(runHeader()).length);
});

it('패널이 서랍이고 진행 중인 실행 #1의 탭이 선택돼 있다 → 그 탭의 머리에 일시정지 · 중지가 있고 컴포저는 조작을 받지 않는다', async () => {
  const { world } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`, NARROW);
  await openRunTab();
  expect(presentation()).toBe('drawer');
  await until(() => Boolean(headCancelButton()));

  expect(buttons(W.pause, runHeader() as HTMLElement).filter(operable)).toHaveLength(1);
  expect(buttons(W.cancelRun, runHeader() as HTMLElement).filter(operable)).toHaveLength(1);
  expect(operable(composerStop() as HTMLElement)).toBe(false);
  expect(operableStops()).toHaveLength(1);
});

it('실행 #1을 컴포저에서 일시정지했다가 재개했고 그 receipt 둘이 적용된 뒤 실행이 끝났다 → 대화 옆의 그 탭 머리에 조작도 receipt도 없다', async () => {
  const { world, runId } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`);
  // The composer's Reins controls stand in its activity details.
  await until(() => Boolean(main()?.querySelector('[data-activity-toggle]')));
  await press(main()?.querySelector<HTMLElement>('[data-activity-toggle]'));
  const control = (name: string) => buttons(name, main()).find(operable);
  await until(() => Boolean(control(messages.Activity.pause)));
  await press(control(messages.Activity.pause));
  await world.releaseReplies();
  await world.runReaches(runId, ['paused']);
  await until(() => Boolean(control(messages.Activity.resume)));
  await press(control(messages.Activity.resume));
  await world.releaseReplies();
  await world.runReaches(runId, ['succeeded']);
  expect(world.commands.map((command) => command.type)).toEqual(['pause', 'resume']);
  await openRunTab();
  expect(presentation()).toBe('beside');
  await until(() => Boolean(runHeader()));

  expect(runHeader()).not.toBeNull();
  expect(buttons(W.pause, runHeader() as HTMLElement)).toEqual([]);
  expect(buttons(W.cancelRun, runHeader() as HTMLElement)).toEqual([]);
  // Applied receipts need no confirmation, so the finished run's head shows none of them.
  expect(receipts(runHeader())).toEqual([]);
});

// --- the stop command ---------------------------------------------------------------------------

it('패널이 넓힘이고 실행 단위 하나가 일하는 진행 중인 실행 #1의 탭이 선택돼 있다 → 중지 단축키 → 탭 머리가 전체 중지 확인을 묻고 취소는 아직 보내지지 않는다', async () => {
  const { world, runId } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');
  await until(() => Boolean(headCancelButton()));

  await key(document.activeElement ?? window, STOP_KEY);
  await until(headAsks);

  expect(headAsks()).toBe(true);
  expect(pending(runId)).toBe(true);
  expect(stopDialog.openRenders).toBe(0);
  expect(cancels(world)).toEqual([]);
});

it('패널이 넓힘이고 파일 탭이 선택돼 있으며 실행 단위 둘이 일하는 실행 #1이 진행 중이다 → 중지 단축키 → 넓히기가 풀리고 컴포저가 전체 중지 확인을 묻는다', async () => {
  const { world, runId } = await busyRun();
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  expect(selectedName()).toBe(W.files);
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');

  await key(document.activeElement ?? window, STOP_KEY);
  await until(composerAsks);

  expect(presentation()).toBe('beside');
  expect(selectedName()).toBe(W.files);
  expect(composerAsks()).toBe(true);
  expect(pending(runId)).toBe(true);
  expect(cancels(world)).toEqual([]);
});

// --- respond -----------------------------------------------------------------------------------

const respondButton = () => side()?.querySelector<HTMLElement>('[data-testid="run-respond"]');
const trayFocused = () => Boolean(document.activeElement?.closest('[data-pending-tray]'));

it('패널이 넓힘이고 응답을 기다리는 실행 #1의 탭이 선택돼 있다 → 탭 머리의 응답하기 → 넓히기가 풀리고 대화의 지금 필요한 것이 보인다', async () => {
  const world = await createShellWorld();
  const runId = await world.startRun({ breakpoints: ['writer'] });
  await world.runReaches(runId, ['awaiting_user']);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');
  await until(() => Boolean(respondButton()));

  await press(respondButton());
  await until(trayFocused);

  expect(presentation()).toBe('beside');
  expect(selectedName()).toBe(W.runNumber(1));
  expect(search(shell).panel).toBe('run');
  expect(trayFocused()).toBe(true);
});

it('패널이 옆이고 응답을 기다리는 실행 #1의 탭이 선택돼 있다 → 그 탭의 응답하기 → 패널과 탭 선택과 주소의 panel은 그대로이고 대화의 지금 필요한 것이 보인다', async () => {
  const world = await createShellWorld();
  const runId = await world.startRun({ breakpoints: ['writer'] });
  await world.runReaches(runId, ['awaiting_user']);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  expect(presentation()).toBe('beside');
  await until(() => Boolean(respondButton()));

  await press(respondButton());
  await until(trayFocused);

  expect(presentation()).toBe('beside');
  expect(selectedName()).toBe(W.runNumber(1));
  expect(search(shell)).toMatchObject({ panel: 'run', run: runId });
  expect(trayFocused()).toBe(true);
});

// --- closing is hiding --------------------------------------------------------------------------

it('진행 중인 실행 #1의 탭을 닫고 패널을 여닫는다 → 명령은 보내지지 않고 실행은 계속된다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'run', runId }], `run:${runId}`);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  expect(tabNames()).toEqual([W.files, W.runNumber(1)]);

  await key(tabNamed(W.runNumber(1)) as HTMLElement, { key: 'Delete' });
  expect(tabNames()).toEqual([W.files]);
  await press(toggleButton());
  expect(presentation()).toBe('closed');
  await press(toggleButton());
  expect(presentation()).toBe('beside');

  expect(world.commands).toEqual([]);
  const { projection } = await world.transport.getSnapshot(runId);
  expect(projection.status).toBe('running');
  expect(search(shell).panel).toBe('files');
});

it('파일 · 실행 #1 탭이 열려 있고 파일 탭이 선택돼 있으며 컴포저에 글을 쓰는 중이다 → 실행 #1 탭을 가운데 버튼으로 닫는다 → 실행 #1 탭이 닫히고 포커스와 입력 위치는 컴포저에 그대로 있다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'run', runId }], 'files');
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  expect(tabNames()).toEqual([W.files, W.runNumber(1)]);
  const input = composer()?.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => {
    input.focus();
    input.setSelectionRange(0, 0);
  });

  await middleClick(tabNamed(W.runNumber(1)) as HTMLElement);

  expect(tabNames()).toEqual([W.files]);
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
});

it('프로젝트 폴더가 연결되고 실행이 있는 대화에서 파일 · 실행 #1 탭이 열려 있고 포커스가 선택된 파일 탭에 있다 → Delete를 두 번 → 두 탭이 닫히고 패널은 열린 채 본문에 목록을 보이며 포커스는 "파일"에 있다', async () => {
  const { world, runId } = await quietRun({ folder: true });
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'run', runId }], 'files');
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  expect(tabNames()).toEqual([W.files, W.runNumber(1)]);
  await act(async () => tabNamed(W.files)?.focus());

  await key(document.activeElement as HTMLElement, { key: 'Delete' });
  await key(document.activeElement as HTMLElement, { key: 'Delete' });

  expect(tabNames()).toEqual([]);
  expect(presentation()).toBe('beside');
  const body = side() as HTMLElement;
  const items = [W.files, W.changes, W.runHistory, W.results].map(
    (name) => buttons(name, body)[0] ?? null,
  );
  expect(items.every(Boolean)).toBe(true);
  expect(document.activeElement).toBe(items[0]);
  expect(buttons(W.add, body)).toEqual([]);
});

it('파일 · 실행 #1 탭이 열려 있고 실행 #1 탭이 선택돼 있으며 포커스가 그 닫기 조작에 있다 → 그 닫기 조작을 누른다 → 탭이 닫히고 포커스는 이어서 선택된 "파일" 탭에 있다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'run', runId }], `run:${runId}`);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  // A screen reader can move real focus onto the close control, which leaves with its tab.
  const close = buttons(
    messages.SessionPanel.close.replace('{name}', W.runNumber(1)),
    side(),
  )[0] as HTMLElement;
  await act(async () => close.focus());
  expect(document.activeElement).toBe(close);

  await act(async () => close.click());
  await settle();

  expect(tabNames()).toEqual([W.files]);
  expect(document.activeElement).toBe(tabNamed(W.files));
});

it('폴더가 연결되고 파일 · 변경 · 실행 #1 탭이 열려 있으며 파일 탭이 선택돼 있고 포커스가 변경 탭에 있다 → Delete → 변경 탭이 닫히고 포커스는 탭 줄의 그 자리 이웃 "실행 #1"에 있으며 선택은 파일 그대로다', async () => {
  const { world, runId } = await quietRun({ folder: true });
  remember(
    world.sessionId,
    [{ kind: 'files' }, { kind: 'changes' }, { kind: 'run', runId }],
    'files',
  );
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  expect(tabNames()).toEqual([W.files, W.changes, W.runNumber(1)]);
  await act(async () => tabNamed(W.changes)?.focus());

  await key(document.activeElement as HTMLElement, { key: 'Delete' });

  expect(tabNames()).toEqual([W.files, W.runNumber(1)]);
  expect(selectedName()).toBe(W.files);
  expect(document.activeElement).toBe(tabNamed(W.runNumber(1)));
});

it('파일 탭에서 터미널이 돌고 있고 저장하지 않은 문서가 열려 있다 → 파일 탭을 닫는다 → 터미널은 계속 돌고, 명령은 보내지지 않으며, 파일 탭을 다시 열면 그 문서가 저장하지 않은 내용과 함께 있다', async () => {
  const world = await createShellWorld({ server: true, folder: true });
  const server = world.server as NonNullable<ShellWorld['server']>;
  await open(world, `/sessions/${world.sessionId}`);
  // The terminal, from the top bar's button: the 파일 tab with its terminal pane.
  await press(buttons(messages.Docking.terminal)[0]);
  await until(() => selectedName() === W.files);
  await until(() => Boolean(side()?.querySelector('[data-testid="terminal-leaf"]')));
  expect(side()?.querySelector('[data-testid="terminal-leaf"]')?.textContent).toBe(
    server.terminalId,
  );
  // A document, from quick open.
  await act(async () => {
    window.dispatchEvent(new Event('corral:quick-open'));
  });
  await settle();
  const option = () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes(server.path),
    );
  await until(() => Boolean(option()));
  await press(option());
  await until(() => Boolean(side()?.querySelector('[data-testid="document-leaf"]')));
  // Into the dock already on screen, not held until the 파일 tab is built again.
  expect(side()?.querySelector('[data-testid="document-leaf"]')?.textContent).toBe(server.path);
  // Edited, not saved.
  const docKey = Object.keys(server.documents.getState().documents)[0] as string;
  await until(() => Boolean(server.documents.getState().documents[docKey]?.model));
  await act(async () => {
    server.documents.getState().documents[docKey]?.model?.setValue('first line\nedited\n');
  });
  await until(() => server.documents.getState().documents[docKey]?.dirty === true);
  expect(server.documents.getState().documents[docKey]?.dirty).toBe(true);

  await key(tabNamed(W.files) as HTMLElement, { key: 'Delete' });
  expect(tabNames()).toEqual([]);

  // Closing hid them: no document decision, no terminal stopped or let go, no command.
  expect(document.querySelector('[role="alertdialog"], [data-slot="dialog-popup"]')).toBeNull();
  expect(server.terminalCalls).toEqual([]);
  expect(server.saves).toEqual([]);
  expect(world.commands).toEqual([]);
  expect(server.terminals.getState().terminals[server.terminalId]?.terminal.state).not.toBe(
    'stopping',
  );

  await press(buttons(W.files, side())[0]);
  await until(() => Boolean(side()?.querySelector('[data-testid="document-leaf"]')));
  expect(side()?.querySelector('[data-testid="document-leaf"]')?.textContent).toBe(server.path);
  const buffer = server.documents.getState().documents[docKey];
  expect(buffer?.dirty).toBe(true);
  expect(buffer?.model?.getValue()).toBe('first line\nedited\n');
  // The terminal pane is still there, on the same running terminal.
  expect(server.terminals.getState().terminals[server.terminalId]?.terminal.state).toBe('running');
  expect(server.terminalCalls).toEqual([]);
});

/** The pane in front of the 파일 tab's dock: the selected tab of its active group. */
const dockFront = () =>
  side()
    ?.querySelector<HTMLElement>('.dv-active-group [role="tab"][aria-selected="true"]')
    ?.textContent?.trim() ?? null;

/**
 * A project whose saved dock arrangement keeps a document in front, beside the tree and the
 * terminal, and a conversation whose panel is closed with no tab: the next page load builds the
 * 파일 tab's dock from that arrangement.
 */
async function savedDocumentInFront() {
  const world = await createShellWorld({ server: true, folder: true });
  const server = world.server as NonNullable<ShellWorld['server']>;
  const first = await mountShell(world, [`/sessions/${world.sessionId}`]);
  await press(buttons(messages.Docking.terminal)[0]);
  await until(() => Boolean(side()?.querySelector('[data-testid="terminal-leaf"]')));
  await act(async () => {
    window.dispatchEvent(new Event('corral:quick-open'));
  });
  await settle();
  const option = () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes(server.path),
    );
  await until(() => Boolean(option()));
  await press(option());
  await until(() => dockFront() === server.path);
  expect(dockFront()).toBe(server.path);
  await first.unmount();
  remember(world.sessionId, [], null, false);
  return { world, server };
}

it('저장된 배치에서 문서가 앞에 있고 패널이 닫혀 있으며 이 페이지에서 파일 탭을 연 적이 없다 → 상단의 터미널을 누른다 → 파일 탭이 열리고, 주소는 panel=terminal이며 터미널이 앞에 있다', async () => {
  const { world } = await savedDocumentInFront();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  expect(tabNames()).toEqual([]);

  await press(buttons(messages.Docking.terminal)[0]);
  await until(() => selectedName() === W.files && dockFront() !== null);

  expect(selectedName()).toBe(W.files);
  expect(search(shell).panel).toBe('terminal');
  expect(dockFront()).toBe(messages.Docking.terminal);
  // Settled, not on the way: nothing the dock restored takes the address back later.
  await settle();
  expect(search(shell).panel).toBe('terminal');
  expect(dockFront()).toBe(messages.Docking.terminal);
});

it.each(['terminal', 'tools'] as const)(
  '저장된 배치에서 문서가 앞에 있다 → 새 페이지를 panel=%s 주소로 연다 → 파일 탭이 열리고 그 창이 앞에 있으며 주소는 그대로다',
  async (pane) => {
    const { world } = await savedDocumentInFront();
    const shell = await open(world, `/sessions/${world.sessionId}?panel=${pane}`);
    await until(() => selectedName() === W.files && dockFront() !== null);

    expect(selectedName()).toBe(W.files);
    expect(search(shell).panel).toBe(pane);
    expect(dockFront()).toBe(messages.Docking[pane]);
  },
);

it('폴더가 연결되고 실행이 있는 대화에서 실행 #1 탭만 열려 있다 → "+"를 누른다 → 목록은 파일 · 변경 · 실행 기록 · 결과 순이고, 결과를 고르면 결과 탭이 열려 선택되고 포커스가 그 탭에 있다', async () => {
  const { world, runId } = await quietRun({ folder: true });
  remember(world.sessionId, [{ kind: 'run', runId }], `run:${runId}`);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  const plus = buttons(W.add, side())[0];

  await press(plus);
  await until(() => document.querySelectorAll('[role="menuitem"]').length > 0);
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map(readText)).toEqual([W.files, W.changes, W.runHistory, W.results]);
  // Each row is the kit's: its icon in the row's own icon column, its label holding only words.
  for (const item of items) {
    const name = readText(item);
    const words = [...item.querySelectorAll('span')].filter(
      (span) => span.children.length === 0 && span.textContent === name,
    );
    expect(words.length, `the label of "${name}" holds only its words`).toBeGreaterThan(0);
    for (const word of words) expect(word.parentElement?.querySelector('svg')).toBeNull();
    expect(item.querySelector('svg')).not.toBeNull();
  }
  await press(items[3]);
  await until(() => selectedName() === W.results);

  expect(tabNames()).toEqual([W.runNumber(1), W.results]);
  expect(document.activeElement).toBe(tabNamed(W.results));
});

it('"+"의 목록이 열려 있다 → Escape → 목록이 닫히고 포커스는 "+"로 돌아온다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'run', runId }], `run:${runId}`);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  const plus = buttons(W.add, side())[0] as HTMLElement;
  await press(plus);
  await until(() => document.querySelectorAll('[role="menuitem"]').length > 0);
  // Without a folder the list holds only what can be opened now.
  expect([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(readText)).toEqual([
    W.runHistory,
    W.results,
  ]);

  await key(document.activeElement ?? document.body, { key: 'Escape' });
  await until(() => document.querySelectorAll('[role="menuitem"]').length === 0);

  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  expect(document.activeElement).toBe(plus);
  expect(presentation()).toBe('beside');
});

// --- restoring, and what restoring never brings back -------------------------------------------

it('대화 A의 기억은 파일 · 실행 #1 탭과 실행 #1 선택이 있는 열린 패널이다 → 사이드바에서 대화 A를 연다 → 패널이 옆으로 열리고 파일 · 실행 #1 탭이 이 순서로 있으며 실행 #1이 선택돼 있다', async () => {
  const { world, runId } = await quietRun();
  const other = await world.createConversation('Other');
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'run', runId }], `run:${runId}`);
  const shell = await open(world, `/sessions/${other}`);
  expect(presentation()).toBe('closed');

  await sidebarLink(shell, world.sessionId);
  await until(() => selectedName() === W.runNumber(1));

  expect(presentation()).toBe('beside');
  expect(tabNames()).toEqual([W.files, W.runNumber(1)]);
  expect(search(shell)).toMatchObject({ panel: 'run', run: runId });
});

it('대화 A에서 패널이 넓힘이다 → 사이드바에서 대화 B로 갔다가 대화 A로 돌아온다 → 넓힘은 되살아나지 않고 옆이다', async () => {
  const { world } = await quietRun();
  const other = await world.createConversation('Other');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');

  await sidebarLink(shell, other);
  expect(presentation()).toBe('closed');
  await sidebarLink(shell, world.sessionId);
  await until(() => selectedName() === W.runNumber(1));

  expect(presentation()).toBe('beside');
});

it('자리가 없고 대화 A에서 서랍이 떠 있다 → 사이드바에서 대화 B로 갔다가 대화 A로 돌아온다 → 패널은 물러남이고 서랍은 뜨지 않으며 주소는 panel=run을 갖는다', async () => {
  const { world } = await quietRun();
  const other = await world.createConversation('Other');
  const shell = await open(world, `/sessions/${world.sessionId}`, NARROW);
  await openRunTab();
  expect(presentation()).toBe('drawer');

  await sidebarLink(shell, other);
  await sidebarLink(shell, world.sessionId);
  await until(() => search(shell).panel === 'run');

  expect(presentation()).toBe('withdrawn');
  expect(search(shell).panel).toBe('run');
  expect(toggleButton()?.getAttribute('aria-pressed')).toBe('false');
});

it('자리가 없어 패널이 물러남이다 → 틀이 주소를 바꿔 쓰고, 설정을 열고 닫는다 → 서랍은 뜨지 않는다', async () => {
  const { world, runId } = await quietRun();
  // The address names a run this conversation does not have: once the run list answers, the
  // frame rewrites it to the newest run on its own.
  const shell = await open(
    world,
    `/sessions/${world.sessionId}?panel=run&run=run_elsewhere`,
    NARROW,
  );
  expect(presentation()).toBe('withdrawn');
  await until(() => search(shell).run === runId);
  expect(search(shell).run).toBe(runId);
  expect(presentation()).toBe('withdrawn');

  await press(buttons(W.settings).find(operable));
  await until(() => search(shell).settings !== undefined);
  expect(search(shell).settings).toBeDefined();
  expect(presentation()).toBe('withdrawn');
  await key(document.activeElement ?? window, { key: 'Escape' });
  await until(() => search(shell).settings === undefined);

  expect(presentation()).toBe('withdrawn');
});

// --- what a tab draws ---------------------------------------------------------------------------

it('되살렸지만 아직 고르지 않은 탭은 고를 때까지 그리지 않는다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'run', runId }], 'files');
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  expect(tabNames()).toEqual([W.files, W.runNumber(1)]);
  await settle();

  expect(document.querySelector('[data-testid="run-header"]')).toBeNull();

  await press(tabNamed(W.runNumber(1)));
  await until(() => Boolean(runHeader()));
  expect(runHeader()).not.toBeNull();
});

it('닫았다가 다시 연 실행 탭은 처음 연 것처럼 시작한다', async () => {
  const { world } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await until(() => Boolean(runHeader()));
  // The run screen's own view tabs: a screen state the closed tab does not keep.
  const timeline = () => buttons(W.timeline, side())[0];
  await until(() => Boolean(timeline()));
  await press(timeline());
  expect(timeline()?.getAttribute('aria-selected')).toBe('true');

  await key(selectedTab() as HTMLElement, { key: 'Delete' });
  expect(tabNames()).toEqual([]);
  await press(answerRunLink(1));
  await until(() => selectedName() === W.runNumber(1));
  await until(() => Boolean(timeline()));

  expect(timeline()?.getAttribute('aria-selected')).toBe('false');
});

it('실행 #1 탭이 선택돼 있고 실행 #2가 진행 중이다 → 실행 #2가 끝나고 실행 #3이 시작한다 → 탭이 열리거나 닫히지 않고 선택도 패널의 상태도 바뀌지 않는다', async () => {
  const world = await createShellWorld();
  const first = await world.startRun();
  await world.releaseReplies();
  await world.runReaches(first, ['succeeded']);
  const second = await world.startRun();
  await world.working(second, 1);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab(1);
  expect(presentation()).toBe('beside');
  const before = { ...search(shell) };

  await world.releaseReplies();
  await world.runReaches(second, ['succeeded']);
  const third = await world.startRun();
  await world.working(third, 1);
  // The page has learned of the third run: its answer row is in the conversation.
  await until(() => Boolean(answerRunLink(3)));
  expect(answerRunLink(3)).toBeTruthy();

  expect(tabNames()).toEqual([W.runNumber(1)]);
  expect(selectedName()).toBe(W.runNumber(1));
  expect(presentation()).toBe('beside');
  expect(search(shell)).toEqual(before);
});

it('방금 시작한 실행을 가리키는 주소로 들어왔고 실행 목록이 아직 답하지 않았다 → 탭은 그 실행을 보이고 이름은 "실행"이다', async () => {
  const world = await createShellWorld();
  const release = world.holdListings();
  const runId = await world.startRun();
  const shell = await open(world, `/sessions/${world.sessionId}?panel=run&run=${runId}`);
  await until(() => tabNames().length > 0);

  expect(tabNames()).toEqual([W.run]);
  expect(search(shell).run).toBe(runId);

  await act(async () => release());
  await until(() => selectedName() === W.runNumber(1));
  expect(selectedName()).toBe(W.runNumber(1));
});

// --- the drawer ---------------------------------------------------------------------------------

it('자리가 없고 패널이 닫힘이다 → "실행 #1"을 누른다 → 패널이 서랍으로 뜨고, 대화는 어두워진 채 조작을 받지 않으며, 상단 줄은 조작할 수 있다', async () => {
  const { world } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`, NARROW);
  await openRunTab();

  expect(presentation()).toBe('drawer');
  expect(document.querySelector('[data-slot="side-panel-scrim"]')).not.toBeNull();
  expect(main()?.hasAttribute('inert')).toBe(true);
  expect(operable(toggleButton() as HTMLElement)).toBe(true);
  expect(toggleButton()?.getAttribute('aria-pressed')).toBe('true');
});

it('"실행 #1"을 눌러 연 서랍에 포커스가 있다 → Escape → 패널은 닫힘이 되고 탭은 남으며 포커스는 "실행 #1"로 돌아오고 주소는 compose다', async () => {
  const { world } = await quietRun();
  const shell = await open(world, `/sessions/${world.sessionId}`, NARROW);
  await until(() => Boolean(answerRunLink(1)));
  const link = answerRunLink(1);
  await openRunTab();
  expect(presentation()).toBe('drawer');
  expect(side()?.contains(document.activeElement)).toBe(true);

  await key(document.activeElement as HTMLElement, { key: 'Escape' });

  expect(presentation()).toBe('closed');
  expect(document.activeElement).toBe(link);
  expect(search(shell).compose).toBe(true);
  await press(toggleButton());
  expect(tabNames()).toEqual([W.runNumber(1)]);
});

// --- addresses that arrive, per-conversation state, and the entry ----------------------------

it('패널이 넓힘이고 응답을 기다리는 실행 #1의 탭이 선택돼 있다 → 이 대화의 결정 알림(운영체제 알림)을 누른다 → 탭은 더 열리지 않고 넓히기가 풀리며 지금 필요한 것이 보이고 주소의 respond는 쓰고 버려진다', async () => {
  const world = await createShellWorld();
  const runId = await world.startRun({ breakpoints: ['writer'] });
  await world.runReaches(runId, ['awaiting_user']);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');

  // The notification's entry carries this entry's state (with the frame's own mark) plus
  // `corralEntry: 'outside'`.
  await shell.arriveFromOutside(`/sessions/${world.sessionId}?panel=run&run=${runId}&respond=true`);
  await until(() => presentation() === 'beside');

  expect(presentation()).toBe('beside');
  expect(tabNames()).toEqual([W.runNumber(1)]);
  expect(selectedName()).toBe(W.runNumber(1));
  await until(() => search(shell).respond === undefined);
  expect(search(shell).respond).toBeUndefined();
  expect(search(shell)).toMatchObject({ panel: 'run', run: runId });
  await until(trayFocused);
  expect(trayFocused()).toBe(true);
});

it('폴더가 연결된 같은 프로젝트에서 대화 A의 변경 탭이 검토 중이다 → 사이드바로 변경 탭이 되살아나되 선택되지 않은 대화 B에 가서 변경 탭을 고른다 → B의 주소에 A의 검토 상태가 실리지 않는다', async () => {
  const world = await createShellWorld({ folder: true });
  const other = await world.createConversation('Other');
  remember(world.sessionId, [{ kind: 'changes' }], 'changes');
  remember(other, [{ kind: 'changes' }, { kind: 'files' }], 'files');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.changes);
  // In A, the 변경 tab goes to a review of the session's copy (an in-app link).
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'changes', review: true, scope: 'session', file: 'a.md' } as never,
    });
  });
  await settle();
  expect(search(shell)).toMatchObject({ panel: 'changes', review: true });

  await sidebarLink(shell, other);
  await until(() => selectedName() === W.files);
  expect(tabNames()).toEqual([W.changes, W.files]);
  await press(tabNamed(W.changes));
  await until(() => search(shell).panel === 'changes');

  expect(search(shell).panel).toBe('changes');
  expect(search(shell).review).toBeUndefined();
  expect(search(shell).scope).toBeUndefined();
  expect(search(shell).file).toBeUndefined();
});

it('실행 #1 탭이 결과 보기에 있고 패널이 옆이다 → 패널을 닫았다가 다시 연다 → 주소와 탭은 결과 보기를 지킨다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'run', runId }], `run:${runId}`);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'run', run: runId, view: 'results' } as never,
    });
  });
  await settle();
  expect(search(shell)).toMatchObject({ panel: 'run', run: runId, view: 'results' });
  await until(() => resultsShown());
  expect(resultsShown()).toBe(true);

  await press(toggleButton());
  expect(presentation()).toBe('closed');
  await press(toggleButton());

  expect(presentation()).toBe('beside');
  expect(search(shell)).toMatchObject({ panel: 'run', run: runId, view: 'results' });
  await until(() => resultsShown());
  expect(resultsShown()).toBe(true);
});

it('실행 #1 탭이 결과 보기에 있고 실행 #2 탭이 선택돼 있다 → 실행 #2 탭을 닫는다 → 이어서 선택된 실행 #1 탭은 결과 보기를 지킨다', async () => {
  const world = await createShellWorld();
  const first = await world.startRun();
  const second = await world.startRun();
  remember(
    world.sessionId,
    [
      { kind: 'run', runId: first },
      { kind: 'run', runId: second },
    ],
    `run:${first}`,
  );
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'run', run: first, view: 'results' } as never,
    });
  });
  await settle();
  await press(tabNamed(W.runNumber(2)));
  expect(search(shell)).toMatchObject({ panel: 'run', run: second });

  await key(tabNamed(W.runNumber(2)) as HTMLElement, { key: 'Delete' });

  expect(selectedName()).toBe(W.runNumber(1));
  expect(search(shell)).toMatchObject({ panel: 'run', run: first, view: 'results' });
  await until(() => resultsShown());
  expect(resultsShown()).toBe(true);
});

it('대화의 기억은 실행 #1 탭이 있는 열린 패널이다 → 다른 화면에서 advice 주소로 들어오고 작업 영역의 폭은 그 뒤에 잰다 → 패널은 기억대로 옆이고 기억은 남는다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'run', runId }], `run:${runId}`);
  const shell = await mountShell(
    world,
    [`/projects/${world.projectId}`, `/sessions/${world.sessionId}?advice=${runId}`],
    { width: null },
  );
  cleanups.push(() => shell.unmount());
  await settle();

  await shell.setWidth(WIDE);
  await until(() => presentation() === 'beside');

  expect(presentation()).toBe('beside');
  expect(tabNames()).toEqual([W.runNumber(1)]);
  expect(window.localStorage.getItem(panelMemoryKey(world.sessionId))).toContain(runId);
});

it('자리가 없어 실행 #1 탭이 서랍으로 떠 있다 → 머리에 넓히기가 없다', async () => {
  const { world } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`, NARROW);
  await openRunTab();

  expect(presentation()).toBe('drawer');
  expect(maximizeButton()).toBeUndefined();
});

it.each([
  ['"+"', () => buttons(W.add, side())[0]],
  ['넓히기', () => maximizeButton()],
] as const)(
  '실행 #1 탭 하나만 열려 있고 포커스가 머리의 %s에 있다 → 그 탭을 가운데 버튼으로 닫는다 → 머리의 조작이 사라지고 포커스는 대화의 입력란으로 간다',
  async (_name, control) => {
    const { world, runId } = await quietRun();
    remember(world.sessionId, [{ kind: 'run', runId }], `run:${runId}`);
    await open(world, `/sessions/${world.sessionId}`);
    await until(() => selectedName() === W.runNumber(1));
    const target = control() as HTMLElement;
    await act(async () => target.focus());
    expect(document.activeElement).toBe(target);

    await middleClick(tabNamed(W.runNumber(1)) as HTMLElement);

    expect(tabNames()).toEqual([]);
    expect(target.isConnected).toBe(false);
    expect(document.activeElement).toBe(composer()?.querySelector('textarea'));
  },
);

it('파일 · 실행 #1 탭이 열려 있고 실행 #1 탭이 선택돼 있다 → 답 행의 "실행 #1"을 누르고, 입력란에 들어가 파일 탭을 가운데 버튼으로 닫는다 → 포커스는 누른 때 그 탭으로 갔고, 닫은 뒤에는 입력란에 그대로 있다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'run', runId }], `run:${runId}`);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));

  await press(answerRunLink(1));
  expect(document.activeElement).toBe(tabNamed(W.runNumber(1)));
  const input = composer()?.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => input.focus());
  await middleClick(tabNamed(W.files) as HTMLElement);

  expect(tabNames()).toEqual([W.runNumber(1)]);
  expect(document.activeElement).toBe(input);
});

// --- what the removed file viewer's tests pinned ----------------------------------------------

/** Types into the conversation's input as a person does: the field's own value, then input. */
async function typeDraft(text: string) {
  const input = composer()?.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
const draft = () => (composer()?.querySelector('textarea') as HTMLTextAreaElement | null)?.value;

it('대화 입력란에 쓰던 글이 있고 실행 #1 탭이 옆에 있다 → 넓히기, 옆으로, 패널 닫기 → 쓰던 글은 그대로다', async () => {
  const { world } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await typeDraft('half a request');
  expect(draft()).toBe('half a request');

  await press(maximizeButton());
  expect(presentation()).toBe('maximized');
  expect(draft()).toBe('half a request');
  await press(maximizeButton());
  expect(presentation()).toBe('beside');
  expect(draft()).toBe('half a request');
  await press(toggleButton());
  expect(presentation()).toBe('closed');

  expect(draft()).toBe('half a request');
});

it('자리가 없어 실행 #1 탭이 서랍으로 떠 있다 → 어두워진 대화를 누른다 → 서랍이 닫히고 패널은 닫힘이며 탭은 남는다', async () => {
  const { world } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`, NARROW);
  await openRunTab();
  expect(presentation()).toBe('drawer');

  await press(document.querySelector<HTMLElement>('[data-slot="side-panel-scrim"]'));

  expect(presentation()).toBe('closed');
  await press(toggleButton());
  expect(tabNames()).toEqual([W.runNumber(1)]);
});

it('자리가 없어 실행 #1 탭이 서랍으로 떠 있고 그 머리의 "+" 목록이 열려 있다 → Escape → 목록만 닫히고 서랍은 떠 있다', async () => {
  const { world } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`, NARROW);
  await openRunTab();
  expect(presentation()).toBe('drawer');
  await press(buttons(W.add, side())[0]);
  await until(() => document.querySelectorAll('[role="menuitem"]').length > 0);
  expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);

  await key(document.activeElement ?? document.body, { key: 'Escape' });
  await until(() => document.querySelectorAll('[role="menuitem"]').length === 0);

  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  expect(presentation()).toBe('drawer');
});

// --- the 변경 tab's front follows its address -------------------------------------------------

/** The view the 변경 tab shows: its own view switch's selected tab. */
const changesView = () => {
  const list = side()?.querySelector(
    `[role="tablist"][aria-label="${messages.Review.changesViews}"]`,
  );
  const shown = [...(list?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find(
    (tab) => tab.getAttribute('aria-selected') === 'true',
  );
  return shown ? readText(shown) : null;
};
const changesViewTab = (name: string) => {
  const list = side()?.querySelector(
    `[role="tablist"][aria-label="${messages.Review.changesViews}"]`,
  );
  return [...(list?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find(
    (tab) => readText(tab) === name,
  );
};

/** In a 변경 tab: 검사 first, then back to the review, as a person goes. */
async function checksThenReview() {
  await until(() => Boolean(changesViewTab(messages.Checks.title)));
  await press(changesViewTab(messages.Checks.title));
  await until(() => changesView() === messages.Checks.title);
  await press(changesViewTab(messages.Review.tabReview));
  await until(() => changesView() === messages.Review.tabReview);
  expect(changesView()).toBe(messages.Review.tabReview);
}

it('폴더가 연결되고 변경 · 파일 탭이 열려 있다 → 변경 탭에서 검사를 보고 검토로 돌아온 뒤 파일 탭을 골랐다가 변경 탭을 다시 고른다 → 변경 탭은 검토를 보이고 주소도 검토다', async () => {
  const world = await createShellWorld({ folder: true });
  remember(world.sessionId, [{ kind: 'changes' }, { kind: 'files' }], 'changes');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.changes);
  await checksThenReview();
  expect(search(shell)).toMatchObject({ panel: 'changes', review: true });

  await press(tabNamed(W.files));
  await press(tabNamed(W.changes));

  expect(changesView()).toBe(messages.Review.tabReview);
  expect(search(shell)).toMatchObject({ panel: 'changes', review: true });
});

it('폴더가 연결되고 변경 탭이 열려 있다 → 검사를 보고 검토로 돌아온 뒤 패널을 닫았다가 다시 연다 → 변경 탭은 검토를 보이고 주소도 검토다', async () => {
  const world = await createShellWorld({ folder: true });
  remember(world.sessionId, [{ kind: 'changes' }], 'changes');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.changes);
  await checksThenReview();

  await press(toggleButton());
  expect(presentation()).toBe('closed');
  await press(toggleButton());

  expect(presentation()).toBe('beside');
  expect(changesView()).toBe(messages.Review.tabReview);
  expect(search(shell)).toMatchObject({ panel: 'changes', review: true });
});

it('폴더가 연결되고 대화 A의 변경 탭이 검사를 보인다 → 사이드바로 대화 B에 갔다가 아무것도 하지 않고 대화 A로 돌아온다 → 되살린 변경 탭은 처음 연 것처럼 검토에서 시작한다', async () => {
  const world = await createShellWorld({ folder: true });
  const other = await world.createConversation('Other');
  remember(world.sessionId, [{ kind: 'changes' }], 'changes');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.changes);
  await until(() => Boolean(changesViewTab(messages.Checks.title)));
  await press(changesViewTab(messages.Checks.title));
  await until(() => changesView() === messages.Checks.title);

  await sidebarLink(shell, other);
  await sidebarLink(shell, world.sessionId);
  await until(() => selectedName() === W.changes);

  expect(search(shell).panel).toBe('changes');
  await until(() => changesView() === messages.Review.tabReview);
  expect(changesView()).toBe(messages.Review.tabReview);
});

it('폴더가 연결되고 대화 A의 변경 탭이 검사를 보인다 → 사이드바로 변경 탭이 되살아나되 선택되지 않은 대화 B에 가서 변경 탭을 고른다 → B의 변경 탭은 검토에서 시작한다', async () => {
  const world = await createShellWorld({ folder: true });
  const other = await world.createConversation('Other');
  remember(world.sessionId, [{ kind: 'changes' }], 'changes');
  remember(other, [{ kind: 'changes' }, { kind: 'files' }], 'files');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.changes);
  await until(() => Boolean(changesViewTab(messages.Checks.title)));
  await press(changesViewTab(messages.Checks.title));
  await until(() => changesView() === messages.Checks.title);

  await sidebarLink(shell, other);
  await until(() => selectedName() === W.files);
  await press(tabNamed(W.changes));

  expect(search(shell).panel).toBe('changes');
  expect(changesView()).toBe(messages.Review.tabReview);
});

it('이전 형식의 숫자 표시가 남은 기록 상태로 앱 안의 링크가 실행 #1 탭을 가리킨다 → 오류 없이 그 탭이 열린다', async () => {
  const { world, runId } = await quietRun();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  // An error thrown while the frame reads the entry, however React reports it.
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.error);
  window.addEventListener('error', onError);
  const logged = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (args.some((arg) => arg instanceof TypeError)) errors.push(args);
  });
  cleanups.push(() => {
    window.removeEventListener('error', onError);
    logged.mockRestore();
  });
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'run', run: runId } as never,
      state: ((previous: object) => ({ ...previous, corralPanelWrite: 7 })) as never,
    });
  });
  await settle();
  await until(() => selectedName() === W.runNumber(1));

  expect(errors).toEqual([]);
  expect(selectedName()).toBe(W.runNumber(1));
});
