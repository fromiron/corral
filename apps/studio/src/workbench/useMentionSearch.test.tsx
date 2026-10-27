// @vitest-environment jsdom
import { type ArtifactVersionView, emptyProjection, type RunSummary } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import type { MentionItem } from './composerMenu.ts';
import { useMentionSearch } from './useMentionSearch.ts';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../pages/FilesViews.tsx', () => ({ WORKSPACE_CHANGED: 'workspace-changed' }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

it('distinguishes run and author, deduplicates version IDs, and preserves distinct results', async () => {
  const runs = ['older', 'newer'].map((runId) => ({ runId, status: 'succeeded' }) as RunSummary);
  fixture.services = {
    workspaces: null,
    repository: {},
    transport: {
      getSnapshot: async (runId: string) => {
        const projection = emptyProjection(runId);
        projection.status = 'succeeded';
        projection.artifacts = Object.fromEntries(
          ['a', 'b'].map((suffix) => {
            const id = `${runId}-${suffix}`;
            return [
              id,
              {
                artifactVersionId: id,
                artifactId: id,
                name: 'notes',
                version: 1,
                authorExecutionId: `exec-${suffix}`,
                contract: 'draft',
                byteLength: 1,
              } as ArtifactVersionView,
            ];
          }),
        );
        projection.executions['exec-a'] = { nodeId: 'helper' } as never;
        projection.executions['exec-b'] = { nodeId: 'helper' } as never;
        projection.executionOrder = ['exec-a', 'exec-b'];
        projection.output = {
          nodeId: 'out',
          artifactVersionIds: [`${runId}-a`, `${runId}-a`, `${runId}-b`],
        };
        return { projection };
      },
      getRunDefinition: async () => ({ nodes: [{ id: 'helper', label: 'Researcher' }] }),
    },
  };
  let search!: (query: string) => Promise<MentionItem[]>;
  function Harness() {
    search = useMentionSearch({ projectId: 'project', sessionId: 'session', runs, team: null });
    return null;
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Harness />
      </IntlProvider>,
    ),
  );
  const items = await search('');
  const results = items.filter((item) => item.kind === 'result');
  expect(results.map((item) => item.id)).toEqual([
    'result:newer-a',
    'result:newer-b',
    'result:older-a',
    'result:older-b',
  ]);
  expect(results[0]?.detail).toBe('Run #2 · Researcher · execution 1');
  expect(results[1]?.detail).toBe('Run #2 · Researcher · execution 2');
  expect(results[2]?.detail).toBe('Run #1 · Researcher · execution 1');
  expect(items.filter((item) => item.kind === 'run').map((item) => item.label)).toEqual([
    'Run #2',
    'Run #1',
  ]);
});
