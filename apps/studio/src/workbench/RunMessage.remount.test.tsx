// @vitest-environment jsdom
import { emptyProjection, type RunProjection } from '@corral/core';
import { createRunSession } from '@corral/react';
import { act, type ReactNode, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };

// A conversation row the windowed timeline mounts again starts from what it last showed, but a
// body counts only when it was confirmed for the session's artifact metadata now
// (api-contract.md, 산출물 본문 수명), and a run that was still working is read again. A
// conversation turn's kept answer is not such a body.

type Deferred = { resolve(value: unknown): void; reject(error: unknown): void };
const fixture = vi.hoisted(() => ({
  live: null as ReturnType<typeof createRunSession> | null,
  read: null as Deferred | null,
  reads: 0,
  // Each metadata read and each body read, held until the test settles it.
  snapshots: [] as Deferred[],
  texts: [] as (Deferred & { id: string })[],
}));
const services = vi.hoisted(() => ({
  transport: {
    getSnapshot: () =>
      new Promise((resolve, reject) => {
        fixture.snapshots.push({ resolve, reject });
      }),
    getArtifactText: (_runId: string, id: string) =>
      new Promise((resolve, reject) => {
        fixture.texts.push({ id, resolve, reject });
      }),
    subscribe: () => () => {},
  },
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
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: boolean) => useState(initial),
}));
vi.mock('../pages/GettingStarted.tsx', () => ({ markRunReviewed() {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#link">{children}</a>,
}));
const { RunMessage } = await import('./RunMessage.tsx');

const BODY = 'Body the server may release';
const RECORDED = 'Recorded response words';
const INTERRUPTED = 'Interrupted partial words';
const ROW_HEIGHT = 180;
const disposals: (() => Promise<void>)[] = [];
Element.prototype.getAnimations ??= () => [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom lays nothing out: every row measures the same height.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    height: ROW_HEIGHT,
  } as DOMRect);
  fixture.live = createRunSession({} as never);
  fixture.reads = 0;
  fixture.snapshots = [];
  fixture.texts = [];
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function finished(bodyAvailable: boolean): RunProjection {
  const value = emptyProjection('run');
  value.status = 'failed';
  value.executionOrder = ['lead'];
  value.artifacts.result = {
    artifactVersionId: 'result',
    artifactId: 'answer',
    version: 1,
    parentVersionId: null,
    name: 'Answer',
    contract: 'text',
    contentHash: 'a'.repeat(64),
    byteLength: 13,
    authorExecutionId: 'lead',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
    bodyAvailable,
  } as RunProjection['artifacts'][string];
  value.output = { nodeId: 'output', artifactVersionIds: ['result'] };
  return value;
}

/** A failed run with no result whose one model response was recorded. */
function recordedWords(): RunProjection {
  const value = emptyProjection('run');
  value.status = 'failed';
  value.executionOrder = ['lead'];
  value.modelCalls.recorded = {
    modelCallId: 'recorded',
    executionId: 'lead',
    finished: true,
    responseRef: 'response_recorded',
  } as unknown as RunProjection['modelCalls'][string];
  return value;
}

/** A cancelled run with no result whose one model response never completed. */
function interruptedWords(): RunProjection {
  const value = emptyProjection('run');
  value.status = 'cancelled';
  value.executionOrder = ['lead'];
  value.modelCalls.partial = {
    modelCallId: 'partial',
    executionId: 'lead',
    finished: false,
    responseRef: null,
  } as unknown as RunProjection['modelCalls'][string];
  return value;
}

const TURN = { runId: 'run', artifactVersionId: 'result', answer: BODY };
const view = (projection: RunProjection, more: Record<string, unknown> = {}) => ({
  runId: 'run',
  projection,
  definition: null,
  events: [],
  streams: {},
  artifactTexts: {},
  conversationTurn: null,
  streamError: null,
  ...more,
});

type Frame = { text: string; minHeight: string; status: string | null };
const row = (version: string | undefined, live = false) => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    <RunMessage
      runId="run"
      sessionId="session"
      live={live}
      artifactMetadataVersion={version}
      onOpenArtifact={vi.fn()}
    />
  </IntlProvider>
);

/** Mounts the row; `frames` holds the row's text and its kept height at every render. */
async function mount(props: { live?: boolean; version?: string; strict?: boolean }) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const frames: Frame[] = [];
  const frame = (): Frame => ({
    text: container.textContent ?? '',
    minHeight: container.querySelector<HTMLElement>('[style*="min-height"]')?.style.minHeight ?? '',
    status: container.querySelector('[data-presence-label="run:run"]')?.textContent ?? null,
  });
  const observer = new MutationObserver(() => frames.push(frame()));
  observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  const unmount = async () => {
    observer.disconnect();
    await act(async () => root.unmount());
    container.remove();
  };
  disposals.push(unmount);
  const element = row(props.version, props.live);
  await act(async () => root.render(props.strict ? <StrictMode>{element}</StrictMode> : element));
  frames.unshift(frame());
  return {
    container,
    frames,
    first: () => frames[0],
    now: frame,
    render: (version: string) => act(async () => root.render(row(version, props.live))),
    unmount: async () => {
      disposals.splice(disposals.indexOf(unmount), 1);
      await unmount();
    },
  };
}

/**
 * The row read once with its body confirmed for `version`, then unmounted off screen. The body
 * comes as the result's text or as the conversation turn's kept answer.
 */
async function shownThenAway(version: string, via: 'text' | 'turn' = 'text', strict = false) {
  const row = await mount({ version, strict });
  await act(async () =>
    fixture.read?.resolve(
      view(finished(true), {
        artifactTexts: via === 'text' ? { result: BODY } : {},
        conversationTurn: via === 'turn' ? TURN : null,
      }),
    ),
  );
  expect(row.container.textContent).toContain(BODY);
  await row.unmount();
}
const withText = (frames: Frame[], words = BODY) =>
  frames.filter((frame) => frame.text.includes(words)).length;

it('a body released while the row was away is in no render of its return', async () => {
  await shownThenAway('first_success');
  // A later run of the session succeeded: the metadata version moved on.
  const again = await mount({ version: 'second_success' });
  // The head and the tail come back at once; the body waits for a fresh check.
  expect(again.first()?.status).toBe(messages.Status.failed);
  expect(withText(again.frames)).toBe(0);
  // Meanwhile the row keeps the height it left with.
  expect(again.first()?.minHeight).toBe(`${ROW_HEIGHT}px`);
  // One snapshot read per mount: the record read, not a second metadata read beside it.
  expect({ reads: fixture.reads, snapshots: fixture.snapshots.length }).toEqual({
    reads: 2,
    snapshots: 0,
  });
  await act(async () => fixture.read?.resolve(view(finished(false))));
  expect(withText(again.frames)).toBe(0);
  expect(again.container.textContent).toContain('no longer available');
  // Read again: the row lets go of the height it kept.
  expect(again.container.querySelector('[style*="min-height"]')).toBeNull();
});

// A conversation turn's answer is kept apart from the artifact bodies and is never released
// (api-contract.md, "일반 대화의 연속성은 산출물 보관과 분리한다").
it('a conversation turn’s kept answer is in every render of its return, whatever the version', async () => {
  await shownThenAway('first_success', 'turn');
  const again = await mount({ version: 'second_success' });
  expect(again.first()?.text).toContain(BODY);
  expect(again.first()?.text).not.toContain(messages.Artifact.loading);
  await act(async () => fixture.read?.resolve(view(finished(false), { conversationTurn: TURN })));
  expect(again.frames.every((frame) => frame.text.includes(BODY))).toBe(true);
  expect(again.frames.every((frame) => !frame.text.includes(messages.Artifact.loading))).toBe(true);
  // The answer is the turn's: no artifact body is asked for in its place.
  expect(fixture.texts).toEqual([]);
});

it('a body unconfirmed when the row left is not remembered as confirmed for the new version', async () => {
  // Mounted at v1 with its body, the session moves on to v2 before the row's metadata read
  // lands, and the row leaves and returns at v2.
  const first = await mount({ version: 'v1' });
  await act(async () =>
    fixture.read?.resolve(view(finished(true), { artifactTexts: { result: BODY } })),
  );
  expect(first.now().text).toContain(BODY);
  await first.render('v2');
  expect(first.now().text).not.toContain(BODY);
  await first.unmount();
  const again = await mount({ version: 'v2' });
  expect(withText(again.frames)).toBe(0);
});

it('recorded response words are in no render of a return at another version', async () => {
  const first = await mount({ version: 'v1' });
  await act(async () =>
    fixture.read?.resolve(
      view(recordedWords(), {
        streams: { recorded: { text: RECORDED, next: 1, broken: false, completed: true } },
      }),
    ),
  );
  expect(first.now().text).toContain(RECORDED);
  await first.unmount();
  const again = await mount({ version: 'v2' });
  expect(withText(again.frames, RECORDED)).toBe(0);
});

it('interrupted words, never released, are in the first render of a return at another version', async () => {
  const first = await mount({ version: 'v1' });
  const stream = { partial: { text: INTERRUPTED, next: 1, broken: false, partial: true } };
  await act(async () => fixture.read?.resolve(view(interruptedWords(), { streams: stream })));
  await first.unmount();
  const again = await mount({ version: 'v2' });
  expect(again.first()?.text).toContain(INTERRUPTED);
  await act(async () => fixture.read?.resolve(view(interruptedWords(), { streams: stream })));
  expect(again.now().text).toContain(INTERRUPTED);
});

/** A run that went on after an interrupt cut its first response, and ended. */
function cutThenEnded(): RunProjection {
  const value = emptyProjection('run');
  value.status = 'succeeded';
  value.executionOrder = ['lead'];
  value.modelCalls.cut = {
    modelCallId: 'cut',
    executionId: 'lead',
    finished: true,
    responseRef: null,
    interrupted: true,
  } as unknown as RunProjection['modelCalls'][string];
  return value;
}

// The words an interrupt cut are never a released body (workbench.md, 대화 본문과 중단된 출력):
// read from the snapshot's partial outputs, they stay in every render while the session's
// metadata moves on (the next run succeeding), with the row mounted all along.
it('words an interrupt cut stay in every render as the metadata moves on under a mounted row', async () => {
  const row = await mount({ version: 'v1' });
  const stream = { cut: { text: INTERRUPTED, next: 1, broken: false, partial: true } };
  await act(async () => fixture.read?.resolve(view(cutThenEnded(), { streams: stream })));
  const stopped = () => row.container.querySelector('[data-testid="stopped-text"]');
  expect(stopped()?.textContent).toContain(INTERRUPTED);
  const from = row.frames.length;
  await row.render('v2');
  // The metadata read for the new version: the cut call still has no recorded response.
  await act(async () => fixture.snapshots.at(-1)?.resolve({ projection: cutThenEnded(), seq: 9 }));
  expect(stopped()?.textContent).toContain(INTERRUPTED);
  expect(row.frames.slice(from).every((frame) => frame.text.includes(INTERRUPTED))).toBe(true);
  // Away and back at the new version: the same words, from the first render.
  await row.unmount();
  const again = await mount({ version: 'v2' });
  expect(again.first()?.text).toContain(INTERRUPTED);
  await act(async () => fixture.read?.resolve(view(cutThenEnded(), { streams: stream })));
  expect(again.frames.every((frame) => frame.text.includes(INTERRUPTED))).toBe(true);
});

it('a body still readable keeps the row at its height until its text is in', async () => {
  await shownThenAway('first_success');
  const again = await mount({ version: 'second_success' });
  await act(async () => fixture.read?.resolve(view(finished(true))));
  expect(fixture.texts.map((text) => text.id)).toEqual(['result']);
  expect(again.now().minHeight).toBe(`${ROW_HEIGHT}px`);
  await act(async () => fixture.texts.at(-1)?.resolve(BODY));
  expect(again.now().text).toContain(BODY);
  expect(again.now().minHeight).toBe('');
});

it('a body text that cannot be read lets the height go', async () => {
  await shownThenAway('first_success');
  const again = await mount({ version: 'second_success' });
  await act(async () => fixture.read?.resolve(view(finished(true))));
  await act(async () => fixture.texts.at(-1)?.reject(new Error('gone')));
  expect(again.now().minHeight).toBe('');
});

it('a body confirmed for the same metadata is there on the first render of its return', async () => {
  await shownThenAway('first_success');
  const again = await mount({ version: 'first_success' });
  expect(again.first()?.text).toContain(BODY);
  expect(fixture.snapshots).toHaveLength(0);
});

it('in StrictMode no body is shown or asked for before its version is confirmed', async () => {
  await shownThenAway('first_success', 'text', true);
  const again = await mount({ version: 'second_success', strict: true });
  expect(withText(again.frames)).toBe(0);
  expect(fixture.texts).toEqual([]);
  await act(async () => fixture.read?.resolve(view(finished(false))));
  expect(withText(again.frames)).toBe(0);
  expect(fixture.texts).toEqual([]);
});

it('a row that left while its run worked is read again, never drawn as still working', async () => {
  const running = emptyProjection('run');
  running.status = 'running';
  running.executionOrder = ['lead'];
  const first = await mount({ live: true });
  await act(async () => fixture.live?.setState({ runId: 'run', projection: running }));
  expect(first.container.querySelector('[data-presence-label="run:run"]')?.textContent).toBe(
    messages.Presence.state.working,
  );
  await first.unmount();
  // The run ends while the row is away; the session now passes it as finished.
  const again = await mount({ version: 'v1' });
  expect(again.frames.every((frame) => frame.status !== messages.Presence.state.working)).toBe(
    true,
  );
  expect(again.first()?.minHeight).toBe(`${ROW_HEIGHT}px`);
  await act(async () =>
    fixture.read?.resolve(view(finished(true), { artifactTexts: { result: BODY } })),
  );
  expect(again.container.querySelector('[data-presence-label="run:run"]')?.textContent).toBe(
    messages.Status.failed,
  );
  expect(again.frames.every((frame) => frame.status !== messages.Presence.state.working)).toBe(
    true,
  );
});

it('a failed read keeps the remembered view and shows the error beside it', async () => {
  await shownThenAway('first_success');
  const again = await mount({ version: 'first_success' });
  await act(async () => fixture.read?.reject(new Error('The record could not be read')));
  expect(again.container.querySelector('[data-presence-label="run:run"]')?.textContent).toBe(
    messages.Status.failed,
  );
  expect(again.container.textContent).toContain(BODY);
  expect(again.container.textContent).toContain('The record could not be read');
  expect(again.container.querySelector('[style*="min-height"]')).toBeNull();
});

describe('a failed record read at another version', () => {
  const READ_ERROR = 'The record could not be read';
  async function failedRead() {
    await shownThenAway('first_success');
    const again = await mount({ version: 'second_success' });
    await act(async () => fixture.read?.reject(new Error(READ_ERROR)));
    expect(again.now().text).toContain(READ_ERROR);
    // The metadata is read on its own after the record read failed.
    expect(fixture.snapshots).toHaveLength(1);
    return again;
  }

  it('reads the record once more when the metadata read succeeds, and keeps the error if that fails', async () => {
    const again = await failedRead();
    const reads = fixture.reads;
    await act(async () => fixture.snapshots[0]?.resolve({ projection: finished(false), seq: 9 }));
    expect(fixture.reads).toBe(reads + 1);
    // What was not read again is not said to be gone while the record read is out.
    expect(again.now().text).toContain(READ_ERROR);
    await act(async () => fixture.read?.reject(new Error(READ_ERROR)));
    expect(again.now().text).toContain(READ_ERROR);
    expect(fixture.reads).toBe(reads + 1);
    expect(withText(again.frames)).toBe(0);
  });

  it('clears the error once the second record read succeeds', async () => {
    const again = await failedRead();
    await act(async () => fixture.snapshots[0]?.resolve({ projection: finished(false), seq: 9 }));
    await act(async () => fixture.read?.resolve(view(finished(false))));
    expect(again.now().text).not.toContain(READ_ERROR);
    expect(again.now().text).toContain('no longer available');
    expect(withText(again.frames)).toBe(0);
  });

  it('shows the error alone, with no loading words, when every read failed', async () => {
    const again = await failedRead();
    await act(async () => fixture.snapshots[0]?.reject(new Error('Failed to fetch')));
    expect(again.now().text).toContain('Failed to fetch');
    expect(again.now().text).not.toContain(messages.Artifact.loading);
    expect(again.now().minHeight).toBe('');
    expect(withText(again.frames)).toBe(0);
  });
});
