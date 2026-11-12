// @vitest-environment jsdom
import { emptyProjection } from '@corral/core';
import { createRunSession } from '@corral/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  live: null as ReturnType<typeof createRunSession> | null,
  read: null as { resolve(view: unknown): void; reject(error: unknown): void } | null,
  reads: 0,
}));
const services = vi.hoisted(() => ({
  transport: { getSnapshot: vi.fn(), getArtifactText: vi.fn(), subscribe: vi.fn() },
  readHistory: async () => null,
  runFor: () => fixture.live,
  retainRun: () => () => {},
}));
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('./readRunView.ts', () => ({
  readRunView: () => {
    fixture.reads++;
    return new Promise((resolve, reject) => {
      fixture.read = { resolve, reject };
    });
  },
}));
const { useCorralRun } = await import('./useCorralChat.ts');

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

function projection(runId: string, status: 'running' | 'succeeded') {
  const value = emptyProjection(runId);
  value.status = status;
  return value;
}

function resultProjection(bodyAvailable: boolean) {
  const value = projection('run', 'succeeded');
  value.artifacts.result = {
    artifactVersionId: 'result',
    artifactId: 'answer',
    version: 1,
    parentVersionId: null,
    name: 'Answer',
    contract: 'text',
    contentHash: 'a'.repeat(64),
    byteLength: 13,
    authorExecutionId: 'exec',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
    bodyAvailable,
  };
  value.output = { nodeId: 'output', artifactVersionIds: ['result'] };
  return value;
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.live = createRunSession({} as never);
  fixture.reads = 0;
  services.transport.getSnapshot.mockReset();
  services.transport.getArtifactText.mockClear();
  services.transport.subscribe.mockClear();
  const seen: {
    runId: string;
    status: string | null;
    error: string | null;
    texts?: Record<string, string>;
    answer?: string | null;
    metadataCurrent?: boolean;
    bodyAvailable?: boolean;
  }[] = [];
  function Probe({
    runId,
    live,
    metadataVersion,
  }: {
    runId: string;
    live: boolean;
    metadataVersion?: string;
  }) {
    const { state, conversationTurn, bodyMetadataCurrent } = useCorralRun(
      runId,
      live,
      false,
      metadataVersion,
    );
    seen.push({
      runId,
      status: state.projection?.status ?? null,
      error: state.streamError ?? null,
      ...(conversationTurn ? { answer: conversationTurn.answer } : {}),
      ...(metadataVersion !== undefined
        ? {
            metadataCurrent: bodyMetadataCurrent,
            bodyAvailable: state.projection?.artifacts.result?.bodyAvailable,
          }
        : {}),
      ...(Object.keys(state.artifactTexts).length ? { texts: state.artifactTexts } : {}),
    });
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  disposals.push(async () => act(async () => root.unmount()));
  const render = (runId: string, live: boolean, metadataVersion?: string) =>
    act(async () =>
      root.render(<Probe runId={runId} live={live} metadataVersion={metadataVersion} />),
    );
  await render('run', true);
  await act(async () =>
    fixture.live?.setState({ runId: 'run', projection: projection('run', 'running') }),
  );
  return { seen, render, latest: () => seen.at(-1) };
}

it('a finishing turn keeps its live view until the finished view loads', async () => {
  const f = await mount();
  expect(f.latest()?.status).toBe('running');
  const loaded = f.seen.length;
  await f.render('run', false);
  // No render between the live and finished views may drop the projection (that remounts the log).
  expect(f.seen.slice(loaded).filter((entry) => entry.status === null)).toEqual([]);
  expect(f.latest()?.status).toBe('running');
  await act(async () =>
    fixture.read?.resolve({ runId: 'run', projection: projection('run', 'succeeded') }),
  );
  expect(f.seen.slice(loaded).filter((entry) => entry.status === null)).toEqual([]);
  expect(f.latest()?.status).toBe('succeeded');
});

it('a failed finished read shows its error instead of the kept live view', async () => {
  const f = await mount();
  await f.render('run', false);
  await act(async () => fixture.read?.reject(new Error('read failed')));
  expect(f.latest()).toEqual({ runId: 'run', status: null, error: 'read failed' });
});

it('a row mounted again shows what it last showed on its first render, then reads again', async () => {
  const f = await mount();
  await f.render('run', false);
  await act(async () =>
    fixture.read?.resolve({
      runId: 'run',
      projection: resultProjection(true),
      artifactTexts: { result: 'Loaded answer' },
      conversationTurn: { runId: 'run', answer: 'Kept answer' },
    }),
  );
  expect(f.latest()).toMatchObject({ status: 'succeeded', answer: 'Kept answer' });
  // The timeline unmounts the row off screen, then mounts it again.
  await disposals.splice(0)[0]?.();
  const first: { status: string | null; texts: Record<string, string>; answer: string | null }[] =
    [];
  function Again() {
    const { state, conversationTurn } = useCorralRun('run', false, false);
    first.push({
      status: state.projection?.status ?? null,
      texts: state.artifactTexts,
      answer: conversationTurn?.answer ?? null,
    });
    return null;
  }
  const reads = fixture.reads;
  const root = createRoot(document.createElement('div'));
  disposals.push(async () => act(async () => root.unmount()));
  await act(async () => root.render(<Again />));
  expect(first[0]).toEqual({
    status: 'succeeded',
    texts: { result: 'Loaded answer' },
    answer: 'Kept answer',
  });
  expect(fixture.reads).toBe(reads + 1);
});

it('another run never shows the previous run as its own', async () => {
  const f = await mount();
  await f.render('other', false);
  expect(f.latest()).toEqual({ runId: 'other', status: null, error: null });
});

it('the finished view keeps result texts the live view already loaded', async () => {
  const f = await mount();
  await act(async () => fixture.live?.setState({ artifactTexts: { result: 'Loaded answer' } }));
  await f.render('run', false);
  await act(async () =>
    fixture.read?.resolve({
      runId: 'run',
      projection: resultProjection(true),
      artifactTexts: {},
    }),
  );
  expect(f.latest()?.status).toBe('succeeded');
  expect(f.latest()?.texts).toEqual({ result: 'Loaded answer' });
});

it('a finished snapshot discards released live bodies even when its ordinary answer is retained', async () => {
  const f = await mount();
  await act(async () =>
    fixture.live?.setState({ artifactTexts: { result: 'Released artifact answer' } }),
  );
  await f.render('run', false);
  await act(async () =>
    fixture.read?.resolve({
      runId: 'run',
      projection: resultProjection(false),
      artifactTexts: {},
      conversationTurn: {
        runId: 'run',
        request: 'Question',
        answer: 'Ordinary answer',
        status: 'succeeded',
        artifactVersionId: 'result',
      },
    }),
  );
  expect(f.latest()?.status).toBe('succeeded');
  expect(f.latest()?.texts).toBeUndefined();
});

it('refreshes only eligibility metadata after a sibling success, preserving the answer and command owner', async () => {
  const f = await mount();
  await act(async () =>
    fixture.live?.setState({
      artifactTexts: { result: 'Cached artifact body' },
      pendingCommandIds: ['owned_command'],
    }),
  );
  await f.render('run', false, 'first_success');
  await act(async () =>
    fixture.read?.resolve({
      runId: 'run',
      projection: resultProjection(true),
      artifactTexts: {},
      conversationTurn: {
        runId: 'run',
        request: 'Question',
        answer: 'Ordinary answer',
        status: 'succeeded',
        artifactVersionId: 'result',
      },
    }),
  );
  expect(f.latest()?.bodyAvailable).toBe(true);
  expect(f.latest()?.texts).toEqual({ result: 'Cached artifact body' });
  const reads = fixture.reads;
  let resolve!: (snapshot: unknown) => void;
  services.transport.getSnapshot.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.render('run', false, 'second_success');
  expect(services.transport.getSnapshot).toHaveBeenCalledExactlyOnceWith('run');
  expect(f.latest()?.metadataCurrent).toBe(false);
  expect(f.latest()?.answer).toBe('Ordinary answer');
  await act(async () => resolve({ projection: resultProjection(false), seq: 5 }));
  expect(f.latest()).toMatchObject({
    runId: 'run',
    status: 'succeeded',
    bodyAvailable: false,
    metadataCurrent: true,
    answer: 'Ordinary answer',
  });
  expect(f.latest()?.texts).toBeUndefined();
  expect(fixture.reads).toBe(reads);
  expect(services.transport.getArtifactText).not.toHaveBeenCalled();
  expect(services.transport.subscribe).not.toHaveBeenCalled();
  expect(fixture.live?.getState().pendingCommandIds).toEqual(['owned_command']);
});
