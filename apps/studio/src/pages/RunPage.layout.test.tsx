// @vitest-environment jsdom
import type { CorralRecord, RuntimeTransport } from '@corral/core';
import { emptyProjection } from '@corral/core';
import { createRunSession, type RunCanvasLayout } from '@corral/react';
import { linearCorral } from '@corral/testkit';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunDetail, type RunDetailSearch } from './RunPage.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ runRoute: {} }));
vi.mock('../workbench/RunStatusCards.tsx', () => ({ RunStatusCards: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useNavigate: () => () => {},
}));
vi.mock('@corral/react', async (original) => ({
  ...(await original<typeof import('@corral/react')>()),
  RunResults: () => <output data-testid="results">Results</output>,
  ApprovalPanel: ({ onOpenArtifact }: { onOpenArtifact: (id: string) => void }) => (
    <button type="button" onClick={() => onOpenArtifact('artv_evidence')}>
      Approval evidence
    </button>
  ),
  RunCanvas: ({ layout }: { layout: RunCanvasLayout }) => (
    <output data-testid="layout">{JSON.stringify(layout)}</output>
  ),
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  vi.unstubAllGlobals();
});

async function mount(
  corralId: string,
  record: CorralRecord | null,
  search: RunDetailSearch = { view: 'run' },
) {
  // jsdom has no layout; pointer and resize behavior is checked in the browser.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  function Screen() {
    const [selection, setSelection] = useState(search);
    return (
      <RunDetail
        runId={projection.runId}
        search={selection}
        setSearch={(patch) => setSelection((current) => ({ ...current, ...patch }))}
      />
    );
  }
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Screen />
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

it('a completed run opens its graph unless a result was explicitly requested', async () => {
  const graph = await mount('inline_team', null, {});
  expect(graph.container.querySelector('[data-testid="layout"]')).not.toBeNull();
  expect(
    graph.container.querySelector('[data-testid="results"]')?.closest('main')?.style.display,
  ).toBe('none');
  const result = await mount('inline_team', null, { view: 'results' });
  expect(result.container.querySelector('[data-testid="results"]')).not.toBeNull();
});

it('the selected Graph tab returns from the tree and result links keep the monitor mounted', async () => {
  const { container } = await mount('inline_team', null);
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find((el) =>
      el.textContent?.includes(text),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  await click('Executions');
  expect(container.querySelector('.run-layout')?.getAttribute('data-panel')).toBe('tree');
  await click('Graph');
  expect(container.querySelector('.run-layout')?.getAttribute('data-panel')).toBe('canvas');
  const graph = container.querySelector('[data-testid="layout"]');
  await click('Results');
  expect(container.querySelector('[data-testid="layout"]')).toBe(graph);
  await click('Approval evidence');
  expect(container.querySelector('[data-testid="results"]')?.closest('main')?.style.display).toBe(
    'none',
  );
  expect(container.querySelector('.run-layout')?.getAttribute('data-details')).toBe('true');
});
