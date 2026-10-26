import type { RuntimeTransport } from '@corral/core';
import { createRunSession } from '@corral/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunDetail } from './RunPage.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ runRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useNavigate: () => () => {},
}));

it('a run panel reads its own state instead of the graph editor that last ran it', () => {
  const transport = {} as RuntimeTransport;
  const base = createRunSession(transport).getState();
  const graph = createStore(() => ({ ...base, runId: 'run_a', streamError: 'graph-local-state' }));
  const run = createStore(() => ({ ...base, runId: 'run_a', streamError: 'run-owned-state' }));
  fixture.services = {
    runFor: () => run,
    editorSessions: new Map([['graph_a', graph]]),
    transport,
    retainRun: () => () => {},
    repository: {},
  };
  const html = renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunDetail runId="run_a" search={{}} setSearch={() => {}} />
    </IntlProvider>,
  );
  expect(html).toContain('run-owned-state');
  expect(html).not.toContain('graph-local-state');
});
