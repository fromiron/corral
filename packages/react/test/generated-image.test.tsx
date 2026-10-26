import { emptyProjection } from '@corral/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { ArtifactViewer } from '../src/components/ArtifactViewer.tsx';
import { RunResults } from '../src/components/RunResults.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';

function imageProjection() {
  const projection = emptyProjection('run_image');
  projection.artifacts.artv_image = {
    artifactVersionId: 'artv_image',
    artifactId: 'image',
    version: 1,
    parentVersionId: null,
    name: 'Generated landscape',
    contract: 'draft',
    contentHash: 'a'.repeat(64),
    byteLength: 1234,
    authorExecutionId: 'exec_image',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
    media: {
      version: 1,
      kind: 'image',
      mime: 'image/png',
      bytes: 1234,
      width: 1536,
      height: 1024,
      sha256: 'a'.repeat(64),
      blobRef: 'blob_image',
    },
  };
  projection.status = 'succeeded';
  projection.output = { nodeId: 'output', artifactVersionIds: ['artv_image'] };
  return projection;
}

it('renders original image bytes through the authorized media route instead of text or HTML', () => {
  const projection = imageProjection();
  const loadArtifact = vi.fn(async () => {});
  const session = sessionStore({ projection, loadArtifact });
  render(
    <IntlProvider locale="en" messages={messages}>
      <ArtifactViewer session={session} versionId="artv_image" onClose={vi.fn()} />
    </IntlProvider>,
  );
  const image = screen.getByRole('img', { name: 'Generated landscape' });
  const route = '/api/v1/runs/run_image/artifact-versions/artv_image/media';
  expect(image).toHaveAttribute('src', route);
  expect(image).toHaveAttribute('width', '1536');
  expect(screen.getByRole('link', { name: 'Download original PNG' })).toHaveAttribute(
    'href',
    `${route}?download=1`,
  );
  expect(loadArtifact).not.toHaveBeenCalled();
  fireEvent.load(image);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.error(image);
  expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('final results show the generated image directly without exposing metadata as Markdown', () => {
  const loadArtifact = vi.fn(async () => {});
  const session = sessionStore({
    runId: 'run_image',
    projection: imageProjection(),
    loadArtifact,
    artifactTexts: { artv_image: '{"blobRef":"internal_blob_reference"}' },
  });
  render(
    <IntlProvider locale="en" messages={messages}>
      <RunResults session={session} selectedId={null} onSelect={vi.fn()} />
    </IntlProvider>,
  );
  expect(screen.getByRole('img', { name: 'Generated landscape' })).toHaveAttribute(
    'src',
    '/api/v1/runs/run_image/artifact-versions/artv_image/media',
  );
  expect(screen.getByRole('link', { name: 'Download original PNG' })).toBeVisible();
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(screen.queryByText(/internal_blob_reference/)).not.toBeInTheDocument();
  expect(loadArtifact).not.toHaveBeenCalled();
});
