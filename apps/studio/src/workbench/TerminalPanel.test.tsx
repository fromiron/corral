// @vitest-environment jsdom
import assert from 'node:assert/strict';
import type { TerminalList, TerminalView } from '@corral/contracts';
import { Gate } from '@corral/testkit';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import koreanMessages from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { composerDraftRevision, writeComposerDraft } from './sessionDraft.ts';
import { TerminalActivity, TerminalPanel } from './TerminalPanel.tsx';
import type { TerminalSelection, TerminalStore } from './terminals/store.ts';

const fixture = vi.hoisted(() => ({
  state: {} as ReturnType<TerminalStore['getState']>,
  workspaceId: undefined as string | undefined,
  refresh: vi.fn(async (_id: string) => {}),
  stop: vi.fn(async (_id: string) => {}),
  captureSelection: vi.fn<(id: string) => Promise<TerminalSelection | null>>(),
  documents: null as null | Record<string, { target: { sessionId: string }; writerBusy?: boolean }>,
}));
vi.mock('../services.tsx', () => ({
  useServices: () => ({
    mode: 'server',
    terminals: {},
    workspaceId: fixture.workspaceId,
    workspaces: fixture.documents ? {} : undefined,
  }),
}));
vi.mock('./documents/store.ts', () => ({
  documentStore: () => ({
    getState: () => ({ documents: fixture.documents ?? {} }),
    subscribe: () => () => {},
  }),
}));
vi.mock('./terminals/store.ts', () => ({
  terminalStore: () => ({
    getState: () => fixture.state,
    getInitialState: () => fixture.state,
    subscribe: () => () => {},
    refresh: (id: string) => fixture.refresh(id),
    stop: (id: string) => fixture.stop(id),
    captureSelection: (id: string) => fixture.captureSelection(id),
  }),
}));
vi.mock('./terminals/TerminalView.tsx', () => ({
  TerminalView: ({ onExit }: { onExit?: () => void }) => (
    <button type="button" onClick={onExit}>
      Leave terminal
    </button>
  ),
}));

const target = {
  hostId: 'local',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const terminal: TerminalView = {
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
  controller: { attachmentId: 'another-view', generation: 1, acceptedSequence: 0 },
  exitCode: null,
  error: null,
};
const list: TerminalList = {
  target,
  available: true,
  reason: null,
  shells: [{ id: 'bash', label: 'Bash' }],
  terminals: [terminal],
};
function render(
  current: TerminalView,
  pendingCreate = false,
  loading = false,
  runActive = false,
  locale: 'en' | 'ko' = 'en',
) {
  fixture.state = {
    sessions: {
      session: {
        list: { ...list, terminals: pendingCreate ? [] : [current] },
        loading,
        error: null,
        pendingCreate: pendingCreate
          ? { operationId: 'create', target, shellId: 'bash', cols: 80, rows: 24 }
          : null,
        canRetryCreate: false,
      },
    },
    terminals: {
      terminal: {
        terminal: current,
        connection: current.replayAvailable ? 'connected' : 'unavailable',
        controlling: false,
        inputUnknown: false,
        inputOverflow: false,
        error: null,
        busy: false,
        appliedSequence: 0,
        hasSelection: false,
      },
    },
  };
  return renderToStaticMarkup(
    <IntlProvider
      locale={locale}
      messages={locale === 'ko' ? koreanMessages : messages}
      timeZone="UTC"
    >
      <TerminalPanel sessionId="session" runActive={runActive} />
    </IntlProvider>,
  );
}

it('a missing terminal replay still exposes explicit stop outside the terminal', () => {
  const html = render({ ...terminal, replayAvailable: false, state: 'uncertain' });
  expect(html).toContain('Output replay is unavailable');
  expect(html).toContain('Stop terminal');
  expect(html).toContain('Termination is unconfirmed');
  expect(html).not.toContain('Take control');
});

it.each(['en', 'ko'] as const)(
  'explains legacy host restart recovery in %s before the closed diagnostic details',
  (locale) => {
    const html = render(
      {
        ...terminal,
        state: 'uncertain',
        replayAvailable: false,
        error: 'Legacy terminal observation is missing',
        diagnostic: { phase: 'recovery', code: 'host_restart_required' },
      },
      false,
      false,
      false,
      locale,
    );
    const document = new DOMParser().parseFromString(html, 'text/html');
    const guidance = document.querySelector('[data-testid="terminal-recovery-guidance"]');
    expect(guidance?.textContent).toContain(locale === 'en' ? 'operating system' : '운영체제');
    expect(guidance?.textContent).toContain(locale === 'en' ? 'only the Corral app' : '앱만');
    expect(guidance?.textContent).not.toContain('Legacy terminal observation is missing');
    const diagnostics = [...document.querySelectorAll('details')].find((element) =>
      element.textContent?.includes('Legacy terminal observation is missing'),
    );
    expect(diagnostics?.open).toBe(false);
    expect(diagnostics?.textContent).toContain('host_restart_required');
    expect(diagnostics?.textContent).toContain('recovery');
    expect(
      [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes(locale === 'en' ? 'Stop and verify' : '종료하고 확인'),
      )?.disabled,
    ).toBe(false);
  },
);

it('explains a startup session failure without exposing the technical code as the guidance', () => {
  const html = render({
    ...terminal,
    state: 'uncertain',
    diagnostic: { phase: 'startup', code: 'session_not_ready' },
  });
  const document = new DOMParser().parseFromString(html, 'text/html');
  const guidance = document.querySelector('[data-testid="terminal-recovery-guidance"]');
  expect(guidance?.textContent).toContain('did not finish opening its own session');
  expect(guidance?.textContent).toContain('working copy remains protected');
  expect(guidance?.textContent).not.toContain('session_not_ready');
  expect(document.querySelector('details')?.open).toBe(false);
});

it('only explicitly stops the selected uncertain terminal and keeps its identity for the existing command path', async () => {
  const current: TerminalView = {
    ...terminal,
    state: 'uncertain',
    replayAvailable: false,
    diagnostic: { phase: 'recovery', code: 'identity_unavailable' },
  };
  render(current);
  fixture.stop.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  const renderPanel = () =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <TerminalPanel sessionId="session" />
        </IntlProvider>,
      ),
    );
  try {
    await renderPanel();
    expect(fixture.stop).not.toHaveBeenCalled();
    const stop = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop and verify',
    );
    expect(stop).toBeDefined();
    await act(async () => stop?.click());
    expect(fixture.stop).toHaveBeenCalledExactlyOnceWith(current.terminalId);
    expect(fixture.state.terminals.terminal?.terminal).toMatchObject({
      state: 'uncertain',
      generation: current.generation,
      target: current.target,
    });
    const entry = fixture.state.terminals.terminal;
    assert(entry);
    entry.busy = true;
    await renderPanel();
    expect(
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Stopping…')
        ?.disabled,
    ).toBe(true);
    expect(fixture.stop).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    fixture.stop.mockReset();
  }
});

it('unresolved creation exposes receipt recovery and prevents a new terminal', () => {
  const html = render(terminal, true);
  expect(html).toContain('Check creation result');
  const document = new DOMParser().parseFromString(html, 'text/html');
  const create = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'New terminal',
  );
  expect(create).toBeDefined();
  expect(create?.disabled).toBe(true);
  expect(html).not.toContain('Retry original creation request');
});

/** The panel mounted for interaction, with its details popover opened when asked. */
async function interactive(
  current: TerminalView,
  props: { onAttach?: () => void } = {},
  selected = false,
) {
  render(current);
  const value = fixture.state.terminals.terminal;
  assert(value);
  value.hasSelection = selected;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <TerminalPanel sessionId="session" {...props} />
      </IntlProvider>,
    ),
  );
  return {
    container,
    async details() {
      const trigger = container.querySelector<HTMLElement>('[aria-label="About this terminal"]');
      assert(trigger);
      await act(async () => trigger.click());
      return document.querySelector('[role="dialog"][aria-label="About this terminal"]')
        ?.textContent;
    },
    /** What the tooltip of the control whose name or text is `name` says on hover. */
    async hover(name: string) {
      const control = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.getAttribute('aria-label') === name || node.textContent?.trim() === name,
      );
      assert(control);
      // A disabled control is hovered through the wrapper that holds its tooltip.
      const trigger = control.disabled ? (control.parentElement ?? control) : control;
      await act(async () => {
        trigger.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent('mouseenter'));
        trigger.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1200)));
      return document.body.textContent ?? '';
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it('another controller is read-only until an explicit takeover', async () => {
  const view = await interactive(terminal);
  try {
    const head = view.container.textContent;
    expect(head).toContain('Take over input');
    expect(head).not.toContain('Release input');
    // Who holds input is read from the takeover's tooltip, not a standing paragraph.
    expect(head).not.toContain('Another view controls input');
    expect(await view.hover('Take over input')).toContain('Another view controls input');
  } finally {
    await view.close();
  }
});

it('distinguishes input control release from the protected working copy', async () => {
  const view = await interactive({ ...terminal, controller: null });
  try {
    expect(view.container.querySelector('[aria-label="Stop terminal"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain(messages.Terminals.releaseHint);
    const popup = async () => {
      await view.details();
      return document.querySelector('[role="dialog"][aria-label="About this terminal"]');
    };
    const details = await popup();
    // Two short lines: what holds the copy, and how to free it.
    expect(details?.querySelectorAll('p')).toHaveLength(2);
    expect(details?.textContent).toContain(messages.Terminals.writerHint);
    expect(details?.textContent).toContain(messages.Terminals.releaseHint);
    expect(details?.textContent).not.toContain(messages.Terminals.keyboardHint);
    for (const line of [messages.Terminals.writerHint, messages.Terminals.releaseHint])
      expect(line.length).toBeLessThanOrEqual(60);
  } finally {
    await view.close();
  }
});

it('keeps the writer explanation out of the pane until a save is actually waiting', () => {
  const html = render({ ...terminal, controller: null });
  for (const standing of [
    messages.Terminals.scopeHint,
    messages.Terminals.writerHint,
    messages.Terminals.releaseHint,
    'This view is read-only until',
  ])
    expect(html).not.toContain(standing);
  expect(html).not.toContain('A file save is waiting for this terminal');
});

it('says a terminal blocks a save only while a save of its copy is actually held', () => {
  const blocking = 'A file save is waiting for this terminal. Stop it to save.';
  try {
    fixture.documents = { note: { target: { sessionId: 'session' }, writerBusy: false } };
    expect(render(terminal)).not.toContain(blocking);
    fixture.documents = { note: { target: { sessionId: 'other' }, writerBusy: true } };
    expect(render(terminal)).not.toContain(blocking);
    fixture.documents = { note: { target: { sessionId: 'session' }, writerBusy: true } };
    expect(render(terminal)).toContain(blocking);
    // A stopped terminal holds nothing, whatever the document still remembers.
    expect(render({ ...terminal, state: 'exited', stopped: true })).not.toContain(blocking);
  } finally {
    fixture.documents = null;
  }
});

it('attach selection is enabled only while terminal output is selected', async () => {
  for (const selected of [false, true]) {
    const view = await interactive(terminal, { onAttach: () => {} }, selected);
    try {
      expect(
        view.container.querySelector<HTMLButtonElement>('button[aria-label="Attach selection"]')
          ?.disabled,
      ).toBe(!selected);
    } finally {
      await view.close();
    }
  }
});

it('marks unconfirmed termination in the terminal tab without implying it is running', () => {
  render({ ...terminal, state: 'uncertain' });
  const html = renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <TerminalActivity sessionId="session" />
    </IntlProvider>,
  );
  expect(html).toContain('Terminal termination needs confirmation');
  expect(html).not.toContain('Terminal running');
});

it('the terminal escape action focuses a control outside its input', async () => {
  render(terminal, false, true);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <TerminalPanel sessionId="session" />
        </IntlProvider>,
      );
    });
    const exit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Leave terminal',
    );
    expect(exit).toBeDefined();
    exit?.focus();
    await act(async () => {
      exit?.click();
    });
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Refresh terminals"]'),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('reopening the terminal pane restores only the selection for its workspace, project and session', () => {
  render(terminal);
  const session = fixture.state.sessions.session;
  const first = fixture.state.terminals.terminal;
  assert(session?.list && first);
  const second = { ...terminal, terminalId: 'second', shellId: 'fish', state: 'exited' as const };
  session.list.terminals.push(second);
  fixture.state.terminals.second = { ...first, terminal: second };
  const selectionKey = `corral:terminal-selection:v1:${JSON.stringify(['workspace-a', 'project', 'session'])}`;
  localStorage.setItem(selectionKey, JSON.stringify('second'));
  const reopen = (projectId = 'project') =>
    renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <TerminalPanel sessionId="session" projectId={projectId} />
      </IntlProvider>,
    );
  try {
    fixture.workspaceId = 'workspace-a';
    expect(reopen()).toContain('Terminal 2 · fish');
    expect(reopen('another-project')).toContain('Terminal 1 · bash');
    fixture.workspaceId = 'workspace-b';
    expect(reopen()).toContain('Terminal 1 · bash');
    fixture.workspaceId = undefined;
    expect(reopen()).toContain('Terminal 1 · bash');
  } finally {
    fixture.workspaceId = undefined;
    localStorage.removeItem(selectionKey);
  }
});

it('attaches only the explicit selected text with its captured source target', async () => {
  render(terminal);
  const value = fixture.state.terminals.terminal;
  assert(value);
  value.hasSelection = true;
  const source = {
    kind: 'terminal' as const,
    target,
    terminalId: 'terminal',
    generation: 'generation',
    outputSequence: 2,
    buffer: 'normal' as const,
    cols: 80,
    rows: 24,
    range: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 5 },
  };
  const capturedRevision = composerDraftRevision('session');
  const gate = new Gate();
  fixture.captureSelection.mockImplementation(async () => {
    await gate.wait();
    return { text: 'error', provenance: source };
  });
  const attached = vi.fn();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <TerminalPanel sessionId="session" onAttach={attached} />
        </IntlProvider>,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Attach selection"]',
    );
    assert(button);
    expect(button.disabled).toBe(false);
    expect(attached).not.toHaveBeenCalled();
    await act(async () => button.click());
    expect(fixture.captureSelection).toHaveBeenCalledWith('terminal');
    expect(attached).not.toHaveBeenCalled();
    writeComposerDraft('session', {
      text: 'later typing',
      intent: null,
      target: null,
      targetLabel: null,
      references: [],
    });
    await act(async () => gate.open());
    expect(attached).toHaveBeenCalledTimes(1);
    expect(attached.mock.calls[0]?.[0]).toMatchObject({
      kind: 'text_attachment',
      text: 'error',
      provenance: source,
    });
    expect(attached.mock.calls[0]?.[1]).toMatchObject({ target, revision: capturedRevision });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    fixture.captureSelection.mockReset();
  }
});

it('shows a user stop instead of treating shell exit zero as normal completion', () => {
  const html = render({ ...terminal, state: 'exited', stopped: true, exitCode: 0 });
  expect(html).toContain('Stopped');
  expect(html).not.toContain('Exit code 0');
});

it('prevents creation during an active Run with a recovery instruction', () => {
  const html = render({ ...terminal, state: 'exited' }, false, false, true);
  const document = new DOMParser().parseFromString(html, 'text/html');
  expect(
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'New terminal')
      ?.disabled,
  ).toBe(true);
  expect(html).toContain('Wait for the current Run to finish');
});

it('refreshes terminal availability when a working copy changes', async () => {
  render(terminal);
  fixture.refresh.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <TerminalPanel sessionId="session" />
        </IntlProvider>,
      ),
    );
    const before = fixture.refresh.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event('corral:workspace-changed')));
    expect(fixture.refresh.mock.calls.length).toBeGreaterThan(before);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('a recovery target selects its terminal instead of the remembered terminal', async () => {
  render(terminal);
  const session = fixture.state.sessions.session;
  const first = fixture.state.terminals.terminal;
  assert(session?.list && first);
  const second = { ...terminal, terminalId: 'second', shellId: 'sh' };
  session.list.terminals.push(second);
  fixture.state.terminals.second = { ...first, terminal: second };
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <TerminalPanel sessionId="session" terminalId="second" />
        </IntlProvider>,
      ),
    );
    expect(container.querySelector('[aria-label="Select terminal"]')?.textContent).toContain(
      'Terminal 2 · sh',
    );
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('does not tell an already stopped terminal to stop again when replay is unavailable', () => {
  const html = render({ ...terminal, state: 'exited', stopped: true, replayAvailable: false });
  expect(html).toContain('Output replay is unavailable');
  expect(html).not.toContain('Stop this terminal before creating another');
  expect(html).not.toContain('retained history limit was reached');
});

it('a New terminal that cannot be used says why on hover', async () => {
  const view = await interactive({ ...terminal, controller: null });
  try {
    const create = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === messages.Terminals.create,
    );
    expect(create?.disabled).toBe(true);
    expect(await view.hover(messages.Terminals.create)).toContain(messages.Terminals.createHeld);
  } finally {
    await view.close();
  }
});
