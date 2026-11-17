// @vitest-environment jsdom
import type { TerminalView } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import type { TerminalStore } from './store.ts';
import { TerminalScreen } from './TerminalScreen.tsx';

// A terminal tab's screen (workbench.md 사용자 터미널): one terminal, no head row; its state is the
// tab's to say, ending it is closing the tab, and the rest is in the ⋯ menu before the screen.

vi.mock('./TerminalView.tsx', () => ({
  TerminalView: ({ onExit }: { onExit?: () => void }) => (
    <section data-testid="terminal-leaf" data-terminal-screen="">
      <textarea aria-label="terminal input" />
      <button type="button" onClick={onExit}>
        Leave terminal
      </button>
    </section>
  ),
}));

const T = messages.Terminals;
const target = {
  hostId: 'local',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const view = (over: Partial<TerminalView> = {}): TerminalView => ({
  terminalId: 'terminal',
  target,
  generation: 'generation',
  shellId: 'bash',
  state: 'running',
  initialCols: 80,
  initialRows: 24,
  cols: 80,
  rows: 24,
  lastSequence: 2,
  replayAvailable: true,
  controllerGeneration: 1,
  controller: null,
  exitCode: null,
  error: null,
  foreground: 'idle',
  ...over,
});
type Entry = ReturnType<TerminalStore['getState']>['terminals'][string];

function fakeStore(terminal: TerminalView, entry: Partial<Entry> = {}) {
  const state = {
    sessions: {
      session: {
        list: {
          target,
          available: true,
          reason: null,
          shells: [{ id: 'bash', label: 'Bash' }],
          terminals: [terminal],
        },
        loading: false,
        error: null,
        pendingCreate: null,
        canRetryCreate: false,
      },
    },
    terminals: {
      terminal: {
        terminal,
        connection: 'connected',
        controlling: false,
        inputUnknown: false,
        inputOverflow: false,
        rateLimited: false,
        error: null,
        busy: false,
        appliedSequence: 0,
        hasSelection: false,
        ...entry,
      },
    },
  } as unknown as ReturnType<TerminalStore['getState']>;
  return {
    getState: () => state,
    getInitialState: () => state,
    subscribe: () => () => {},
    refresh: vi.fn(async () => {}),
    claim: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    reconnect: vi.fn(async () => {}),
    checkInput: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    captureSelection: vi.fn(async () => null),
  } as unknown as TerminalStore & Record<string, ReturnType<typeof vi.fn>>;
}

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.getAnimations ??= () => [];
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(
  store: TerminalStore,
  props: Partial<Parameters<typeof TerminalScreen>[0]> = {},
) {
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
        <TerminalScreen
          store={store}
          sessionId="session"
          terminalId="terminal"
          move={{ to: 'dock', onMove: vi.fn() }}
          onExitToTab={vi.fn()}
          {...props}
        />
      </IntlProvider>,
    ),
  );
  return container;
}
const press = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};
const more = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(`button[aria-label="${T.actions}"]`);
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((row) => row.textContent);
const row = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.startsWith(name),
  );

it('has no head row: the ⋯ button comes first, then the screen, and there is no stop or state line', async () => {
  const container = await mount(fakeStore(view()));
  const focusable = [...container.querySelectorAll<HTMLElement>('button, textarea')];
  expect(focusable[0]).toBe(more(container));
  expect(focusable[1]?.getAttribute('aria-label')).toBe('terminal input');
  expect(container.textContent).not.toContain(T.stop);
  expect(container.textContent).not.toContain(T.state.running);
  expect(container.querySelector('[role="combobox"]')).toBeNull();
});

it('⋯ holds input control, attach selection, refresh and the move, named for where the tab goes', async () => {
  const store = fakeStore(view(), { hasSelection: true });
  const onMove = vi.fn();
  const container = await mount(store, { move: { to: 'panel', onMove }, onAttach: vi.fn() });
  await press(more(container));
  const expected = [T.claim, T.attachSelection, T.refresh, messages.Terminals.moveToPanel];
  expect(rows()).toHaveLength(expected.length);
  rows().forEach((text, index) => {
    expect(text).toContain(expected[index]);
  });
  await press(row(T.claim));
  expect(store.claim).toHaveBeenCalledWith('terminal', false);
  await press(more(container));
  await press(row(messages.Terminals.moveToPanel));
  expect(onMove).toHaveBeenCalledTimes(1);
});

it('says in ⋯ that releasing input does not free the Paddock, and offers take over when another view holds input', async () => {
  const store = fakeStore(
    view({ controller: { attachmentId: 'another', generation: 1, acceptedSequence: 0 } }),
  );
  const container = await mount(store, { move: { to: 'panel', onMove: vi.fn() } });
  await press(more(container));
  expect(row(T.takeover)?.textContent).toContain(T.releaseHint);
});

it('names the move to the bottom dock in the panel', async () => {
  const container = await mount(fakeStore(view()), { move: { to: 'dock', onMove: vi.fn() } });
  await press(more(container));
  expect(rows().some((text) => text?.includes(messages.Terminals.moveToDock))).toBe(true);
});

it('shows "연결이 끊겼습니다 · 다시 연결" only while the output connection is lost, never while detached', async () => {
  const lost = fakeStore(view(), { connection: 'disconnected' });
  const container = await mount(lost);
  const notice = container.querySelector('[data-terminal-disconnected]');
  expect(notice?.textContent).toContain(T.disconnected);
  await press(notice?.querySelector('button'));
  expect(lost.reconnect).toHaveBeenCalledWith('terminal');
  const detached = await mount(fakeStore(view(), { connection: 'idle' }));
  expect(detached.querySelector('[data-terminal-disconnected]')).toBeNull();
  expect(detached.textContent).not.toContain(T.reconnect);
});

it('an ended terminal says it ended and its exit code; a stopped one says so without the code', async () => {
  const ended = await mount(fakeStore(view({ state: 'exited', exitCode: 2 })));
  expect(ended.textContent).toContain(`${T.state.exited} · ${T.exitCode.replace('{code}', '2')}`);
  const stopped = await mount(fakeStore(view({ state: 'exited', exitCode: 0, stopped: true })));
  expect(stopped.textContent).toContain(T.stopped);
  expect(stopped.textContent).not.toContain(T.exitCode.replace('{code}', '0'));
});

it("Shift+Escape in the terminal goes to the terminal's tab", async () => {
  const onExitToTab = vi.fn();
  const container = await mount(fakeStore(view()), { onExitToTab });
  await press(
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Leave terminal'),
  );
  expect(onExitToTab).toHaveBeenCalledTimes(1);
});

it('keeps the recovery an unconfirmed end needs, told as closing the tab, with no stop button', async () => {
  const container = await mount(
    fakeStore(
      view({ state: 'uncertain', diagnostic: { phase: 'recovery', code: 'cleanup_unconfirmed' } }),
    ),
  );
  expect(container.textContent).toContain(T.diagnosticReason.cleanup_unconfirmed);
  expect(container.textContent).toContain(T.diagnosticCheck);
  expect(container.textContent).not.toContain(T.recheckTermination);
});

it('keeps the lost-input recovery and its two actions', async () => {
  const store = fakeStore(view(), { inputUnknown: true });
  const container = await mount(store);
  expect(container.textContent).toContain(T.inputUnknown);
  await press(
    [...container.querySelectorAll('button')].find((b) => b.textContent === T.checkInput),
  );
  expect(store.checkInput).toHaveBeenCalledWith('terminal');
  expect(
    [...container.querySelectorAll('button')].some((b) => b.textContent === T.restartInput),
  ).toBe(true);
});
