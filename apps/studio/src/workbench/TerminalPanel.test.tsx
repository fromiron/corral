// @vitest-environment jsdom
import type { TerminalList, TerminalView } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TerminalPanel } from './TerminalPanel.tsx';

const fixture = vi.hoisted(() => ({ state: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => ({ mode: 'server', terminals: {} }) }));
vi.mock('./terminals/store.ts', () => ({
  terminalStore: () => ({
    getState: () => fixture.state,
    getInitialState: () => fixture.state,
    subscribe: () => () => {},
    refresh: async () => {},
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
