// @vitest-environment jsdom
import type { CorralRecord, RuntimeTransport } from '@corral/core';
import { emptyProjection } from '@corral/core';
import { createRunSession, type RunCanvasLayout } from '@corral/react';
import { linearCorral } from '@corral/testkit';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunDetail } from './RunPage.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ runRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useNavigate: () => () => {},
}));
vi.mock('@corral/react', async (original) => ({
  ...(await original<typeof import('@corral/react')>()),
  RunCanvas: ({ layout }: { layout: RunCanvasLayout }) => (
    <output data-testid="layout">{JSON.stringify(layout)}</output>
  ),
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  vi.unstubAllGlobals();
});

async function mount(corralId: string, record: CorralRecord | null) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const definition = linearCorral(['worker'], corralId);
  const projection = {
    ...emptyProjection('run_layout'),
    corralId,
    status: 'succeeded' as const,
  };
  const transport = {
    listRuns: async () => [],
    getSnapshot: async () => ({ projection, seq: 0 }),
  } as unknown as RuntimeTransport;
  const run = createRunSession(transport);
  run.setState({ runId: projection.runId, definition, projection, open: async () => {} });
  const repository = {
    list: vi.fn(async () => (record ? [{ corralId }] : [])),
    get: vi.fn(async () => record),
  };
  fixture.services = { runFor: () => run, retainRun: () => () => {}, transport, repository };
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
        <RunDetail runId={projection.runId} search={{ view: 'run' }} setSearch={() => {}} />
      </IntlProvider>,
    ),
  );
  return { repository, container };
}

it('an inline handoff run lays out its graph without fetching an unsaved Corral', async () => {
  const { repository, container } = await mount('inline_team', null);
  expect(repository.get).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="layout"]')?.textContent).toContain(
    '"source":"auto"',
  );
});

it('a saved Corral keeps its layout even when its id has the auto prefix', async () => {
  const nodes = Object.fromEntries(
    linearCorral(['worker']).nodes.map((node, i) => [node.id, { x: 10 + i, y: 20 + i }]),
  );
  const { repository, container } = await mount('auto_saved', {
    layout: { nodes },
  } as CorralRecord);
  expect(repository.get).toHaveBeenCalledWith('auto_saved');
  expect(container.querySelector('[data-testid="layout"]')?.textContent).toBe(
    JSON.stringify({ source: 'saved', nodes }),
  );
});

it('a removed Corral still displays its run with an automatic layout', async () => {
  const { repository, container } = await mount('removed_corral', null);
  expect(repository.get).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="layout"]')?.textContent).toContain(
    '"source":"auto"',
  );
});
