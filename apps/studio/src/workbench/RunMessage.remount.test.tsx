// @vitest-environment jsdom
import { emptyProjection, type RunProjection } from '@corral/core';
import { createRunSession } from '@corral/react';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };

// A conversation row the windowed timeline mounts again starts from what it last showed, but a
// body counts only when it was confirmed for the session's artifact metadata now
// (api-contract.md, 산출물 본문 수명), and a run that was still working is read again.

const fixture = vi.hoisted(() => ({
  live: null as ReturnType<typeof createRunSession> | null,
  read: null as { resolve(view: unknown): void; reject(error: unknown): void } | null,
  reads: 0,
  snapshots: 0,
}));
const services = vi.hoisted(() => ({
  transport: {
    getSnapshot: () => {
      fixture.snapshots++;
      return new Promise(() => {});
    },
    getArtifactText: () => new Promise(() => {}),
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
  fixture.snapshots = 0;
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

/** Mounts the row; `frames` holds the row's text and its kept height at every render. */
async function mount(props: { live?: boolean; version?: string }) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const frames: { text: string; minHeight: string; status: string | null }[] = [];
  const observer = new MutationObserver(() => frames.push(frame()));
  const frame = () => ({
    text: container.textContent ?? '',
    minHeight: container.querySelector<HTMLElement>('[style*="min-height"]')?.style.minHeight ?? '',
    status: container.querySelector('[data-presence-label="run:run"]')?.textContent ?? null,
  });
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  const unmount = async () => {
    observer.disconnect();
    await act(async () => root.unmount());
    container.remove();
  };
  disposals.push(unmount);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunMessage
          runId="run"
          sessionId="session"
          live={props.live ?? false}
          artifactMetadataVersion={props.version}
          onOpenArtifact={vi.fn()}
        />
      </IntlProvider>,
    ),
  );
  frames.unshift(frame());
  return {
    container,
    frames,
    first: () => frames[0],
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
async function shownThenAway(version: string, via: 'text' | 'turn' = 'text') {
  const row = await mount({ version });
  await act(async () =>
    fixture.read?.resolve({
      runId: 'run',
      projection: finished(true),
      definition: null,
      events: [],
      streams: {},
      artifactTexts: via === 'text' ? { result: BODY } : {},
      conversationTurn:
        via === 'turn' ? { runId: 'run', artifactVersionId: 'result', answer: BODY } : null,
      streamError: null,
    }),
  );
  expect(row.container.textContent).toContain(BODY);
  await row.unmount();
}

it.each(['text', 'turn'] as const)(
  'a body released while the row was away is in no render of its return (%s)',
  async (via) => {
    await shownThenAway('first_success', via);
    // A later run of the session succeeded: the metadata version moved on.
    const again = await mount({ version: 'second_success' });
    // The head and the tail come back at once; the body waits for a fresh check.
    expect(again.first()?.status).toBe(messages.Status.failed);
    expect(again.frames.every((frame) => !frame.text.includes(BODY))).toBe(true);
    // Meanwhile the row keeps the height it left with.
    expect(again.first()?.minHeight).toBe(`${ROW_HEIGHT}px`);
    // One snapshot read per mount: the record read, not a second metadata read beside it.
    expect({ reads: fixture.reads, snapshots: fixture.snapshots }).toEqual({
      reads: 2,
      snapshots: 0,
    });
    await act(async () =>
      fixture.read?.resolve({
        runId: 'run',
        projection: finished(false),
        definition: null,
        events: [],
        streams: {},
        artifactTexts: {},
        conversationTurn: null,
        streamError: null,
      }),
    );
    expect(again.frames.every((frame) => !frame.text.includes(BODY))).toBe(true);
    expect(again.container.textContent).toContain('no longer available');
    // Read again: the row lets go of the height it kept.
    expect(again.container.querySelector('[style*="min-height"]')).toBeNull();
  },
);

it('a body confirmed for the same metadata is there on the first render of its return', async () => {
  await shownThenAway('first_success');
  const again = await mount({ version: 'first_success' });
  expect(again.first()?.text).toContain(BODY);
  expect(fixture.snapshots).toBe(0);
});

it('a row that left while its run worked is read again, never drawn as still working', async () => {
  const running = emptyProjection('run');
  running.status = 'running';
  running.executionOrder = ['lead'];
  const first = await mount({ live: true });
  await act(async () => fixture.live?.setState({ runId: 'run', projection: running }));
  expect(first.container.querySelector('[data-presence-label="run:run"]')?.textContent).toBe(
    messages.Status.running,
  );
  await first.unmount();
  // The run ends while the row is away; the session now passes it as finished.
  const again = await mount({ version: 'v1' });
  expect(again.frames.every((frame) => frame.status !== messages.Status.running)).toBe(true);
  expect(again.first()?.minHeight).toBe(`${ROW_HEIGHT}px`);
  await act(async () =>
    fixture.read?.resolve({
      runId: 'run',
      projection: finished(true),
      definition: null,
      events: [],
      streams: {},
      artifactTexts: { result: BODY },
      conversationTurn: null,
      streamError: null,
    }),
  );
  expect(again.container.querySelector('[data-presence-label="run:run"]')?.textContent).toBe(
    messages.Status.failed,
  );
  expect(again.frames.every((frame) => frame.status !== messages.Status.running)).toBe(true);
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
