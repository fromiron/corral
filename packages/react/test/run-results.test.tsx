import { type ArtifactVersionView, emptyProjection, type RunProjection } from '@corral/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { isHtmlDocument, RunResults, sandboxedSrcDoc } from '../src/components/RunResults.tsx';
import { RunOutput } from '../src/components/RunView.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { runResults } from '../src/run/results.ts';
import { sessionStore } from '../src/stories/fixtures.tsx';

// Results view (CR-009, roadmap 21; proposal WBTST-008/009/010/034).

function version(
  id: string,
  artifactId: string,
  no: number,
  extra: Partial<ArtifactVersionView> = {},
): ArtifactVersionView {
  return {
    artifactVersionId: id,
    artifactId,
    version: no,
    parentVersionId: null,
    name: artifactId,
    contract: 'draft',
    contentHash: `hash-${id}`,
    byteLength: 10,
    authorExecutionId: 'exec_1',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: false,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
    ...extra,
  };
}

function projectionWith(
  artifacts: ArtifactVersionView[],
  patch: Partial<RunProjection> = {},
): RunProjection {
  return {
    ...emptyProjection('run_1'),
    artifacts: Object.fromEntries(artifacts.map((a) => [a.artifactVersionId, a])),
    ...patch,
  };
}

describe('runResults (CR-009)', () => {
  it('[WBTST-008] lists every final output in Output order, not only the first', () => {
    const p = projectionWith(
      [version('v_a', 'report', 1), version('v_b', 'summary', 1), version('v_c', 'appendix', 1)],
      { status: 'succeeded', output: { nodeId: 'out', artifactVersionIds: ['v_b', 'v_a', 'v_c'] } },
    );
    const results = runResults(p);
    expect(results.kind).toBe('final');
    expect(results.final.map((r) => r.artifactVersionId)).toEqual(['v_b', 'v_a', 'v_c']);
    expect(results.intermediate).toEqual([]);
    expect(results.defaultId).toBe('v_b');
  });

  it('groups intermediate versions by artifact, newest group and version first', () => {
    const p = projectionWith(
      [
        version('n1', 'notes', 1),
        version('d1', 'draft', 1),
        version('r1', 'review', 1, { contract: 'review' }),
        version('d2', 'draft', 2, { parentVersionId: 'd1' }),
      ],
      { status: 'succeeded', output: { nodeId: 'out', artifactVersionIds: ['d2'] } },
    );
    const results = runResults(p);
    expect(results.final.map((r) => r.artifactVersionId)).toEqual(['d2']);
    // d2 is the final result, so the draft group keeps only v1. Groups are ordered by the
    // newest version they list: review@1 came after draft@1.
    expect(
      results.intermediate.map((g) => [g.artifactId, g.versions.map((v) => v.version)]),
    ).toEqual([
      ['review', [1]],
      ['draft', [1]],
      ['notes', [1]],
    ]);
  });

  it('[WBTST-009] keeps what a failed run made as a partial result', () => {
    const p = projectionWith([version('n1', 'notes', 1), version('d1', 'draft', 1)], {
      status: 'failed',
    });
    const results = runResults(p);
    expect(results.kind).toBe('partial');
    expect(results.final).toEqual([]);
    expect(results.intermediate.map((g) => g.artifactId)).toEqual(['draft', 'notes']);
    expect(results.defaultId).toBe('d1');
  });

  it('tells a run still working from one that ended with nothing', () => {
    expect(runResults(projectionWith([], { status: 'running' })).kind).toBe('pending');
    expect(runResults(projectionWith([], { status: 'cancelled' })).kind).toBe('none');
    expect(
      runResults(projectionWith([version('n1', 'notes', 1)], { status: 'running' })).kind,
    ).toBe('pending');
  });

  it('links each version to its latest review verdict', () => {
    const p = projectionWith(
      [version('d1', 'draft', 1), version('r1', 'review', 1, { contract: 'review' })],
      {
        status: 'succeeded',
        output: { nodeId: 'out', artifactVersionIds: ['d1'] },
        reviews: {
          r1: {
            stale: false,
            newCriteriaVersionId: null,
            reviewVersionId: 'r1',
            targetVersionId: 'd1',
            criteriaVersionId: 'c1',
            verdict: 'pass',
            issues: [],
          },
        },
      },
    );
    expect(runResults(p).final[0]?.review).toEqual({ verdict: 'pass', stale: false });
    expect(runResults(p).intermediate[0]?.latest.review).toBeNull();
  });
});

describe('HTML preview isolation (CR-009, WBTST-034)', () => {
  it('recognises whole HTML documents only', () => {
    expect(isHtmlDocument('<!DOCTYPE html><html></html>')).toBe(true);
    expect(isHtmlDocument('  <html lang="en">')).toBe(true);
    expect(isHtmlDocument('# Title\n<b>bold</b>')).toBe(false);
  });

  it('puts a no-script, no-network policy before the document', () => {
    const doc = sandboxedSrcDoc('<html><script>alert(1)</script></html>');
    const policy = /^<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(doc)?.[1];
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('script-src');
    expect(doc.endsWith('<html><script>alert(1)</script></html>')).toBe(true);
  });
});

const wrap = (ui: React.ReactNode) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </IntlProvider>,
  );

describe('RunResults view (CR-009)', () => {
  const texts = { v_a: '# Report\n\nalpha body', v_b: 'beta body', v_c: 'gamma body' };
  const finalThree = () =>
    sessionStore({
      runId: 'run_1',
      projection: projectionWith(
        [
          version('v_a', 'report', 1, { submitted: true }),
          version('v_b', 'summary', 1),
          version('v_c', 'appendix', 1),
        ],
        {
          status: 'succeeded',
          output: { nodeId: 'out', artifactVersionIds: ['v_a', 'v_b', 'v_c'] },
        },
      ),
      artifactTexts: texts,
    });

  it('[WBTST-008] shows each of three final outputs when chosen', async () => {
    const session = finalThree();
    const onSelect = vi.fn();
    const view = wrap(<RunResults session={session} selectedId={null} onSelect={onSelect} />);
    const list = screen.getByRole('navigation', { name: 'Results' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    await waitFor(() => expect(screen.getByTestId('result-body')).toHaveTextContent('alpha body'));
    for (const [id, body] of [
      ['v_b', 'beta body'],
      ['v_c', 'gamma body'],
    ] as const) {
      view.rerender(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <RunResults session={session} selectedId={id} onSelect={onSelect} />
        </IntlProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('result-body')).toHaveTextContent(body));
    }
    fireEvent.click(within(list).getByRole('button', { name: /appendix/ }));
    expect(onSelect).toHaveBeenCalledWith('v_c');
  });

  it('[WBTST-010] separates run, review and submission without inventing file-work evidence', async () => {
    wrap(<RunResults session={finalThree()} selectedId="v_a" onSelect={vi.fn()} />);
    const states = screen.getByRole('list', { name: 'Result state' });
    expect(states).toHaveTextContent('Run: Succeeded');
    expect(states).toHaveTextContent('Review: none');
    expect(states).toHaveTextContent('Submitted');
    expect(states).not.toHaveTextContent('No file changes or checks in this run');
  });

  it('[WBTST-009] shows a failed run’s work as a partial result, not “pending”', async () => {
    const session = sessionStore({
      runId: 'run_1',
      projection: projectionWith([version('d1', 'draft', 1)], { status: 'failed' }),
      artifactTexts: { d1: 'half-written draft' },
    });
    wrap(<RunResults session={session} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/partial/i);
    await waitFor(() =>
      expect(screen.getByTestId('result-body')).toHaveTextContent('half-written draft'),
    );
  });

  it('shows the source and an isolated preview for an HTML document', async () => {
    const html = '<!doctype html><html><body><h1>Page</h1><script>alert(1)</script></body></html>';
    const session = sessionStore({
      runId: 'run_1',
      projection: projectionWith([version('h1', 'page', 1)], {
        status: 'succeeded',
        output: { nodeId: 'out', artifactVersionIds: ['h1'] },
      }),
      artifactTexts: { h1: html },
    });
    wrap(<RunResults session={session} selectedId="h1" onSelect={vi.fn()} />);
    const frame = await screen.findByTitle('Preview of page v1');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    fireEvent.click(screen.getByRole('radio', { name: 'Source' }));
    expect(screen.getByTestId('result-body').querySelector('pre')?.textContent).toBe(html);
    expect(document.querySelector('script')).toBeNull();
  });

  it('uses the server preview address when the runtime has one', async () => {
    const html = '<!doctype html><html><body>x</body></html>';
    const session = sessionStore({
      runId: 'run_1',
      projection: projectionWith([version('h1', 'page', 1)], {
        status: 'succeeded',
        output: { nodeId: 'out', artifactVersionIds: ['h1'] },
      }),
      artifactTexts: { h1: html },
    });
    wrap(
      <RunResults
        session={session}
        selectedId="h1"
        onSelect={vi.fn()}
        previewUrl={(runId, id) => `/api/v1/runs/${runId}/artifact-versions/${id}/preview`}
      />,
    );
    const frame = await screen.findByTitle('Preview of page v1');
    expect(frame.getAttribute('src')).toBe('/api/v1/runs/run_1/artifact-versions/h1/preview');
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.getAttribute('sandbox')).toBe('');
  });
});

describe('Output tab with several final results (CR-009)', () => {
  it('[WBTST-008] names every final result and offers the Results view', () => {
    const onOpenResults = vi.fn();
    const session = sessionStore({
      runId: 'run_1',
      projection: projectionWith(
        [version('v_a', 'report', 1), version('v_b', 'summary', 1), version('v_c', 'appendix', 1)],
        {
          status: 'succeeded',
          output: { nodeId: 'out', artifactVersionIds: ['v_a', 'v_b', 'v_c'] },
        },
      ),
      outputText: 'alpha body',
    });
    wrap(<RunOutput session={session} heading={false} onOpenResults={onOpenResults} />);
    expect(screen.getByText('3 final results')).toBeInTheDocument();
    for (const name of ['report v1', 'summary v1', 'appendix v1']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    expect(onOpenResults.mock.calls.map((c) => c[0])).toEqual(['v_a', 'v_b', 'v_c']);
  });
});
