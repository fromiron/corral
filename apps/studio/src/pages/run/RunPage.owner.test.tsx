// @vitest-environment jsdom
import type { RuntimeTransport } from '@corral/core';
import { createRunSession } from '@corral/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunDetail } from './RunPage.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../../router.tsx', () => ({ runRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
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

describe('a run that does not exist', () => {
  const render = (mode: 'server' | 'browser') => {
    const transport = {} as RuntimeTransport;
    const base = createRunSession(transport).getState();
    const run = createStore(() => ({ ...base, runId: null, missingRunId: 'run_gone' }));
    fixture.services = {
      mode,
      runFor: () => run,
      editorSessions: new Map(),
      transport,
      retainRun: () => () => {},
      repository: {},
    };
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunDetail runId="run_gone" search={{}} setSearch={() => {}} />
      </IntlProvider>,
    );
    return host;
  };

  it('on a server, says it is not in this workspace and leads to the project list by name', () => {
    const page = render('server');
    expect(page.textContent).toContain(messages.RunPage.missingServer);
    expect(page.textContent).not.toContain(messages.RunPage.missing);
    const links = [...page.querySelectorAll('a')];
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      [messages.Shell.allProjects, '/projects'],
    ]);
  });

  it('in the browser demo, says demo runs end when the page reloads', () => {
    const page = render('browser');
    expect(page.textContent).toContain(messages.RunPage.missing);
    expect(page.textContent).not.toContain(messages.RunPage.missingServer);
    expect(page.querySelector('a')?.textContent).toBe(messages.Shell.allProjects);
  });
});
