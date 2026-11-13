// @vitest-environment jsdom
import { emptyProjection, type StoredConversationTurn } from '@corral/core';
import type { RunSessionStore } from '@corral/react';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../packages/react/src/stories/fixtures.tsx';
import { changePreferences, preferences } from './preferences.ts';
import { RunMessage } from './RunMessage.tsx';

const fixture = vi.hoisted(() => ({
  store: null as RunSessionStore | null,
  turn: null as StoredConversationTurn | null,
  metadataCurrent: true,
}));
vi.mock('./useCorralChat.ts', () => ({
  useCorralRun: () => ({
    store: fixture.store,
    state: useStore(fixture.store as RunSessionStore),
    conversationTurn: fixture.turn,
    bodyMetadataCurrent: fixture.metadataCurrent,
  }),
}));
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: boolean) => useState(initial),
}));
vi.mock('../pages/GettingStarted.tsx', () => ({ markRunReviewed() {} }));
vi.mock('./MessageBranch.tsx', () => ({
  MessageBranch: () => <button type="button">Restore artifact branch</button>,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#result">{children}</a>,
}));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // The turn's head and its work log measure their panel.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  fixture.metadataCurrent = true;
  const projection = emptyProjection('run_chat');
  projection.status = 'succeeded';
  projection.artifacts.primary = {
    artifactVersionId: 'primary',
    artifactId: 'answer',
    version: 1,
    parentVersionId: null,
    name: 'Answer',
    contract: 'text',
    contentHash: 'a'.repeat(64),
    byteLength: 10,
    authorExecutionId: 'exec',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
    bodyAvailable: false,
  };
  projection.output = { nodeId: 'output', artifactVersionIds: ['primary'] };
  fixture.store = sessionStore({
    runId: 'run_chat',
    projection,
    artifactTexts: { primary: 'Old artifact cache must not be used' },
    loadArtifact: vi.fn(async () => {}),
  });
  fixture.turn = {
    runId: 'run_chat',
    request: 'Original question',
    answer: 'Preserved ordinary answer',
    status: 'succeeded',
    artifactVersionId: 'primary',
  };
});

async function show(endActions?: ReactNode, sessionId: string | null = 'session_chat') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const dispose = () => {
    root.unmount();
    container.remove();
  };
  cleanup.push(dispose);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunMessage
          runId="run_chat"
          sessionId={sessionId}
          live={false}
          onOpenArtifact={vi.fn()}
          endActions={endActions}
        />
      </IntlProvider>,
    ),
  );
  return container;
}

it('renders the retained ordinary answer without reading or reinstalling a released artifact', async () => {
  const container = await show();
  expect(container.textContent).toContain('Preserved ordinary answer');
  expect(container.textContent).not.toContain('Old artifact cache must not be used');
  expect(fixture.store?.getState().loadArtifact).not.toHaveBeenCalled();
  expect(fixture.store?.getState().artifactTexts.primary).not.toBe('Preserved ordinary answer');
  expect(container.textContent).not.toContain('Restore artifact branch');
  expect(container.querySelector(`[aria-label="${messages.Results.openResults}"]`)).toBeNull();
});

it.each(['run', 'artifact'])('does not use a different %s as the answer fallback', async (kind) => {
  if (!fixture.turn) throw new Error('fixture conversation missing');
  fixture.turn = {
    ...fixture.turn,
    ...(kind === 'run' ? { runId: 'other_run' } : { artifactVersionId: 'other_artifact' }),
  };
  const container = await show();
  expect(container.textContent).not.toContain('Preserved ordinary answer');
  expect(container.textContent).not.toContain('Old artifact cache must not be used');
  expect(container.textContent).toContain(messages.Artifact.retired);
});

it('keeps a running reply separate from any previously read conversation answer', async () => {
  const store = fixture.store;
  const projection = store?.getState().projection;
  if (!store || !projection) throw new Error('fixture run missing');
  store.setState({
    projection: { ...projection, status: 'running', output: null },
    streams: {
      current: { text: 'Still writing this response', next: 1, broken: false, completed: false },
    },
  });
  const container = await show();
  expect(container.textContent).toContain('Still writing this response');
  expect(container.textContent).not.toContain('Preserved ordinary answer');
});

it('keeps the canonical answer but hides a stale result link while metadata is being refreshed', async () => {
  const store = fixture.store;
  const projection = store?.getState().projection;
  const artifact = projection?.artifacts.primary;
  if (!store || !projection || !artifact) throw new Error('fixture missing');
  store.setState({
    projection: { ...projection, artifacts: { primary: { ...artifact, bodyAvailable: true } } },
  });
  fixture.metadataCurrent = false;
  const container = await show();
  expect(container.textContent).toContain('Preserved ordinary answer');
  expect(container.querySelector(`[aria-label="${messages.Results.openResults}"]`)).toBeNull();
  expect(store.getState().loadArtifact).not.toHaveBeenCalled();
});

it('a failed turn says so once, with its readable cause and the next action', async () => {
  const store = fixture.store;
  const projection = store?.getState().projection;
  if (!store || !projection) throw new Error('fixture run missing');
  fixture.turn = null;
  store.setState({
    projection: {
      ...projection,
      status: 'failed',
      output: null,
      artifacts: {},
      executionOrder: ['exec'],
      executions: {
        exec: {
          executionId: 'exec',
          nodeId: 'lead',
          status: 'failed',
          modelCallIds: [],
          waitingOn: null,
          error: 'the model request failed: RATE_LIMIT',
        } as unknown as (typeof projection.executions)[string],
      },
    },
  });
  const container = await show(<button type="button">Retry request</button>);
  // The state is the head's word; the cause and the next action close the body, on no banner.
  expect(container.querySelector('[data-testid="run-ended"]')).toBeNull();
  const state = container.querySelectorAll('[data-presence-label="run:run_chat"]');
  expect(state).toHaveLength(1);
  expect(state[0]?.closest('[data-chat-part="head"]')).not.toBeNull();
  expect(state[0]?.textContent).toBe(messages.Status.failed);
  const notice = container.querySelector<HTMLElement>('[data-testid="turn-end"]');
  expect(notice).not.toBeNull();
  expect(notice?.closest('[data-chat-part="body"]')?.lastElementChild).toBe(notice);
  // The cause a person can act on is in the notice itself, not only under diagnostics.
  expect(notice?.textContent).toContain(messages.Failure.provider.RATE_LIMIT);
  expect(notice?.textContent).toContain(messages.Failure.recovery.RATE_LIMIT);
  expect(notice?.querySelector('details')?.open).toBe(false);
  // The next action sits with it, and nothing else in the turn repeats the state.
  expect(notice?.querySelector('button')?.textContent).toBe('Retry request');
  expect(container.querySelectorAll('button')).toHaveLength(1);
  expect((container.textContent ?? '').match(/Failed/g)).toHaveLength(1);
  expect(container.querySelector('[data-testid="team-activity"]')).toBeNull();
  // It made nothing, so its tail counts no results.
  expect(container.querySelector('[data-chat-part="tail"]')?.textContent).toBe('');
});

it('a cancelled turn says so in its head and counts what it made in its tail', async () => {
  const store = fixture.store;
  const projection = store?.getState().projection;
  if (!store || !projection) throw new Error('fixture run missing');
  fixture.turn = null;
  store.setState({ projection: { ...projection, status: 'cancelled', output: null } });
  const container = await show();
  expect(container.querySelector('[data-testid="run-ended"]')).toBeNull();
  expect(
    container.querySelector('[data-chat-part="head"] [data-presence-label="run:run_chat"]')
      ?.textContent,
  ).toBe(messages.Status.cancelled);
  expect(container.querySelector('[data-chat-part="tail"]')?.textContent).toBe('1 result');
  // No sentence repeats what the tail counts.
  expect(container.querySelector('[data-testid="run-made-results"]')).toBeNull();
});

it('keeps a capped streaming reply at its own end while the reply grows', async () => {
  const store = fixture.store;
  const projection = store?.getState().projection;
  if (!store || !projection) throw new Error('fixture run missing');
  const previous = preferences.getState().chatDensity;
  changePreferences({ chatDensity: 'basic' });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  try {
    fixture.turn = null;
    const stream = (text: string) => ({
      text,
      next: text.length,
      broken: false,
      completed: false,
    });
    store.setState({
      projection: { ...projection, status: 'running', output: null },
      streams: { current: stream('Hi') },
    });
    const container = await show(undefined, null);
    const scroller = container.querySelector<HTMLElement>('[data-testid="live-text"] .max-h-40');
    if (!scroller) throw new Error('Streaming reply missing');
    const metrics = { height: 400, client: 160 };
    let top = 0;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => metrics.height },
      clientHeight: { configurable: true, get: () => metrics.client },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, metrics.height - metrics.client));
        },
      },
    });
    await act(async () => {
      store.setState({ streams: { current: stream('Hi and more text that keeps going') } });
    });
    expect(top).toBe(metrics.height - metrics.client);
    // A measurement dips the box. Following puts the end back.
    top = top - 30;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(top).toBe(metrics.height - metrics.client);
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -40 }));
      top = 12;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    metrics.height += 80;
    await act(async () => {
      store.setState({
        streams: { current: stream('Hi and more text that keeps going and the person is reading') },
      });
    });
    expect(top).toBe(12);
    // Back at the end, dragging the box's own scrollbar up leaves it there too.
    top = metrics.height - metrics.client;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(async () => {
      scroller.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      top = 20;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      document.body.dispatchEvent(new Event('pointerup', { bubbles: true }));
    });
    expect(top).toBe(20);
    metrics.height += 60;
    await act(async () => {
      store.setState({
        streams: {
          current: stream('Hi and more text that keeps going and the person is reading on'),
        },
      });
    });
    expect(top).toBe(20);
    // Back at the end, an upward key inside the box leaves it there too.
    top = metrics.height - metrics.client;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(async () => {
      scroller.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' }));
      top = 40;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(top).toBe(40);
  } finally {
    changePreferences({ chatDensity: previous });
  }
});
