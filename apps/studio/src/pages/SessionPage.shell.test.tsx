// @vitest-environment jsdom
import { collaborationCorral } from '@corral/testkit';
import { act, type ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { registeredCommands } from '../commandRegistry.ts';
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
// The settings dialog's general section, standing in for a form with unsaved changes.
const unsavedSettings = vi.hoisted(() => ({ dirty: false }));
vi.mock('./AppearanceSettings.tsx', async () => {
  const { useSettingsForm } = await import('../workbench/SettingsLifecycle.tsx');
  return {
    AppearanceSettings: () => {
      useSettingsForm({ dirty: unsavedSettings.dirty });
      return <p data-testid="settings-form">form</p>;
    },
  };
});

// The advice arrivals the conversation's rows are given, by run and request.
const adviceArrivals = vi.hoisted(() => ({ seen: new Set<string>() }));
vi.mock('../workbench/adviceArrival.ts', async (original) => {
  const actual = await original<typeof import('../workbench/adviceArrival.ts')>();
  return {
    ...actual,
    useAdviceArrivalRequest: (...args: Parameters<typeof actual.useAdviceArrivalRequest>) => {
      const value = actual.useAdviceArrivalRequest(...args);
      if (value) adviceArrivals.seen.add(`${value.runId}:${value.key}`);
      return value;
    },
  };
});

// The Git view with something staged: its commit message field on screen.
const gitStaged = vi.hoisted(() => ({ on: false }));
vi.mock('../workbench/GitPanel.tsx', async (original) => {
  const actual = await original<typeof import('../workbench/GitPanel.tsx')>();
  return {
    ...actual,
    GitPanel: (props: ComponentProps<typeof actual.GitPanel>) =>
      gitStaged.on ? (
        <textarea id="git-commit-message" aria-label={messages.Git.commitMessage} />
      ) : (
        <actual.GitPanel {...props} />
      ),
  };
});

// A document may hold a link into this conversation (a run named by a preview lease, a writer
// held by a run): a test sets it here.
const documentLink = vi.hoisted(() => ({
  current: null as { sessionId: string; search: Record<string, unknown> } | null,
}));
vi.mock('../workbench/DockDocumentPanel.tsx', async () => {
  const { Link } = await import('@tanstack/react-router');
  return {
    DockDocumentPanel: ({ path }: { path: string }) => (
      <div data-testid="document-leaf">
        {path}
        {documentLink.current ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: documentLink.current.sessionId }}
            search={documentLink.current.search as never}
            data-testid="document-link"
          >
            link
          </Link>
        ) : null}
      </div>
    ),
  };
});
// While `attached` is false the terminal's screen has not attached yet: a way that names the
// terminal is left waiting for it.
const terminalScreen = vi.hoisted(() => ({ attached: true }));
vi.mock('../workbench/terminals/TerminalView.tsx', () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) =>
    terminalScreen.attached ? (
      <section data-testid="terminal-leaf" data-terminal-screen="" tabIndex={-1}>
        {terminalId}
      </section>
    ) : (
      <section data-testid="terminal-leaf">{terminalId}</section>
    ),
}));

// The desktop shell, for a test that sends its menu commands: absent otherwise, as in a browser.
const desktopShell = vi.hoisted(() => ({
  commands: null as ((id: string) => void)[] | null,
}));
vi.mock('../desktop.tsx', async (original) => {
  const actual = await original<typeof import('../desktop.tsx')>();
  const bridge = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === 'then'
          ? undefined
          : typeof name === 'string' && name.startsWith('on')
            ? (callback: (id: string) => void) => {
                if (name === 'onCommand') desktopShell.commands?.push(callback);
                return () => {
                  if (name !== 'onCommand') return;
                  const listening = desktopShell.commands;
                  const at = listening?.indexOf(callback) ?? -1;
                  if (at >= 0) listening?.splice(at, 1);
                };
              }
            : async () => undefined,
    },
  );
  return {
    ...actual,
    get desktop() {
      return desktopShell.commands ? bridge : undefined;
    },
  };
});

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
  terminalScreen.attached = true;
  desktopShell.commands = null;
  gitStaged.on = false;
  adviceArrivals.seen.clear();
  documentLink.current = null;
  unsavedSettings.dirty = false;
  stopDialog.openRenders = 0;
  stopDialog.open = false;
  cleanups.push(stubBrowser());
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
/** The selected run tab's record, once its run has loaded (beside, its head may be absent). */
const runRecord = () => side()?.querySelector<HTMLElement>('[data-testid="run-monitor"]') ?? null;
/** Whether the selected run tab shows its results view (the run screen's results pane). */
const resultsShown = () => {
  const panel = [...(side()?.querySelectorAll<HTMLElement>('[role="tabpanel"]') ?? [])].find(
    (element) => !element.hidden && element.id.startsWith('session-panel-panel-run:'),
  );
  const pane = panel?.querySelector<HTMLElement>('[data-testid="run-document"]');
  return Boolean(pane && !pane.hidden);
};
/**
 * Inside a whole-run confirmation: the head's popover or the composer's dialog. Its own button
 * carries the stop's name but is the answer to the question, not a second stop.
 */
const inConfirmation = (element: HTMLElement) => {
  const dialog = element.closest('[role="dialog"]');
  return Boolean(
    dialog &&
      (dialog.getAttribute('aria-label') === W.cancelRun ||
        dialog.textContent?.includes(W.cancelRunExplain)),
  );
};
/** The run controls on the screen (a run head's), where a whole-run stop by that name stands. */
const runControls = () => [
  ...document.querySelectorAll<HTMLElement>(`section[aria-label="${messages.Reins.runControls}"]`),
];
/**
 * Every operable whole-run stop on the screen: the composer's Stop and any run head's stop.
 * A paused step's "Stop the run" answers its approval and is not counted; nor is a
 * confirmation's own button.
 */
const operableStops = () =>
  [
    ...new Set([
      ...buttons(W.stop),
      ...runControls().flatMap((controls) => buttons(W.cancelRun, controls)),
    ]),
  ].filter((button) => operable(button) && !inConfirmation(button));

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
  return header
    ? buttons(W.cancelRun, header).find((button) => !inConfirmation(button))
    : undefined;
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

it('파일 탭이 선택된 패널이 옆이고 답 행의 "실행 #1"로 실행 탭을 연 뒤 컴포저가 전체 중지 확인을 묻고 있다 → 뒤로 가기로 파일 탭이 다시 선택된다 → 확인 대기는 남고 취소는 보내지지 않았다', async () => {
  const { world, runId } = await busyRun();
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  await openRunTab();
  await until(() => Boolean(runHeader()));
  await until(() => Boolean(composerStop() && operable(composerStop() as HTMLElement)));
  await press(composerStop());
  await until(composerAsks);

  await back(shell);
  await until(() => selectedName() === W.files);

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
  await until(() => readText(document.activeElement as Element) === messages.Reins.keepRunning);

  expect(composerAsks()).toBe(true);
  expect(headAsks()).toBe(false);
  expect(pending(runId)).toBe(true);
  expect(readText(document.activeElement as Element)).toBe(messages.Reins.keepRunning);
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
  // The popover's own button carries the stop's name; it is not a second stop.
  expect(operableStops()).toEqual([headCancelButton()]);

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
  // The tab's run has loaded, its head without controls, and the composer still asks.
  await until(() => Boolean(runRecord()));
  expect(runRecord()).not.toBeNull();
  expect(headCancelButton()).toBeUndefined();
  await settle();
  expect(composerAsks()).toBe(true);
  expect(headAsks()).toBe(false);
  expect(cancels(world)).toEqual([]);
  expect(search(reloaded).panel).toBe('run');
});

// --- one operable place -------------------------------------------------------------------------

/** The composer's Reins pause: in its activity details. */
async function composerPause() {
  await until(() => Boolean(main()?.querySelector('[data-activity-toggle]')));
  const toggle = main()?.querySelector<HTMLElement>('[data-activity-toggle]');
  if (toggle?.getAttribute('aria-expanded') !== 'true') await press(toggle);
  const pause = () => buttons(W.composerPause, main()).find(operable);
  await until(() => Boolean(pause()));
  await press(pause());
}
const retryButton = (scope: ParentNode | null) =>
  scope ? buttons(messages.Reins.retrySameCommand, scope as HTMLElement) : [];

it('패널이 옆이고 진행 중인 실행 #1의 탭이 선택돼 있으며 Run 전체 명령의 receipt 하나가 적용을 기다린다 → 그 탭의 머리에는 일시정지 · 중지가 없고 그 receipt만 보이며, 그 명령이 적용되면 머리에 receipt가 남지 않는다', async () => {
  const { world, runId } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  expect(presentation()).toBe('beside');
  await until(() => Boolean(runHeader()));
  // A pause waits for the active work to settle: the command is accepted, not applied.
  await composerPause();
  await until(() => world.commands.some((command) => command.type === 'pause'));
  await until(() => receipts(runHeader()).length > 0);

  expect(receipts(runHeader())).toHaveLength(1);
  expect(buttons(W.pause, runHeader())).toEqual([]);
  expect(buttons(W.cancelRun, runHeader())).toEqual([]);
  const stops = operableStops();
  expect(stops).toHaveLength(1);
  expect(composer()?.contains(stops[0] as HTMLElement)).toBe(true);

  // Applied: nothing is left to confirm.
  await world.releaseReplies();
  await world.runReaches(runId, ['paused']);
  await until(() => receipts(runHeader()).length === 0);
  expect(receipts(runHeader())).toEqual([]);
  expect(buttons(W.pause, runHeader())).toEqual([]);
});

it('패널이 옆이고 진행 중인 실행 #1의 탭이 선택돼 있다 → 컴포저의 일시정지가 응답을 잃는다 → 그 탭의 머리에 같은 명령 다시 시도가 있고, 누르면 같은 명령 ID로 다시 보낸다', async () => {
  const { world } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await until(() => Boolean(runHeader()));
  world.loseNextAnswer();
  await composerPause();
  await until(() => retryButton(runHeader()).length > 0);

  expect(retryButton(runHeader())).toHaveLength(1);
  expect(buttons(W.pause, runHeader())).toEqual([]);
  expect(buttons(W.cancelRun, runHeader())).toEqual([]);
  const [lost] = world.commands;
  await press(retryButton(runHeader())[0]);
  await until(() => world.commands.length > 1);
  expect(world.commands.map(({ type, commandId }) => ({ type, commandId }))).toEqual([
    { type: 'pause', commandId: lost?.commandId },
    { type: 'pause', commandId: lost?.commandId },
  ]);
});

it('실행 #1의 일시정지가 응답을 잃은 채 실행이 끝났다 → 대화 옆의 그 탭 머리에 조작은 없고 아직 확인이 필요한 그 명령과 같은 명령 다시 시도가 보인다', async () => {
  const { world, runId } = await quietRun();
  await open(world, `/sessions/${world.sessionId}`);
  world.loseNextAnswer();
  await composerPause();
  await until(() => world.commands.some((command) => command.type === 'pause'));
  await world.releaseReplies();
  await world.runReaches(runId, ['succeeded']);
  await openRunTab();
  expect(presentation()).toBe('beside');
  await until(() => retryButton(runHeader()).length > 0);

  expect(retryButton(runHeader())).toHaveLength(1);
  expect(buttons(W.pause, runHeader())).toEqual([]);
  expect(buttons(W.cancelRun, runHeader())).toEqual([]);
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
  await until(() => Boolean(runRecord()));

  expect(runRecord()).not.toBeNull();
  // Applied receipts need no confirmation and the controls are the composer's: beside, the
  // finished run's tab has nothing for its head to hold (execution-monitor.md), so it has none.
  expect(runHeader()).toBeNull();
  expect(buttons(W.pause, runRecord() as HTMLElement)).toEqual([]);
  expect(buttons(W.cancelRun, runRecord() as HTMLElement)).toEqual([]);
  expect(receipts(runRecord())).toEqual([]);
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
  await until(() => readText(document.activeElement as Element) === messages.Reins.keepRunning);

  expect(headAsks()).toBe(true);
  // execution-monitor.md: wherever the confirmation asks, the first focus is on Keep running.
  expect(readText(document.activeElement as Element)).toBe(messages.Reins.keepRunning);
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

it('패널이 넓힘이고 파일 탭이 선택돼 있으며 실행 단위 하나가 일하는 실행 #1이 진행 중이다 → 중지 단축키 → 넓히기가 풀리고, 컴포저의 중지 버튼이라면 묻지 않을 때에도 컴포저가 전체 중지 확인을 묻는다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
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

it('패널이 넓힘이고 응답을 기다리는 실행 #1의 탭이 선택돼 있다 → 확인 필요가 읽기로 열리고 그 응답하기를 누른다 → 넓히기가 풀리고 대화의 지금 필요한 것이 보인다', async () => {
  const world = await createShellWorld();
  const runId = await world.startRun({ breakpoints: ['writer'] });
  await world.runReaches(runId, ['awaiting_user']);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');
  // Maximized, what waits shows to read in the response area, whose Respond is the one way.
  const areaRespond = () =>
    side()?.querySelector<HTMLElement>('[data-testid="respond-in-conversation"]') ?? null;
  await until(() => Boolean(areaRespond()));
  expect(respondButton()).toBeNull();

  await press(areaRespond());
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
  // The terminal, from its address: the 파일 tab with its terminal pane.
  await open(world, `/sessions/${world.sessionId}?panel=terminal`);
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
  const first = await mountShell(world, [`/sessions/${world.sessionId}?panel=terminal`]);
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

it('실행이 둘인 대화의 파일 탭에서 문서 안의 링크가 실행 #1을 가리킨다 → 그 링크를 누른다 → 가장 새 실행이 아니라 실행 #1의 탭이 열려 선택된다', async () => {
  const world = await createShellWorld({ server: true, folder: true });
  const server = world.server as NonNullable<ShellWorld['server']>;
  const older = await world.startRun();
  await world.working(older, 1);
  const newer = await world.startRun();
  await world.working(newer, 1);
  documentLink.current = {
    sessionId: world.sessionId,
    search: { panel: 'run', run: older, view: 'run' },
  };
  await open(world, `/sessions/${world.sessionId}`);
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
  await until(() => Boolean(side()?.querySelector('[data-testid="document-link"]')));

  await press(side()?.querySelector<HTMLElement>('[data-testid="document-link"]'));
  await until(() => selectedName() !== W.files);

  expect(selectedName()).toBe(W.runNumber(1));
});

it('패널이 닫힌 대화에서 이 대화 안의 링크가 panel=run과 실행 #1을 가리킨다 → 그 링크를 따라간다 → 실행 #1 탭이 열리고 포커스가 그 탭에 있으며, 뒤로 가기는 포커스를 옮기지 않는다', async () => {
  const { world, runId } = await quietRun();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  expect(presentation()).toBe('closed');

  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'run', run: runId, view: 'run' } as never,
    });
  });
  await settle();
  await until(() => selectedName() === W.runNumber(1));
  await until(() => document.activeElement === tabNamed(W.runNumber(1)));
  expect(document.activeElement).toBe(tabNamed(W.runNumber(1)));

  const input = document.querySelector<HTMLTextAreaElement>(
    '[data-testid="chat-composer"] textarea',
  );
  await act(async () => input?.focus());
  await back(shell);
  await settle();
  expect(document.activeElement).toBe(input);
});

it.each([
  ['패널이 열리고 탭이 있는 대화 A', 'open'],
  ['패널이 닫혔지만 탭이 있는 대화 A', 'closed'],
  ['다른 화면', 'screen'],
] as const)(
  '%s에서 앱 안의 링크가 다른 대화의 panel=run과 실행 #1을 가리킨다 → 그 링크를 따라간다 → 실행 #1 탭이 열리고 포커스가 그 탭에 있다',
  async (_from, start) => {
    const { world, runId } = await quietRun({ folder: true });
    const other = await world.createConversation('Other');
    remember(other, [{ kind: 'changes' }], 'changes', start === 'open');
    const shell = await open(
      world,
      start === 'screen' ? `/projects/${world.projectId}` : `/sessions/${other}`,
    );
    if (start === 'open') await until(() => selectedName() === W.changes);

    await act(async () => {
      void shell.router.navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: world.sessionId },
        search: { panel: 'run', run: runId, view: 'run' } as never,
      });
    });
    await settle();
    await until(() => pathname(shell) === `/sessions/${world.sessionId}`);
    await until(() => selectedName() === W.runNumber(1));
    await until(() => document.activeElement === tabNamed(W.runNumber(1)));

    expect(document.activeElement).toBe(tabNamed(W.runNumber(1)));
  },
);

it('폴더가 연결된 대화에서 패널이 닫혀 있다 → 이 대화 안의 링크가 panel=terminal을 가리킨다 → 파일 탭이 열리고 포커스는 그 안의 터미널에 있다', async () => {
  const world = await createShellWorld({ server: true, folder: true });
  const shell = await open(world, `/sessions/${world.sessionId}`);
  const server = world.server as NonNullable<ShellWorld['server']>;
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'terminal', terminal: server.terminalId } as never,
    });
  });
  await settle();
  const terminal = () => side()?.querySelector<HTMLElement>('[data-testid="terminal-leaf"]');
  await until(() => Boolean(terminal()) && document.activeElement === terminal());

  expect(selectedName()).toBe(W.files);
  expect(document.activeElement).toBe(terminal());
});

it('대화 A에서 앱 안의 링크가 폴더가 연결된 다른 대화의 panel=terminal을 가리킨다 → 그 링크를 따라간다 → 파일 탭이 열리고 포커스는 그 안의 터미널에 있다', async () => {
  const world = await createShellWorld({ server: true, folder: true });
  const other = await world.createConversation('Other');
  const shell = await open(world, `/sessions/${other}`);
  const server = world.server as NonNullable<ShellWorld['server']>;
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'terminal', terminal: server.terminalId } as never,
    });
  });
  await settle();
  await until(() => pathname(shell) === `/sessions/${world.sessionId}`);
  const terminal = () => side()?.querySelector<HTMLElement>('[data-testid="terminal-leaf"]');
  await until(() => Boolean(terminal()) && document.activeElement === terminal());

  expect(selectedName()).toBe(W.files);
  expect(document.activeElement).toBe(terminal());
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

const dockSaved = () =>
  Object.keys(window.localStorage).filter((key) => key.startsWith('corral:docking:v1:'));

it('폴더가 연결되고 저장된 배치가 없는 대화에서 "+"로 파일 탭을 열고 도킹에서는 아무것도 하지 않는다 → 주소가 자리 잡은 뒤에도, 다른 탭을 골랐다가 돌아온 뒤에도 배치는 저장되지 않는다 (workbench.md)', async () => {
  const world = await createShellWorld({ server: true, folder: true });
  await world.working(await world.startRun(), 1);
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await press(buttons(W.add, side())[0]);
  await until(() => document.querySelectorAll('[role="menuitem"]').length > 0);
  const filesItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => readText(item) === W.files,
  );
  await press(filesItem);
  await until(() => selectedName() === W.files);
  await settle();
  expect(dockSaved()).toEqual([]);

  await press(tabNamed(W.runNumber(1)));
  await press(tabNamed(W.files));
  await settle();
  expect(dockSaved()).toEqual([]);
});

it('폴더가 연결되고 저장된 배치가 없는 대화의 기억이 파일 탭이다 → 대화에 들어와 도킹에서는 아무것도 하지 않는다 → 배치는 저장되지 않는다 (workbench.md)', async () => {
  const world = await createShellWorld({ server: true, folder: true });
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  await settle();
  expect(dockSaved()).toEqual([]);
});

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

/** A conversation with three runs: two ended, the newest working. */
async function threeRuns() {
  const world = await createShellWorld();
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const runId = await world.startRun();
    await world.releaseReplies();
    await world.runReaches(runId, ['succeeded']);
    ids.push(runId);
  }
  const newest = await world.startRun();
  await world.working(newest, 1);
  ids.push(newest);
  return { world, ids };
}
/** The run history's rows: the kit draws a row's label twice, once hidden to hold its width. */
const runRows = () => [
  ...new Set(
    [...document.querySelectorAll<HTMLElement>('[data-run-history-row]')].map(
      (row) => row.closest<HTMLElement>('[role="menuitem"]') ?? row,
    ),
  ),
];
const runRowNumbers = () =>
  runRows().map((row) => readText(row)?.match(/#\d+/)?.[0] ?? readText(row));

async function openRunHistory() {
  await press(buttons(W.add, side())[0]);
  await until(() => document.querySelectorAll('[role="menuitem"]').length > 0);
  const history = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => readText(item) === W.runHistory,
  );
  await press(history);
  await until(() => runRows().length > 0);
}

it('실행이 셋인 대화에서 패널이 옆이고 실행 #1 탭이 선택돼 있다 → "+"를 누르고 실행 기록의 하위 목록을 연다 → 실행 #3 · 실행 #2 · 실행 #1이 이 순서로 각자의 상태 표시와 함께 있고, 상단 경로는 대화 이름에서 끝난다', async () => {
  const { world, ids } = await threeRuns();
  remember(world.sessionId, [{ kind: 'run', runId: ids[0] as string }], `run:${ids[0]}`);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  // The path ends at the conversation's name: no run item after it.
  const path = document.querySelector('nav [data-crumb="current"]')?.closest('nav');
  expect(path).not.toBeNull();
  expect(path?.querySelector('[data-crumb="extra"]')).toBeNull();
  expect(buttons(W.runNumber(1), path ?? null)).toEqual([]);

  await openRunHistory();
  expect(runRowNumbers()).toEqual(['#3', '#2', '#1']);
  for (const row of runRows()) expect(row.querySelector('[role="img"]')).not.toBeNull();
});

it('실행이 셋인 대화에서 실행 #1 탭이 선택돼 있다 → "+"의 실행 기록에서 실행 #2를 고른다 → 실행 #2 탭이 탭 줄의 오른쪽 끝에 열려 선택되고, 주소는 그 실행으로 바뀌어 쓰이며 기록은 쌓이지 않는다', async () => {
  const { world, ids } = await threeRuns();
  remember(world.sessionId, [{ kind: 'run', runId: ids[0] as string }], `run:${ids[0]}`);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  const entries = shell.history.length;

  await openRunHistory();
  const second = runRows().find((row) => readText(row)?.includes('#2'));
  await press(second);
  await until(() => selectedName() === W.runNumber(2));

  expect(tabNames()).toEqual([W.runNumber(1), W.runNumber(2)]);
  expect(search(shell)).toMatchObject({ panel: 'run', run: ids[1] });
  expect(shell.history.length).toBe(entries);
});

it('진행 중인 실행의 탭이 열려 있다 → 그 탭의 아이콘 자리에 실행의 상태 표시가 있고, 접근 이름은 "실행 #1"이며 상태는 탭의 설명이다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'run', runId }], `run:${runId}`);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() =>
    Boolean(tabNamed(W.runNumber(1))?.querySelector('[data-slot="tabs-closable-mark"]')),
  );
  const tab = tabNamed(W.runNumber(1));
  expect(tab?.querySelector('[data-slot="tabs-closable-mark"] [data-presence]')).not.toBeNull();
  expect(tab?.getAttribute('aria-description')).toBe(messages.Presence.state.working);
});

it('세션 패널이 넓힘이고 지난 실행 #1의 탭이 선택돼 있으며 실행 #2가 진행 중이다 → 실행 #2의 탭이 탭 줄에 있으면 "현재 실행 보기" 줄이 없고, 그 탭을 닫으면 그 줄이 선다', async () => {
  const world = await createShellWorld();
  const first = await world.startRun();
  await world.releaseReplies();
  await world.runReaches(first, ['succeeded']);
  const second = await world.startRun();
  await world.working(second, 1);
  remember(
    world.sessionId,
    [
      { kind: 'run', runId: first },
      { kind: 'run', runId: second },
    ],
    `run:${first}`,
  );
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  await press(maximizeButton());
  await until(() => presentation() === 'maximized');
  await until(() => Boolean(runHeader()));
  const line = () => side()?.querySelector('[data-testid="run-active-elsewhere"]') ?? null;
  expect(line()).toBeNull();

  const closeSecond = [
    ...(side()?.querySelectorAll<HTMLElement>('[data-slot="tabs-closable-close"]') ?? []),
  ].find((control) => control.getAttribute('data-tab-id') === `run:${second}`);
  await press(closeSecond);
  await until(() => Boolean(line()));
  expect(tabNames()).toEqual([W.runNumber(1)]);
  expect(line()).not.toBeNull();
});

it('변경이 있는 실행의 대화에서 활동 바의 변경 칩으로 패널을 연다 → 변경 탭이 보이는 동안 칩은 없다 → 패널을 닫으면 포커스는 패널 여닫기 버튼으로 간다', async () => {
  const { world } = await quietRun({ folder: true });
  // The run changed one file of the conversation's copy.
  const workspaces = giveCopy(world);
  workspaces.changes = async () => ({
    files: [{ path: 'notes.md', status: 'modified', additions: 1, deletions: 0 }],
    unavailable: false,
  });
  await open(world, `/sessions/${world.sessionId}`);
  const chip = () =>
    composer()?.querySelector<HTMLElement>('[data-testid="run-changes-chip"]') ?? null;
  await until(() => Boolean(chip()));
  expect(chip()).not.toBeNull();

  await press(chip());
  await until(() => selectedName() === W.changes);
  expect(presentation()).toBe('beside');
  await until(() => !chip());
  expect(chip()).toBeNull();

  await key(document.activeElement ?? document.body, TOGGLE_KEY);
  await until(() => presentation() === 'closed');
  expect(presentation()).toBe('closed');
  expect(document.activeElement).toBe(toggleButton());
  // Closed, the changes tab is not on screen: the chip is back.
  await until(() => Boolean(chip()));
  expect(chip()).not.toBeNull();
});

it('자리가 없어 변경 탭이 선택된 패널이 물러남이다 → 변경 탭이 화면에 없으니 활동 바의 변경 칩이 있다', async () => {
  const { world } = await quietRun({ folder: true });
  const workspaces = giveCopy(world);
  workspaces.changes = async () => ({
    files: [{ path: 'notes.md', status: 'modified', additions: 1, deletions: 0 }],
    unavailable: false,
  });
  const shell = await open(world, `/sessions/${world.sessionId}?panel=changes`, NARROW);
  expect(presentation()).toBe('withdrawn');
  expect(search(shell).panel).toBe('changes');
  const chip = () =>
    composer()?.querySelector<HTMLElement>('[data-testid="run-changes-chip"]') ?? null;
  await until(() => Boolean(chip()));
  expect(chip()).not.toBeNull();
  expect(presentation()).toBe('withdrawn');
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

  expect(document.querySelector('[data-testid="run-monitor"]')).toBeNull();

  await press(tabNamed(W.runNumber(1)));
  await until(() => Boolean(runRecord()));
  expect(runRecord()).not.toBeNull();
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

/** The conversation has a copy of its folder (a Paddock) in the folder-only world. */
function giveCopy(world: ShellWorld) {
  const workspaces = world.services.workspaces as unknown as Record<string, unknown>;
  workspaces.worktree = async () => ({
    sessionId: world.sessionId,
    bindingId: 'binding',
    copyGeneration: 1,
    baseCommit: 'base',
    createdAt: '2026-11-17T00:00:00Z',
    removedAt: null,
    reviewed: false,
    missing: false,
  });
  return workspaces;
}

async function followGit(shell: MountedShell, world: ShellWorld) {
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'git' } as never,
    });
  });
  await settle();
  await until(() => selectedName() === W.changes && changesView() === messages.Git.title);
}

it('폴더가 연결된 대화에서 이 대화 안의 링크가 panel=git을 가리킨다 → 변경 탭이 열리고 Git 보기가 앞에 있으며 주소는 panel=git이다; 커밋할 것이 없으면 포커스는 변경 탭에 있다', async () => {
  const world = await createShellWorld({ folder: true });
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await followGit(shell, world);

  expect(changesView()).toBe(messages.Git.title);
  expect(search(shell).panel).toBe('git');
  await until(() => document.activeElement === tabNamed(W.changes));
  expect(document.activeElement).toBe(tabNamed(W.changes));
});

it('폴더가 연결되고 스테이징한 것이 있는 대화에서 이 대화 안의 링크가 panel=git을 가리킨다 → 포커스는 커밋 메시지 입력에 있다', async () => {
  gitStaged.on = true;
  const world = await createShellWorld({ folder: true });
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await followGit(shell, world);

  const commit = () => document.getElementById('git-commit-message');
  await until(() => Boolean(commit()) && document.activeElement === commit());
  expect(document.activeElement).toBe(commit());
});

it('폴더가 연결된 대화의 변경 탭에서 Git 보기를 손으로 고른다 → 주소는 panel=git이다', async () => {
  const world = await createShellWorld({ folder: true });
  remember(world.sessionId, [{ kind: 'changes' }], 'changes');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => Boolean(changesViewTab(messages.Git.title)));

  await press(changesViewTab(messages.Git.title));
  await until(() => search(shell).panel === 'git');

  expect(search(shell).panel).toBe('git');
  expect(changesView()).toBe(messages.Git.title);
});

it('폴더가 연결되고 파일 · 변경 탭이 열려 있으며 변경 탭이 검사를 보인다 → 변경 탭을 닫고 "+"로 다시 연다 → 다시 연 변경 탭은 처음부터 검토를 보이고 검사를 거치지 않는다', async () => {
  const world = await createShellWorld({ folder: true });
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'changes' }], 'changes');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => Boolean(changesViewTab(messages.Checks.title)));
  await press(changesViewTab(messages.Checks.title));
  await until(() => search(shell).panel === 'checks');
  await act(async () => tabNamed(W.changes)?.focus());
  await key(document.activeElement as HTMLElement, { key: 'Delete' });
  expect(tabNames()).toEqual([W.files]);

  const seen: (string | null)[] = [];
  const watch = new MutationObserver(() => seen.push(changesView()));
  watch.observe(document.body, { subtree: true, childList: true, attributes: true });
  cleanups.push(() => watch.disconnect());
  await press(buttons(W.add, side())[0]);
  await until(() => document.querySelectorAll('[role="menuitem"]').length > 0);
  await press(
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => readText(item) === W.changes,
    ),
  );
  await until(() => selectedName() === W.changes && changesView() !== null);
  await settle();
  watch.disconnect();

  expect(changesView()).toBe(messages.Review.tabReview);
  expect(seen.filter((view) => view === messages.Checks.title)).toEqual([]);
});

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

// --- shell integration, stage 2 ----------------------------------------------------------------

const pathname = (shell: MountedShell) => shell.router.state.location.pathname;

/** Every address the history reaches from now on, as path and search. */
function addressesReached(shell: MountedShell): string[] {
  const reached: string[] = [];
  const history = shell.history as unknown as {
    subscribe(
      listener: (args: { location: { pathname: string; search: string } }) => void,
    ): () => void;
  };
  cleanups.push(
    history.subscribe(({ location }) => {
      reached.push(`${location.pathname}${location.search}`);
    }),
  );
  return reached;
}
/** The conversation's first message (the request that started its first run). */
async function firstEntry(world: ShellWorld) {
  const session = await world.services.repository.getSession(world.sessionId);
  const entry = session?.entries[0]?.entryId;
  if (!entry) throw new Error('no entry');
  return entry;
}
/** The conversation's row the address placed it at, marked as the current location. */
const linkedRow = () => main()?.querySelector<HTMLElement>('[aria-current="location"]') ?? null;
/** A conversation address the frame may leave: exactly one of `panel` and `compose`. */
const framed = (href: string) => {
  const params = new URL(href, 'http://x').searchParams;
  return params.has('panel') !== params.has('compose');
};

it('다른 화면에서 대화에 속한 실행의 `/runs/:runId`로 간다 → 그 대화의 실행 #1 탭이 옆으로 열려 선택되고, 주소는 그 실행과 보기를 가지며 기록은 하나만 쌓인다', async () => {
  const { world, runId } = await quietRun();
  const shell = await open(world, '/projects');
  const before = shell.history.length;
  await act(async () => {
    void shell.router.navigate({
      to: '/runs/$runId',
      params: { runId },
      search: { view: 'results' },
    });
  });
  await settle();
  await until(() => selectedName() === W.runNumber(1));

  expect(pathname(shell)).toBe(`/sessions/${world.sessionId}`);
  expect(selectedName()).toBe(W.runNumber(1));
  expect(presentation()).toBe('beside');
  expect(search(shell)).toMatchObject({ panel: 'run', run: runId, view: 'results' });
  expect(shell.history.length).toBe(before + 1);
});

it('대화에 속한 실행의 `/runs/:runId` 주소로 앱을 연다 → 그 대화의 실행 #1 탭이 주소대로 옆에 열려 선택된다', async () => {
  const { world, runId } = await quietRun();
  const shell = await open(world, `/runs/${runId}`);
  await until(() => selectedName() === W.runNumber(1));

  expect(pathname(shell)).toBe(`/sessions/${world.sessionId}`);
  expect(selectedName()).toBe(W.runNumber(1));
  expect(presentation()).toBe('beside');
  expect(search(shell)).toMatchObject({ panel: 'run', run: runId });
});

it('폴더가 연결된 대화의 검토 주소(`/sessions/:id/review`)로 다른 화면에서 간다 → 변경 탭이 열려 검토를 보이고 주소는 검토다', async () => {
  const world = await createShellWorld({ folder: true });
  const shell = await open(world, '/projects');
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId/review',
      params: { sessionId: world.sessionId },
    });
  });
  await settle();
  await until(() => selectedName() === W.changes);

  expect(pathname(shell)).toBe(`/sessions/${world.sessionId}`);
  expect(selectedName()).toBe(W.changes);
  expect(presentation()).toBe('beside');
  expect(search(shell)).toMatchObject({ panel: 'changes', review: true });
  await until(() => changesView() === messages.Review.tabReview);
  expect(changesView()).toBe(messages.Review.tabReview);
});

it('대화의 기억은 실행 #1 탭이 있는 열린 패널이다 → 다른 화면에서 advice 주소로 들어온다 → 패널은 기억대로이고, 주소는 그 탭의 panel만 가지며 advice는 쓰고 버려져 기록은 쌓이지 않는다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'run', runId }], `run:${runId}`);
  const shell = await open(world, `/projects/${world.projectId}`);
  const before = shell.history.length;
  // The run list has not answered: nothing after the arrival writes the address again.
  const release = world.holdListings();
  cleanups.push(release);
  const reached = addressesReached(shell);
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { advice: runId } as never,
    });
  });
  await settle();
  await until(() => selectedName() === W.runNumber(1));
  await settle();
  // Every address the arrival left on the way has exactly one of panel and compose.
  expect(reached.slice(1).filter((href) => !framed(href))).toEqual([]);

  expect(presentation()).toBe('beside');
  expect(search(shell)).toEqual({ panel: 'run', run: runId });
  expect(shell.history.length).toBe(before + 1);
  // Back leaves the conversation; it never arrives at the advice again.
  await back(shell);
  expect(pathname(shell)).toBe(`/projects/${world.projectId}`);
});

it('대화 안에서 파일 탭이 선택된 패널이 넓힘이다 → 이 대화의 advice 링크를 따라간다 → 넓히기가 풀리고 탭과 선택은 그대로이며, 주소는 panel=files이고 advice는 버려진다', async () => {
  // No run listing comes after it to write the address again.
  const world = await createShellWorld({ folder: true });
  const runId = 'run_elsewhere';
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  await press(maximizeButton());
  expect(presentation()).toBe('maximized');
  const reached = addressesReached(shell);

  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { advice: runId } as never,
    });
  });
  await settle();
  await until(() => presentation() === 'beside');
  await settle();
  expect(reached.slice(1).filter((href) => !framed(href))).toEqual([]);

  expect(presentation()).toBe('beside');
  expect(tabNames()).toEqual([W.files]);
  expect(selectedName()).toBe(W.files);
  expect(search(shell)).toEqual({ panel: 'files' });
});

it.each([
  ['대화 안에서', false],
  ['다른 화면에서', true],
] as const)(
  '%s 이 대화의 advice 링크를 따라간다 → 그 실행의 행에 조언에 온 것이 한 번 전해지고, 주소에는 advice가 없다',
  async (_where, fromOutside) => {
    const world = await createShellWorld({ folder: true });
    const runId = 'run_with_advice';
    const shell = await open(
      world,
      fromOutside ? `/projects/${world.projectId}` : `/sessions/${world.sessionId}`,
    );
    await act(async () => {
      void shell.router.navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: world.sessionId },
        search: { advice: runId } as never,
      });
    });
    await settle();
    await until(() => search(shell).advice === undefined && adviceArrivals.seen.size > 0);

    expect([...adviceArrivals.seen].map((seen) => seen.split(':')[0])).toEqual([runId]);
    expect(search(shell).advice).toBeUndefined();
  },
);

it('대화 A 안에서 파일 탭이 선택된 패널이 넓힘이다 → 메시지 검색 결과에서 대화 A의 메시지를 고른다 → 넓히기가 풀리고 탭과 선택은 그대로이며, 대화는 그 메시지에 있고 그 메시지가 강조되며 주소는 panel=files와 그 message를 갖는다', async () => {
  const { world } = await quietRun({ folder: true });
  const entry = await firstEntry(world);
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  await press(maximizeButton());

  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { message: entry } as never,
    });
  });
  await settle();
  await until(() => presentation() === 'beside');

  expect(presentation()).toBe('beside');
  expect(tabNames()).toEqual([W.files]);
  expect(search(shell)).toEqual({ panel: 'files', message: entry });
  await until(() => Boolean(linkedRow()));
  expect(linkedRow()?.getAttribute('data-chat-item')).toBe(entry);
});

it('다른 화면에 있고 대화 A의 기억은 파일 탭이 있는 열린 패널이다 → 검색 결과에서 message 주소로 대화 A에 들어온다 → 파일 탭이 있는 패널이 되살아나고, 대화는 그 메시지에 있으며 주소는 panel=files와 그 message를 갖는다', async () => {
  const { world } = await quietRun({ folder: true });
  const entry = await firstEntry(world);
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  const shell = await open(world, `/projects/${world.projectId}`);
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { message: entry } as never,
    });
  });
  await settle();
  await until(() => selectedName() === W.files);

  expect(presentation()).toBe('beside');
  expect(search(shell)).toEqual({ panel: 'files', message: entry });
  await until(() => Boolean(linkedRow()));
  expect(linkedRow()?.getAttribute('data-chat-item')).toBe(entry);
});

it.each([
  ['다른 화면에서', true],
  ['대화 안에서', false],
] as const)(
  '패널이 닫힘이고 탭이 없는 대화에 %s advice 주소로 간다 → 주소는 compose만 가지고 advice는 쓰고 버려진다',
  async (_where, fromOutside) => {
    // No run listing comes after it to write the address again.
    const world = await createShellWorld();
    const runId = 'run_elsewhere';
    const shell = await open(
      world,
      fromOutside ? `/projects/${world.projectId}` : `/sessions/${world.sessionId}`,
    );
    const reached = addressesReached(shell);
    await act(async () => {
      void shell.router.navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: world.sessionId },
        search: { advice: runId } as never,
      });
    });
    await settle();
    await until(
      () => search(shell).advice === undefined && pathname(shell).startsWith('/sessions'),
    );
    await settle();
    expect(reached.slice(1).filter((href) => !framed(href))).toEqual([]);

    expect(presentation()).toBe('closed');
    expect(search(shell)).toEqual({ compose: true });
  },
);

/** Whether the run tab of `runId`, selected or not, shows its results view. */
const runTabShowsResults = (runId: string) => {
  const panel = document.getElementById(`session-panel-panel-run:${runId}`);
  const pane = panel?.querySelector<HTMLElement>('[data-testid="run-document"]');
  return Boolean(pane && !pane.hidden);
};

it('파일 · 실행 #1 탭이 열려 있다 → 이 대화의 링크가 실행 #1 탭을 결과 보기로 연 뒤 파일 탭을 고른다 → 가려진 실행 #1 탭은 결과 보기를 지키고, 다시 고르면 그대로다', async () => {
  const { world, runId } = await quietRun({ folder: true });
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'run', runId }], 'files');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'run', run: runId, view: 'results' } as never,
    });
  });
  await settle();
  await until(() => runTabShowsResults(runId));
  expect(runTabShowsResults(runId)).toBe(true);

  await press(tabNamed(W.files));
  expect(search(shell).panel).toBe('files');
  // Hidden, it keeps what the link gave it.
  expect(runTabShowsResults(runId)).toBe(true);

  await press(tabNamed(W.runNumber(1)));
  expect(runTabShowsResults(runId)).toBe(true);
  expect(search(shell)).toMatchObject({ panel: 'run', run: runId, view: 'results' });
});

it('파일 · 실행 #1 탭에서 실행 #1이 결과 보기다 → 파일 탭을 고르고 뒤로 가기로 실행 #1 탭이 실행 보기였던 기록으로 간다 → 실행 #1 탭은 주소가 준 실행 보기를 보인다', async () => {
  const { world, runId } = await quietRun({ folder: true });
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'run', runId }], 'files');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  for (const view of ['run', 'results'] as const) {
    await act(async () => {
      void shell.router.navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: world.sessionId },
        search: { panel: 'run', run: runId, view } as never,
      });
    });
    await settle();
  }
  await until(() => runTabShowsResults(runId));
  await press(tabNamed(W.files));

  // Back to the entry where the link showed the run view: the run tab is selected with it.
  await back(shell);
  await until(() => selectedName() === W.runNumber(1));
  expect(search(shell)).toMatchObject({ panel: 'run', run: runId, view: 'run' });
  expect(runTabShowsResults(runId)).toBe(false);
});

it('폴더가 연결되고 변경 · 파일 탭이 열려 있다 → 이 대화의 링크가 변경 탭의 검토를 연 뒤 파일 탭을 고른다 → 가려진 변경 탭은 검토를 지킨다', async () => {
  const world = await createShellWorld({ folder: true });
  remember(world.sessionId, [{ kind: 'changes' }, { kind: 'files' }], 'files');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'changes', review: true, scope: 'session' } as never,
    });
  });
  await settle();
  await until(() => changesView() === messages.Review.tabReview);

  await press(tabNamed(W.files));
  expect(search(shell).panel).toBe('files');
  expect(changesView()).toBe(messages.Review.tabReview);
});

it('패널이 옆이고 실행 단위 둘이 일하는 실행 #1에 대해 컴포저가 전체 중지 확인을 묻고 있다 → 명령 팔레트의 단축키와 패널 여닫기 단축키를 누른다 → 아무것도 열리거나 바뀌지 않고, Escape로 확인을 닫은 뒤에는 둘 다 동작한다', async () => {
  const { world } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  expect(presentation()).toBe('beside');
  await until(() => Boolean(composerStop() && operable(composerStop() as HTMLElement)));
  await press(composerStop());
  await until(composerAsks);
  const palette = () =>
    document.querySelector<HTMLInputElement>(
      `input[role="combobox"][aria-label="${messages.CommandPalette.search}"]`,
    );

  // Global shortcuts are held back while the confirmation is up, the palette's own included.
  await key(document.activeElement ?? window, { key: 'k', ctrlKey: true });
  expect(palette()).toBeNull();
  await key(document.activeElement ?? window, TOGGLE_KEY);
  expect(presentation()).toBe('beside');
  expect(tabNames()).toEqual([W.runNumber(1)]);
  expect(composerAsks()).toBe(true);

  // Escape still reaches the dialog; once it is gone both shortcuts work again.
  await key(document.activeElement ?? window, { key: 'Escape' });
  await until(() => !composerAsks());
  expect(cancels(world)).toEqual([]);
  await key(document.activeElement ?? window, { key: 'k', ctrlKey: true });
  await until(() => Boolean(palette()));
  await key(palette() as HTMLInputElement, { key: 'Escape' });
  await until(() => !palette());
  await key(document.activeElement ?? window, TOGGLE_KEY);
  await until(() => presentation() === 'closed');
});

it('실행 단위 둘이 일하는 실행 #1에 대해 컴포저가 전체 중지 확인을 묻고 있다 → 뒤로 · 앞으로 가기를 단축키로도 데스크톱 메뉴로도 부른다 → 기록은 움직이지 않고, 확인을 닫은 뒤에는 둘 다 움직인다', async () => {
  desktopShell.commands = [];
  const { world } = await busyRun();
  await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await until(() => Boolean(composerStop() && operable(composerStop() as HTMLElement)));
  await press(composerStop());
  await until(composerAsks);
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const forward = vi.spyOn(window.history, 'forward').mockImplementation(() => {});
  const menu = async (id: string) =>
    act(async () => {
      for (const listener of [...(desktopShell.commands ?? [])]) listener(id);
    });
  expect(desktopShell.commands?.length).toBeGreaterThan(0);

  await key(document.activeElement ?? window, { key: '[', ctrlKey: true });
  await key(document.activeElement ?? window, { key: ']', ctrlKey: true });
  await menu('nav.back');
  await menu('nav.forward');
  expect(back).not.toHaveBeenCalled();
  expect(forward).not.toHaveBeenCalled();
  expect(composerAsks()).toBe(true);

  await key(document.activeElement ?? window, { key: 'Escape' });
  await until(() => !composerAsks());
  await act(async () => (document.activeElement as HTMLElement | null)?.blur());
  await key(document.body, { key: '[', ctrlKey: true });
  await key(document.body, { key: ']', ctrlKey: true });
  expect(back).toHaveBeenCalledTimes(1);
  expect(forward).toHaveBeenCalledTimes(1);
  await menu('nav.back');
  await menu('nav.forward');
  expect(back).toHaveBeenCalledTimes(2);
  expect(forward).toHaveBeenCalledTimes(2);
});

it('컴포저가 전체 중지 확인을 묻는 채로 다른 대화로 간다 → 확인은 사라지고, 붙잡힌 것이 남지 않아 명령 팔레트 단축키가 동작한다', async () => {
  const { world } = await busyRun();
  const other = await world.createConversation('Other');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await until(() => Boolean(composerStop() && operable(composerStop() as HTMLElement)));
  await press(composerStop());
  await until(composerAsks);
  const palette = () =>
    document.querySelector<HTMLInputElement>(
      `input[role="combobox"][aria-label="${messages.CommandPalette.search}"]`,
    );

  await act(async () => {
    void shell.router.navigate({ to: '/sessions/$sessionId', params: { sessionId: other } });
  });
  await until(() => pathname(shell) === `/sessions/${other}`);
  await settle();
  expect(composerAsks()).toBe(false);

  await key(document.activeElement ?? window, { key: 'k', ctrlKey: true });
  await until(() => Boolean(palette()));
  expect(palette()).not.toBeNull();
});

it('파일 · 실행 #1 탭이 옆에 있고 컴포저가 전체 중지 확인을 묻고 있다 → 단축키가 아닌 길로 패널의 조작(여닫기 버튼, 파일 탭)에 닿는다 → 패널은 바뀌지 않는다', async () => {
  const { world } = await busyRun();
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  await openRunTab();
  await until(() => Boolean(composerStop() && operable(composerStop() as HTMLElement)));
  await press(composerStop());
  await until(composerAsks);

  // The dialog takes the screen's other controls; reached anyway, they change nothing.
  await press(tabNamed(W.files));
  expect(selectedName()).toBe(W.runNumber(1));
  await press(toggleButton());
  expect(presentation()).toBe('beside');
  expect(composerAsks()).toBe(true);
});

it('대화 A의 기억은 파일 탭이 있는 열린 패널이다 → 다른 화면에서 settings만 실은 주소로 대화 A에 들어온다 → 되살린 주소는 settings와 panel=files를 함께 갖는다', async () => {
  const world = await createShellWorld({ folder: true });
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  const shell = await open(world, `/projects/${world.projectId}`);
  const reached = addressesReached(shell);
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { settings: 'shortcuts' } as never,
    });
  });
  await settle();
  await until(() => selectedName() === W.files && search(shell).panel === 'files');

  // Before the frame wrote: the address carried the settings it does not read.
  expect(new URLSearchParams(reached[0]?.split('?')[1]).get('settings')).toBe('shortcuts');
  expect(search(shell)).toMatchObject({ settings: 'shortcuts', panel: 'files' });
});

it('설정 대화상자가 열린 채 실행 #1 탭이 옆에 있다 → 패널 여닫기로 틀이 주소를 쓴다 → 설정은 주소에 남고 대화상자는 열려 있다', async () => {
  const { world } = await quietRun();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: ((previous: Record<string, unknown>) => ({
        ...previous,
        settings: 'shortcuts',
      })) as never,
    });
  });
  await settle();
  await until(() => Boolean(document.querySelector('[data-settings-dialog]')));
  expect(search(shell).settings).toBe('shortcuts');

  await press(toggleButton());
  await until(() => search(shell).compose === true);

  expect(search(shell)).toMatchObject({ settings: 'shortcuts', compose: true });
  expect(document.querySelector('[data-settings-dialog]')).not.toBeNull();
});

it('저장하지 않은 바뀐 값이 있는 설정 대화상자가 열린 채 실행 #1 탭이 옆에 있다 → 패널 여닫기로 틀이 주소를 쓴다 → 떠날지 묻지 않고, 대화상자는 열려 있으며 주소는 패널을 말한다', async () => {
  unsavedSettings.dirty = true;
  const { world } = await quietRun();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: ((previous: Record<string, unknown>) => ({
        ...previous,
        settings: 'general',
      })) as never,
    });
  });
  await settle();
  await until(() => Boolean(document.querySelector('[data-testid="settings-form"]')));

  await press(toggleButton());
  await settle();

  expect(document.querySelector('[data-settings-guard]')).toBeNull();
  expect(document.querySelector('[data-settings-dialog]')).not.toBeNull();
  expect(presentation()).toBe('closed');
  await until(() => search(shell).compose === true);
  expect(search(shell)).toMatchObject({ settings: 'general', compose: true });
});

it('실행 #1 탭이 옆에 있다 → 주소 쓰기가 한 번 막힌 채 패널을 닫았다가 열고, 막힘이 풀린 뒤 다시 닫는다 → 주소는 compose다', async () => {
  const { world } = await quietRun();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  expect(presentation()).toBe('beside');
  // As a settings dialog with unsaved changes does when the person stays: the write is refused.
  const history = shell.history as unknown as {
    block(blocker: { blockerFn: () => boolean }): () => void;
  };
  const unblock = history.block({ blockerFn: () => true });
  await press(toggleButton());
  expect(presentation()).toBe('closed');
  unblock();
  await press(toggleButton());
  expect(presentation()).toBe('beside');

  await press(toggleButton());

  expect(presentation()).toBe('closed');
  await until(() => search(shell).compose === true);
  expect(search(shell)).toEqual({ compose: true });
});

it('대화 A에서 앱 안의 panel=terminal 링크를 따라갔고 터미널 화면이 아직 붙지 않았다 → 대화 B로 간다 → 그 기다림은 끝나서 남은 타이머가 없고, 포커스를 가져가지 않는다', async () => {
  // The waits a way leaves for a place inside a tab, watched by the step that makes them.
  const live = new Set<unknown>();
  const realSet = window.setTimeout.bind(window);
  const realClear = window.clearTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (typeof handler !== 'function' || handler.name !== 'attempt')
      return realSet(handler, delay, ...rest);
    const id: number = realSet(() => {
      live.delete(id);
      (handler as () => void)();
    }, delay);
    live.add(id);
    return id;
  }) as typeof window.setTimeout);
  vi.spyOn(window, 'clearTimeout').mockImplementation(((id?: number) => {
    live.delete(id);
    realClear(id);
  }) as typeof window.clearTimeout);
  const world = await createShellWorld({ server: true, folder: true });
  const other = await world.createConversation('Other');
  remember(other, [{ kind: 'files' }], 'files');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  terminalScreen.attached = false;
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'terminal' } as never,
    });
  });
  await until(() => Boolean(side()?.querySelector('[data-testid="terminal-leaf"]')));
  expect(live.size).toBe(1);

  await act(async () => {
    void shell.router.navigate({ to: '/sessions/$sessionId', params: { sessionId: other } });
  });
  await settle();
  await until(() => pathname(shell) === `/sessions/${other}`);

  expect(live.size).toBe(0);
  expect(document.activeElement?.closest('[data-testid="terminal-leaf"]') ?? null).toBeNull();
});

it('패널이 닫힌 대화 A에서 빠른 열기로 문서를 고르고 그 문서가 열리기 전에 파일 탭이 있는 대화 B로 간다 → 빠른 열기는 대화가 바뀐 뒤에 열린 문서를 버려, 그 문서는 B의 파일 탭에 열리지 않는다', async () => {
  const world = await createShellWorld({ server: true, folder: true });
  const server = world.server as NonNullable<ShellWorld['server']>;
  const other = await world.createConversation('Other');
  remember(other, [{ kind: 'files' }], 'files');
  // Opening the document waits until the test lets it go.
  const realOpen = server.documents.open.bind(server.documents);
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(server.documents, 'open').mockImplementation(async (...args) => {
    await opened;
    return realOpen(...args);
  });
  const shell = await open(world, `/sessions/${world.sessionId}`);
  expect(tabNames()).toEqual([]);
  await act(async () => {
    window.dispatchEvent(new Event('corral:quick-open'));
  });
  await settle();
  const option = () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes(server.path),
    );
  await until(() => Boolean(option()));
  await act(async () => option()?.click());

  await act(async () => {
    void shell.router.navigate({ to: '/sessions/$sessionId', params: { sessionId: other } });
  });
  await until(() => pathname(shell) === `/sessions/${other}`);
  await until(() => selectedName() === W.files);
  await settle();
  // A's document is ready only now, with B's dock on screen.
  await act(async () => release());
  await settle();

  expect(side()?.querySelector('[data-testid="document-leaf"]') ?? null).toBeNull();
});

it('실행 #1 탭이 옆에 있고 포커스가 그 탭에 있다 → 창이 좁아져 패널이 물러난다 → 포커스는 대화의 입력란으로 간다', async () => {
  const { world } = await quietRun();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  expect(document.activeElement).toBe(tabNamed(W.runNumber(1)));

  await shell.setWidth(NARROW);

  expect(presentation()).toBe('withdrawn');
  expect(document.activeElement).toBe(
    document.querySelector('[data-testid="chat-composer"] textarea'),
  );
});

it('대화 A 안에서 파일 탭이 선택된 패널이 넓힘이다 → 이 대화의 메시지 링크를 따라간다 → 포커스는 그 메시지에 있다', async () => {
  const { world } = await quietRun({ folder: true });
  const entry = await firstEntry(world);
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  await press(maximizeButton());

  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { message: entry } as never,
    });
  });
  await settle();
  await until(() => Boolean(linkedRow()) && document.activeElement === linkedRow());

  expect(presentation()).toBe('beside');
  expect(document.activeElement).toBe(linkedRow());
});

/** The run tab's instruction field for the execution the address names, opened from its side. */
async function instructionField(shell: MountedShell, world: ShellWorld, runId: string) {
  const { projection } = await world.transport.getSnapshot(runId);
  const execution = Object.values(projection.executions)[0] as { executionId: string };
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'run', run: runId, execution: execution.executionId } as never,
    });
  });
  await settle();
  const give = () => buttons(messages.Run.steerThis, side())[0];
  await until(() => Boolean(give()));
  await press(give());
  const field = () =>
    side()?.querySelector<HTMLTextAreaElement>('[data-testid="run-instructions"] textarea') ?? null;
  await until(() => Boolean(field()));
  return field() as HTMLTextAreaElement;
}

it('실행 #1 탭에서 지시를 쓰다 만다 → 탭을 닫고 다시 연다 → 그 지시가 있다; 다른 대화로 가면 없고, 돌아오면 있다', async () => {
  const { world, runId } = await quietRun();
  const other = await world.createConversation('Other');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  const typed = 'Keep the second section short.';
  const field = await instructionField(shell, world, runId);
  await act(async () => {
    field.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(field, typed);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  expect(field.value).toBe(typed);
  const holding = () =>
    [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].some(
      (area) => area.value === typed,
    );

  await key(tabNamed(W.runNumber(1)) as HTMLElement, { key: 'Delete' });
  expect(tabNames()).toEqual([]);
  expect(holding()).toBe(false);
  await openRunTab();
  expect((await instructionField(shell, world, runId)).value).toBe(typed);

  await act(async () => {
    void shell.router.navigate({ to: '/sessions/$sessionId', params: { sessionId: other } });
  });
  await until(() => pathname(shell) === `/sessions/${other}`);
  await settle();
  expect(holding()).toBe(false);

  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
    });
  });
  await until(() => pathname(shell) === `/sessions/${world.sessionId}`);
  await settle();
  expect((await instructionField(shell, world, runId)).value).toBe(typed);
});

const composerInput = () =>
  document.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer"] textarea');

it.each([
  ['응답하기를 실은 panel=run 링크', 'respond'],
  ['실행이 없는 대화의 panel=run 링크', 'no-run'],
] as const)(
  '파일 탭이 선택돼 있고 포커스가 입력란에 있다 → %s를 따라간다 → 아무 탭도 열리거나 골라지지 않고 포커스는 입력란에 남는다',
  async (_link, kind) => {
    const world =
      kind === 'respond'
        ? (await quietRun({ folder: true })).world
        : await createShellWorld({ folder: true });
    const runId = kind === 'respond' ? (await world.transport.listRuns())[0]?.runId : undefined;
    remember(world.sessionId, [{ kind: 'files' }], 'files');
    const shell = await open(world, `/sessions/${world.sessionId}`);
    await until(() => selectedName() === W.files);
    await act(async () => composerInput()?.focus());
    expect(document.activeElement).toBe(composerInput());

    await act(async () => {
      void shell.router.navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: world.sessionId },
        search: (kind === 'respond'
          ? { panel: 'run', run: runId, respond: true }
          : { panel: 'run' }) as never,
      });
    });
    await settle();
    await until(() => search(shell).panel === 'files');

    expect(selectedName()).toBe(W.files);
    expect(document.activeElement).toBe(composerInput());
  },
);

it('실행이 없는 대화에서 파일 탭이 선택돼 있고 포커스가 입력란에 있다 → 실행 탭을 여는 길(open, 실행 없음)을 부른다 → 포커스는 입력란에 남는다', async () => {
  const world = await createShellWorld({ folder: true });
  remember(world.sessionId, [{ kind: 'files' }], 'files');
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.files);
  await act(async () => composerInput()?.focus());

  // The command way to the run tab, with no run in the conversation.
  const command = registeredCommands().find((entry) => entry.id === 'panel:run');
  expect(command).toBeDefined();
  await act(async () => {
    await command?.run();
  });
  await settle();

  expect(selectedName()).toBe(W.files);
  expect(document.activeElement).toBe(composerInput());
});

it('파일 · 변경 탭이 열려 있고 변경 탭이 선택돼 있으며 포커스가 입력란에 있다 → 설정만 바뀐 주소로 간다 → 포커스는 변경 탭으로 옮겨지지 않는다', async () => {
  const world = await createShellWorld({ folder: true });
  remember(world.sessionId, [{ kind: 'files' }, { kind: 'changes' }], 'changes');
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.changes);
  await until(() => search(shell).panel === 'changes');
  const shownSearch = { ...search(shell) };
  await act(async () => composerInput()?.focus());
  // The settings dialog takes the focus as it opens: the tab is watched for the focus instead.
  let tabFocused = 0;
  const watched = tabNamed(W.changes) as HTMLElement;
  const count = () => {
    tabFocused += 1;
  };
  watched.addEventListener('focus', count);

  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { ...shownSearch, settings: 'shortcuts' } as never,
    });
  });
  await settle();
  watched.removeEventListener('focus', count);
  expect(search(shell).settings).toBe('shortcuts');
  expect(tabFocused).toBe(0);
});

it('대화의 행에서 연 실행 #1 탭이 옆에 있다 → 패널 밖의 링크가 지금 주소 그대로를 가리키고 그것을 따라간다 → 포커스는 탭으로 가지 않고, 그 뒤 패널을 닫으면 포커스는 행의 조작으로 간다', async () => {
  const { world } = await quietRun();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await openRunTab();
  const opener = answerRunLink(1);
  // The entry shown is the frame's own write: following a link to it makes a new entry.
  expect(
    typeof (shell.router.state.location.state as unknown as Record<string, unknown>)
      .corralPanelWrite,
  ).toBe('string');
  const shownSearch = { ...search(shell) };
  const entries = shell.history.length;
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = 'Same address';
  main()?.append(link);
  cleanups.push(() => link.remove());
  await act(async () => link.focus());
  let tabFocused = 0;
  const watched = tabNamed(W.runNumber(1)) as HTMLElement;
  const count = () => {
    tabFocused += 1;
  };
  watched.addEventListener('focus', count);

  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: shownSearch as never,
    });
  });
  await settle();
  watched.removeEventListener('focus', count);
  expect(shell.history.length).toBe(entries + 1);
  expect(tabFocused).toBe(0);
  expect(document.activeElement).toBe(link);

  // The opener is still the row's control: closing with the focus inside goes back to it.
  await act(async () => watched.focus());
  await key(watched, TOGGLE_KEY);
  await until(() => presentation() === 'closed');
  expect(document.activeElement).toBe(opener);
});

it('실행 #1 탭을 대화의 행에서 열었다가 닫았다 → 패널 밖의 링크로 다시 연다 → 포커스가 패널 안에 있을 때 패널을 닫으면 포커스는 그 링크로 간다', async () => {
  const { world, runId } = await quietRun();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  // An earlier opening, from the answer row's control, still on screen afterwards.
  await openRunTab();
  await key(document.activeElement as HTMLElement, TOGGLE_KEY);
  await until(() => presentation() === 'closed');
  expect(document.activeElement).toBe(answerRunLink(1));

  // A link outside the panel that keeps the focus after it is followed. (The conversation's own
  // panel links, in a role's row or a branch, do not appear in this fixture's runs.)
  const link = document.createElement('a');
  link.href = `/sessions/${world.sessionId}?panel=run&run=${runId}`;
  link.textContent = 'Run link';
  main()?.append(link);
  cleanups.push(() => link.remove());
  await act(async () => link.focus());
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'run', run: runId } as never,
    });
  });
  await settle();
  await until(() => document.activeElement === tabNamed(W.runNumber(1)));

  await key(document.activeElement as HTMLElement, TOGGLE_KEY);
  await until(() => presentation() === 'closed');
  expect(document.activeElement).toBe(link);
});

it.each([['빠른 열기로 열었고 그 목록은 닫혀 사라졌다']] as const)(
  '파일 탭의 문서 안의 링크로 실행 #1 탭을 연다(패널은 %s) → 패널 안의 링크는 패널을 연 조작을 바꾸지 않아, 포커스가 패널 안에 있을 때 패널을 닫으면 포커스는 그 조작으로, 없으면 여닫기 버튼으로 간다',
  async () => {
    const world = await createShellWorld({ server: true, folder: true });
    const server = world.server as NonNullable<ShellWorld['server']>;
    const runId = await world.startRun();
    await world.working(runId, 1);
    documentLink.current = { sessionId: world.sessionId, search: { panel: 'run', run: runId } };
    await open(world, `/sessions/${world.sessionId}`);
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
    await until(() => Boolean(side()?.querySelector('[data-testid="document-link"]')));

    await press(side()?.querySelector<HTMLElement>('[data-testid="document-link"]'));
    await until(() => selectedName() === W.runNumber(1));
    await until(() => document.activeElement === tabNamed(W.runNumber(1)));
    await key(document.activeElement as HTMLElement, TOGGLE_KEY);
    await until(() => presentation() === 'closed');

    expect(document.activeElement).toBe(toggleButton());
  },
);

it('실행 #1 탭이 선택돼 있고 포커스가 입력란에 있다 → 그 실행에 응답하기를 실은 panel=run 링크를 따라간다 → 탭을 연 것이 아니어서 포커스는 탭으로 가지 않는다', async () => {
  const { world, runId } = await quietRun();
  remember(world.sessionId, [{ kind: 'run', runId }], `run:${runId}`);
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await until(() => selectedName() === W.runNumber(1));
  await act(async () => composerInput()?.focus());
  let tabFocused = 0;
  const watched = tabNamed(W.runNumber(1)) as HTMLElement;
  const count = () => {
    tabFocused += 1;
  };
  watched.addEventListener('focus', count);

  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'run', run: runId, respond: true } as never,
    });
  });
  await settle();
  watched.removeEventListener('focus', count);

  expect(selectedName()).toBe(W.runNumber(1));
  expect(tabFocused).toBe(0);
});

it.each([
  ['링크', 'link', 'composer'],
  ['링크', 'link', 'page'],
  ['링크', 'link', 'tab'],
  ['뒤로 가기', 'back', 'composer'],
  ['뒤로 가기', 'back', 'page'],
  ['뒤로 가기', 'back', 'tab'],
] as const)(
  '패널이 옆에 있는 대화에서 패널이 닫힌 채 되살아나는 다른 대화로 %s로 간다(%s, 포커스는 %s에) → 들어온 것은 패널을 닫은 것이 아니어서 포커스는 여닫기 버튼으로 가지 않는다',
  async (_how, how, where) => {
    const { world, runId } = await quietRun({ folder: true });
    const other = await world.createConversation('Other');
    // Both conversations have entries: the composer's own first focus does not stand in.
    await world.services.repository.addSessionEntry(other, {
      intent: 'next',
      text: 'Earlier request',
      state: 'refused',
      detail: 'Not now',
    });
    remember(other, [{ kind: 'changes' }], 'changes');
    remember(world.sessionId, [{ kind: 'run', runId }], `run:${runId}`, false);
    // Back: from the closed conversation to the open one first, then back.
    const shell = await open(world, `/sessions/${how === 'back' ? world.sessionId : other}`);
    if (how === 'back') await sidebarLink(shell, other);
    await until(() => selectedName() === W.changes);
    expect(presentation()).toBe('beside');
    if (where === 'composer') await act(async () => composerInput()?.focus());
    if (where === 'page') await act(async () => (document.activeElement as HTMLElement)?.blur());
    if (where === 'tab') await act(async () => tabNamed(W.changes)?.focus());

    if (how === 'back') await back(shell);
    else await sidebarLink(shell, world.sessionId);
    await until(() => pathname(shell) === `/sessions/${world.sessionId}`);
    await settle();

    expect(presentation()).toBe('closed');
    expect(document.activeElement).not.toBe(toggleButton());
  },
);
