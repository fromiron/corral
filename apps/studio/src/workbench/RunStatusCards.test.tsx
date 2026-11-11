// @vitest-environment jsdom
import type { ModelCallView } from '@corral/core';
import { emptyProjection } from '@corral/core';
import { createRunSession, type RunSessionStore } from '@corral/react';
import { Accordion } from '@corral/react/design-kit';
import { linearCorral } from '@corral/testkit';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunStatusCards } from './RunStatusCards.tsx';

vi.mock('../services.tsx', () => ({ useServices: () => ({ mode: 'server', workspaces: null }) }));
vi.mock('./navigation.ts', () => ({ useSettingsNavigation: () => ({ link: () => ({}) }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

/** The cards as Run info shows them: rows of its one accordion, every row opened. */
async function showOpen(session: RunSessionStore) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Accordion type="multiple">
          <RunStatusCards session={session} sessionId={null} executionId={null} />
        </Accordion>
      </IntlProvider>,
    ),
  );
  for (const trigger of container.querySelectorAll<HTMLButtonElement>('[aria-expanded="false"]'))
    await act(async () => trigger.click());
  return container;
}

it('shows each part as a row of Run info’s one kit accordion, not a second kind of disclosure', async () => {
  const session = createRunSession({} as never);
  session.setState({
    runId: 'run_cards',
    projection: emptyProjection('run_cards'),
    definition: linearCorral(['worker']),
  });
  const container = await showOpen(session);
  expect(container.querySelector('details')).toBeNull();
  const context = container.querySelector('[data-testid="status-context"]');
  expect(context?.querySelector('button[aria-expanded="true"]')).not.toBeNull();
});

it('reads what was not reported as No information, with no unit after it', async () => {
  const projection = emptyProjection('run_cards');
  projection.executions.exec_worker = { nodeId: 'worker', status: 'succeeded' } as never;
  projection.executionOrder = ['exec_worker'];
  const session = createRunSession({} as never);
  session.setState({ runId: 'run_cards', projection, definition: linearCorral(['worker']) });
  const container = await showOpen(session);
  const context = container.querySelector('[data-testid="status-context"]');
  expect(context?.textContent).toContain('Context and cost · No information');
  expect(context?.textContent).toContain('Model context limit: No information');
  expect(context?.textContent).not.toMatch(/No information tokens|Unknown/);
});

// Run usage is read in Run info › Usage only (docs/specs/features/execution-monitor.md); the
// overview's context card does not repeat it.
it('keeps run usage out of the overview cards', async () => {
  const projection = emptyProjection('run_cards');
  projection.executions.exec_worker = { nodeId: 'worker', status: 'succeeded' } as never;
  projection.executionOrder = ['exec_worker'];
  projection.modelCalls.call_a = {
    modelCallId: 'call_a',
    executionId: 'exec_worker',
    finished: true,
    usage: { inputTokens: 10, outputTokens: 4321, cachedInputTokens: null },
  } as ModelCallView;
  const session = createRunSession({} as never);
  session.setState({ runId: 'run_cards', projection, definition: linearCorral(['worker']) });
  const container = await showOpen(session);
  expect(container.querySelector('[data-testid="status-context"]')).not.toBeNull();
  expect(container.textContent).not.toMatch(/4,?321/);
  expect(container.querySelector('[data-testid^="usage-call-"]')).toBeNull();
});
