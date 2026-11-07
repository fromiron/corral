import { type ArtifactVersionView, emptyProjection, type RunProjection } from '@corral/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactViewer } from '../src/components/ArtifactViewer.tsx';
import { ResultReader, RunResults } from '../src/components/RunResults.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { RunDisplayProvider } from '../src/run/display.tsx';
import { runResults } from '../src/run/results.ts';
import { sessionStore } from '../src/stories/fixtures.tsx';

const version = (id: string, no: number): ArtifactVersionView => ({
  artifactVersionId: id,
  artifactId: 'report',
  name: 'Report',
  version: no,
  parentVersionId: no > 1 ? 'old' : null,
  contract: 'draft',
  contentHash: `hash-${id}`,
  byteLength: 10,
  authorExecutionId: 'exec_writer',
  modelCallId: null,
  contextSnapshotId: null,
  submitted: true,
  configRevision: 0,
  criteriaVersionId: null,
  inputArtifactVersionIds: [],
});

function fixture(patch: Partial<RunProjection> = {}) {
  const loadArtifact = vi.fn(async () => {});
  const projection: RunProjection = {
    ...emptyProjection('run_current'),
    status: 'succeeded',
    artifacts: { old: version('old', 1), current: version('current', 2) },
    output: { nodeId: 'output', artifactVersionIds: ['current'] },
    ...patch,
  };
  const session = sessionStore({
    runId: projection.runId,
    projection,
    artifactTexts: { old: 'Retired body must not be shown', current: 'Current final report' },
    loadArtifact,
  });
  return { session, projection, loadArtifact };
}

const wrap = (ui: React.ReactNode) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </IntlProvider>,
  );

describe('current artifact body access', () => {
  it('does not open an explicit retired result or silently substitute the current final result', () => {
    const { session, loadArtifact } = fixture();
    wrap(<RunResults session={session} selectedId="old" onSelect={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This result could not be loaded.');
    expect(screen.queryByText('Retired body must not be shown')).toBeNull();
    expect(screen.queryByText('Current final report')).toBeNull();
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole('navigation', { name: 'Results' })).getAllByRole('button'),
    ).toHaveLength(1);
  });

  it('guards the standalone result reader against a retired cached body', () => {
    const { session, projection, loadArtifact } = fixture();
    const old = runResults(projection).intermediate[0]?.latest;
    if (!old) throw new Error('old result fixture');
    wrap(<ResultReader session={session} item={old} />);
    expect(screen.queryByText('Retired body must not be shown')).toBeNull();
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('guards artifact inspection even when the retired body is still cached', () => {
    const { session, loadArtifact } = fixture();
    wrap(<ArtifactViewer session={session} versionId="old" onClose={vi.fn()} />);
    expect(screen.queryByText('Retired body must not be shown')).toBeNull();
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/unavailable/i);
  });

  it('opens the current final result without previous-version or reuse actions', async () => {
    const { session, loadArtifact } = fixture();
    wrap(
      <RunResults
        session={session}
        selectedId="current"
        onSelect={vi.fn()}
        onStartFrom={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('result-body')).toHaveTextContent('Current final report'),
    );
    expect(loadArtifact).toHaveBeenCalledWith('current');
    expect(screen.queryByRole('button', { name: /Compare|New run from/i })).toBeNull();
    expect(screen.queryByText(/Earlier versions/i)).toBeNull();
  });

  it('does not turn current artifact metadata into links to retired bodies', async () => {
    const { session } = fixture();
    wrap(
      <ArtifactViewer
        session={session}
        versionId="current"
        onClose={vi.fn()}
        onStartFrom={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('artifact-viewer')).toHaveTextContent('Current final report'),
    );
    expect(screen.queryByRole('button', { name: 'old' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Compare|New run from/i })).toBeNull();
  });

  it('does not create media or download URLs for a retired image', () => {
    const { session, projection, loadArtifact } = fixture();
    const old = projection.artifacts.old;
    if (!old) throw new Error('old image fixture');
    old.media = {
      version: 1,
      kind: 'image',
      mime: 'image/png',
      bytes: 10,
      width: 64,
      height: 64,
      sha256: 'a'.repeat(64),
      blobRef: 'retired_blob',
    };
    const item = runResults(projection).intermediate[0]?.latest;
    if (!item) throw new Error('old image result fixture');
    wrap(
      <>
        <ArtifactViewer session={session} versionId="old" onClose={vi.fn()} />
        <ResultReader session={session} item={item} />
      </>,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(loadArtifact).not.toHaveBeenCalled();
  });

  it('does not construct an HTML preview for a retired cached result', () => {
    const { session, projection, loadArtifact } = fixture();
    session.setState({
      artifactTexts: { old: '<!doctype html><html><body>Retired HTML</body></html>' },
    });
    const item = runResults(projection).intermediate[0]?.latest;
    if (!item) throw new Error('old HTML result fixture');
    const previewUrl = vi.fn(() => '/retired-preview');
    const view = wrap(<ResultReader session={session} item={item} previewUrl={previewUrl} />);
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(previewUrl).not.toHaveBeenCalled();
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(screen.queryByText(/Retired HTML/)).toBeNull();
  });

  it('does not let an older display projection restore a retired cached body', () => {
    const { session, projection, loadArtifact } = fixture();
    const earlier: RunProjection = {
      ...projection,
      status: 'running',
      artifacts: { old: version('old', 1) },
      output: null,
    };
    wrap(
      <RunDisplayProvider snapshot={{ projection: earlier, events: [], streams: {} }}>
        <ArtifactViewer session={session} versionId="old" onClose={vi.fn()} />
      </RunDisplayProvider>,
    );
    expect(screen.queryByText('Retired body must not be shown')).toBeNull();
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/unavailable/i);
  });

  it('removes a cached body from an open reader when its final output is superseded', async () => {
    const { session, projection, loadArtifact } = fixture();
    const item = runResults(projection).final[0];
    if (!item) throw new Error('current result fixture');
    wrap(<ResultReader session={session} item={item} />);
    expect(screen.getByTestId('result-body')).toHaveTextContent('Current final report');
    expect(loadArtifact).toHaveBeenCalledWith('current');

    act(() => session.setState({ projection: { ...projection, output: null } }));
    expect(screen.queryByText('Current final report')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy|Download/ })).toBeNull();
  });

  it('does not fetch or show an unknown cached reference in an active run', () => {
    const { session, loadArtifact } = fixture({ status: 'running', output: null });
    session.setState({ artifactTexts: { unknown: 'Unrelated cached payload' } });
    wrap(<ArtifactViewer session={session} versionId="unknown" onClose={vi.fn()} />);
    expect(screen.queryByText('Unrelated cached payload')).toBeNull();
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/unavailable/i);
  });

  it('keeps the pending tool approval payload available without treating it as an artifact', async () => {
    const { session, loadArtifact } = fixture({
      status: 'awaiting_user',
      output: null,
      approvals: {
        permission: {
          approvalId: 'permission',
          kind: 'user_action',
          subjectVersionIds: ['permission_body'],
          criteriaVersionId: null,
          status: 'pending',
          tool: {
            executionId: 'exec_writer',
            attemptNo: 1,
            effectId: 'effect_1',
            toolCallId: 'tool_1',
            bodyRef: 'permission_body',
            fingerprint: 'a'.repeat(64),
            targetTree: 'b'.repeat(40),
            deadline: '2099-10-18T00:00:00.000Z',
          },
        },
      },
    });
    session.setState({ artifactTexts: { permission_body: 'Inspect this tool operation' } });
    wrap(<ArtifactViewer session={session} versionId="permission_body" onClose={vi.fn()} />);
    expect(screen.getByTestId('artifact-viewer')).toHaveTextContent('Inspect this tool operation');
    expect(loadArtifact).toHaveBeenCalledWith('permission_body');
  });

  it('keeps an exact active approval subject inspectable', async () => {
    const { session, loadArtifact } = fixture({
      status: 'awaiting_user',
      output: null,
      approvals: {
        approval: {
          approvalId: 'approval',
          kind: 'final_output',
          subjectVersionIds: ['old'],
          criteriaVersionId: null,
          status: 'pending',
        },
      },
    });
    wrap(<ArtifactViewer session={session} versionId="old" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('artifact-viewer')).toHaveTextContent(
        'Retired body must not be shown',
      ),
    );
    expect(loadArtifact).toHaveBeenCalledWith('old');
  });
});
