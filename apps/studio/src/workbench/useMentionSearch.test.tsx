// @vitest-environment jsdom
import { type ArtifactVersionView, emptyProjection, type RunSummary } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import {
  type MentionItem,
  mentionToken,
  pickedReferences,
  removeMention,
  selectMention,
} from './composerMenu.ts';
import { parseComposerDraft, serializeComposerDraft } from './sessionDraft.ts';
import { useMentionSearch } from './useMentionSearch.ts';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../pages/FilesViews.tsx', () => ({ WORKSPACE_CHANGED: 'workspace-changed' }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'distinguishes exact result versions, including one author with multiple artifacts (%s)',
  async (sameAuthor) => {
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
                  authorExecutionId: sameAuthor ? 'exec-a' : `exec-${suffix}`,
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
    let search!: ReturnType<typeof useMentionSearch>;
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
    const { items } = await search('');
    const results: MentionItem[] = [];
    for (const item of items.filter((item) => item.kind === 'result'))
      results.push(selectMention(item, results));
    expect(new Set(results.map(mentionToken)).size).toBe(4);
    const restored = parseComposerDraft(
      serializeComposerDraft({
        text: results.map(mentionToken).join(' '),
        intent: 'next',
        target: null,
        targetLabel: null,
        references: results,
      }),
    );
    const first = results[0];
    if (!first) throw new Error('Result fixture missing');
    const remaining = removeMention(restored.text, first);
    expect(pickedReferences(remaining, restored.references)).toEqual(
      results.slice(1).map((item) => item.reference),
    );
    expect(results.map((item) => item.id)).toEqual([
      'result:newer:newer-a',
      'result:newer:newer-b',
      'result:older:older-a',
      'result:older:older-b',
    ]);
    expect(results[0]?.label).toBe('notes v1 · Run #2 · execution 1');
    expect(results[1]?.label).toBe(`notes v1 · Run #2 · execution ${sameAuthor ? 1 : 2}`);
    expect(selectMention({ ...first, token: undefined }, restored.references)).toEqual(first);
    expect(results[2]?.label).toBe('notes v1 · Run #1 · execution 1');
    expect(results.every((item) => item.detail === 'Researcher')).toBe(true);
    expect(items.filter((item) => item.kind === 'run').map((item) => item.label)).toEqual([
      'Run #2',
      'Run #1',
    ]);
  },
);

// docs/specs/features/file-search.md: an unread target is read again by the next search.
it('reads the target again after a failed read, and never searches the source folder for an unread Paddock', async () => {
  const worktree = vi
    .fn<() => Promise<unknown>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ missing: false, removedAt: null });
  const binding = vi.fn(async () => ({ projectId: 'project' }));
  const searchFiles = vi.fn(async () => ({
    items: [{ path: 'src/a.ts', kind: 'file' }],
    truncated: false,
  }));
  fixture.services = {
    workspaces: { worktree, binding, searchFiles },
    repository: {},
    transport: {},
  };
  let search!: ReturnType<typeof useMentionSearch>;
  function Harness() {
    search = useMentionSearch({ projectId: 'project', sessionId: 'session', runs: [], team: null });
    return null;
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
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
  const first = await search('a');
  expect(first.items.filter((item) => item.kind === 'file')).toEqual([]);
  expect(first.unread).toEqual(['files']);
  expect(binding).not.toHaveBeenCalled();
  expect(searchFiles).not.toHaveBeenCalled();
  const second = await search('a');
  expect(searchFiles).toHaveBeenCalledWith({ kind: 'session', id: 'session' }, 'a', 8);
  expect(second.items.map((item) => item.label)).toContain('src/a.ts');
  expect(second.unread).toEqual([]);
});

// A read that failed is not kept as "nothing there": each is said, and read again by the next search.
it('says which lookups failed (the file search, a run’s results, the team’s roles) and reads each again', async () => {
  const searchFiles = vi
    .fn<() => Promise<unknown>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ items: [{ path: 'src/a.ts', kind: 'file' }], truncated: false });
  const getSnapshot = vi
    .fn<(runId: string) => Promise<unknown>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(async (runId) => {
      const projection = emptyProjection(runId);
      projection.status = 'succeeded';
      return { projection };
    });
  const get = vi
    .fn<() => Promise<unknown>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ definition: { roles: [{ id: 'writer', name: 'Writer' }] } });
  fixture.services = {
    workspaces: {
      worktree: async () => ({ missing: false, removedAt: null }),
      binding: async () => ({ projectId: 'project' }),
      searchFiles,
    },
    repository: { get },
    transport: { getSnapshot, getRunDefinition: async () => null },
  };
  const runs = [{ runId: 'run', status: 'succeeded' } as RunSummary];
  const team = { corralId: 'team', definitionRevision: 1 } as never;
  let search!: ReturnType<typeof useMentionSearch>;
  function Harness() {
    search = useMentionSearch({ projectId: 'project', sessionId: 'session', runs, team });
    return null;
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
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
  const first = await search('');
  expect(first.unread).toEqual(['files', 'results', 'roles']);
  // What was read is still offered: the run itself comes from the list already in hand.
  expect(first.items.map((item) => item.label)).toEqual(['Run #1']);
  const second = await search('');
  expect(second.unread).toEqual([]);
  expect(getSnapshot).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledTimes(2);
  expect(second.items.map((item) => item.label)).toEqual(['src/a.ts', 'Run #1', 'Writer']);
});
