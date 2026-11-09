// @vitest-environment jsdom
import { emptyProjection, type RunSummary } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useMentionSearch } from './useMentionSearch.ts';

const getSnapshot = vi.hoisted(() => vi.fn());
vi.mock('../services.tsx', () => ({
  useServices: () => ({
    transport: { getSnapshot, getRunDefinition: async () => null },
    workspaces: null,
    repository: {},
  }),
}));
vi.mock('../pages/FilesViews.tsx', () => ({ WORKSPACE_CHANGED: 'workspace-changed' }));
vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));

it('offers readable result references and ordinary run pointers without retired artifact reuse', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const projection = emptyProjection('run');
  projection.status = 'succeeded';
  for (const id of ['retired', 'current'])
    projection.artifacts[id] = {
      artifactVersionId: id,
      artifactId: id,
      name: id,
      version: 1,
      parentVersionId: null,
      contract: 'text',
      contentHash: 'a'.repeat(64),
      byteLength: 1,
      authorExecutionId: 'exec',
      modelCallId: null,
      contextSnapshotId: null,
      submitted: true,
      configRevision: 0,
      criteriaVersionId: null,
      inputArtifactVersionIds: [],
      bodyAvailable: id === 'current',
    };
  projection.output = { nodeId: 'output', artifactVersionIds: ['retired', 'current'] };
  getSnapshot.mockResolvedValue({ projection, seq: 1 });
  let search: ReturnType<typeof useMentionSearch> | null = null;
  function Probe() {
    search = useMentionSearch({
      projectId: 'project',
      sessionId: 'session',
      team: null,
      runs: [{ runId: 'run', status: 'succeeded' }] as RunSummary[],
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    if (!search) throw new Error('mention search missing');
    const items = await (search as ReturnType<typeof useMentionSearch>)('');
    expect(items.filter((item) => item.kind === 'result').map((item) => item.reference)).toEqual([
      { kind: 'result', runId: 'run', artifactVersionId: 'current' },
    ]);
    expect(items.some((item) => item.kind === 'run')).toBe(true);
    expect(projection.artifacts.retired?.name).toBe('retired');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
