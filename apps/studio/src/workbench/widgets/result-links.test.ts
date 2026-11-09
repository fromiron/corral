import { emptyProjection } from '@corral/core';
import { expect, it } from 'vitest';
import { availableResultLinks } from './selectors.ts';

it('keeps current result links in order and excludes released bodies without removing metadata', () => {
  const projection = emptyProjection('run');
  projection.status = 'succeeded';
  const items = ['old', 'current', 'second'].map((id) => ({
    artifactVersionId: id,
    name: id,
    version: 1,
  }));
  for (const item of items)
    projection.artifacts[item.artifactVersionId] = {
      ...item,
      artifactId: item.artifactVersionId,
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
      bodyAvailable: item.artifactVersionId !== 'old',
    };
  projection.output = {
    nodeId: 'output',
    artifactVersionIds: items.map((item) => item.artifactVersionId),
  };
  expect(availableResultLinks(projection, items)).toEqual([
    { id: 'current', label: 'current v1' },
    { id: 'second', label: 'second v1' },
  ]);
  expect(projection.artifacts.old?.name).toBe('old');
  expect(
    availableResultLinks(
      projection,
      items.filter((item) => item.artifactVersionId === 'old'),
    ),
  ).toEqual([]);
});
