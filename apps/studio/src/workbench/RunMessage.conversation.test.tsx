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
vi.mock('./TurnProcess.tsx', () => ({ TurnProcess: () => null }));
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

async function show() {
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
          sessionId="session_chat"
          live={false}
          onOpenArtifact={vi.fn()}
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
  expect(container.textContent).not.toContain(messages.Results.openResults);
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
  expect(container.textContent).not.toContain(messages.Results.openResults);
  expect(store.getState().loadArtifact).not.toHaveBeenCalled();
});
