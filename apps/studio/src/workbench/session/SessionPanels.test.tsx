// @vitest-environment jsdom
import type { ArtifactVersionView, RunProjection, RunSummary } from '@corral/core';
import { emptyProjection } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ArtifactsPanel } from './SessionPanels.tsx';

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../../pages/FilesViews.tsx', () => ({ useBinding: () => ({ binding: null }) }));
vi.mock('../../pages/ReviewPage.tsx', () => ({ Checks: () => null }));
vi.mock('../../pages/RunPage.tsx', () => ({ RunDetail: () => null }));
vi.mock('../Breadcrumbs.tsx', () => ({ RunMenu: () => null }));
vi.mock('../TopbarSlot.tsx', () => ({ TopbarCrumb: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const version = (id: string, artifactId: string): ArtifactVersionView => ({
  artifactVersionId: id,
  artifactId,
  name: artifactId,
  version: 1,
  parentVersionId: null,
  contract: 'draft',
  contentHash: `hash-${id}`,
  byteLength: 10,
  authorExecutionId: 'exec_write',
  modelCallId: null,
  contextSnapshotId: null,
  submitted: true,
  configRevision: 0,
  criteriaVersionId: null,
  inputArtifactVersionIds: [],
});

it('lists a partial result the run no longer keeps as a row that cannot be opened', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // A failed run keeps each step's last submission (here the one its fork carried); the
  // other version it made was released when it ended (api-contract.md, 산출물 본문 수명).
  const projection: RunProjection = {
    ...emptyProjection('run_a'),
    status: 'failed',
    artifacts: { kept: version('kept', 'draft'), gone: version('gone', 'notes') },
    forkedFrom: {
      runId: 'run_0',
      nodeId: 'write',
      carried: [{ nodeId: 'write', artifactVersionIds: ['kept'] }],
    },
  };
  fixture.services = {
    transport: {
      getSnapshot: async () => ({ projection }),
      getRunDefinition: async () => ({ nodes: [] }),
    },
  };
  const runs = [{ runId: 'run_a', status: 'failed' } as RunSummary];
  const onOpen = vi.fn();
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
        <ArtifactsPanel runs={runs} onOpen={onOpen} />
      </IntlProvider>,
    ),
  );
  await act(async () => {});
  const rows = [...container.querySelectorAll('ul[aria-label] > li')];
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('notes v1'),
    expect.stringContaining('draft v1'),
  ]);
  const [gone, kept] = rows;
  // The released one says so and offers nothing to open.
  expect(gone?.querySelector('button')).toBeNull();
  expect(gone?.textContent).toContain('Text no longer kept');
  // The kept one opens as before.
  const open = kept?.querySelector('button');
  expect(open?.getAttribute('aria-label')).toBe('Partial results draft v1 · Run #1');
  expect(kept?.textContent).not.toContain('Text no longer kept');
  await act(async () => open?.click());
  expect(onOpen).toHaveBeenCalledWith('run_a', 'kept');
});
