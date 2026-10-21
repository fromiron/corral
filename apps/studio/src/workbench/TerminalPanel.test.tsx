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
import { composerDraftRevision, writeComposerDraft } from './sessionDraft.ts';
import { TerminalPanel } from './TerminalPanel.tsx';
import type { TerminalSelection, TerminalStore } from './terminals/store.ts';

const fixture = vi.hoisted(() => ({
  state: {} as ReturnType<TerminalStore['getState']>,
  workspaceId: undefined as string | undefined,
  captureSelection: vi.fn<(id: string) => Promise<TerminalSelection | null>>(),
}));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', terminals: {}, workspaceId: fixture.workspaceId }),
}));
vi.mock('./terminals/store.ts', () => ({
  terminalStore: () => ({
    getState: () => fixture.state,
    getInitialState: () => fixture.state,
    subscribe: () => () => {},
    refresh: async () => {},
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
function render(current: TerminalView, pendingCreate = false, loading = false) {
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
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <TerminalPanel sessionId="session" />
    </IntlProvider>,
  );
}

it('[TC-WBD-004-N] a missing terminal replay still exposes explicit stop outside the terminal', () => {
  const html = render({ ...terminal, replayAvailable: false, state: 'uncertain' });
  expect(html).toContain('Output replay is unavailable');
  expect(html).toContain('Stop terminal');
  expect(html).toContain('Termination is unconfirmed');
  expect(html).not.toContain('Take control');
});

it('[TC-WBD-004-N] unresolved creation exposes receipt recovery and prevents a new terminal', () => {
  const html = render(terminal, true);
  expect(html).toContain('Check creation result');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>New terminal<\/button>/);
  expect(html).not.toContain('Retry original creation request');
});

it('[TC-WBD-004-N] another controller is read-only until an explicit takeover', () => {
  const html = render(terminal);
  expect(html).toContain('Another view controls input');
  expect(html).toContain('Take over input');
  expect(html).not.toContain('Release input');
});

it('[TC-WBD-004-N] the terminal escape action focuses a control outside its input', async () => {
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

it('[TC-WBD-006-H] reopening the terminal pane restores only the selection for its workspace, project and session', () => {
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

it('[TC-WBD-007-H] attaches only the explicit selected text with its captured source target', async () => {
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
    const button = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Attach selection',
    );
    assert(button);
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
