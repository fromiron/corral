import type { Receipt } from '@corral/contracts';
import { emptyProjection, type RunProjection } from '@corral/core';
import { ReactFlowProvider } from '@xyflow/react';
import type { ReactNode } from 'react';
import { createStore } from 'zustand/vanilla';
import { StudioStoresProvider } from '../context.tsx';
import { addNode, connect, type EditorDraft, emptyDraft } from '../editor/model.ts';
import { createEditorStore } from '../editor/store.ts';
import type { RunSessionState, RunSessionStore } from '../run/session.ts';

// Story-only builders. Stories render real components against fixed store states.

export function agentToOutputDraft(): EditorDraft {
  const agent = addNode(emptyDraft(), 'agent', { x: 40, y: 80 });
  const output = addNode(agent.draft, 'output', { x: 320, y: 80 });
  const connected = connect(output.draft, agent.nodeId, output.nodeId);
  return connected.ok ? connected.draft : output.draft;
}

export function sessionStore(state: Partial<RunSessionState> = {}): RunSessionStore {
  const noop = async () => {};
  return createStore<RunSessionState>(() => ({
    runId: null,
    projection: null,
    outputText: null,
    startError: null,
    streamError: null,
    pendingCommandIds: [],
    receipts: {},
    start: noop,
    steer: async () => ({}) as Receipt,
    refreshReceipt: noop,
    dispose: () => {},
    ...state,
  }));
}

export function projectionWith(change: Partial<RunProjection>): RunProjection {
  return { ...emptyProjection('run_story'), status: 'running', ...change };
}

export function StudioFrame({
  draft = emptyDraft(),
  session = sessionStore(),
  children,
}: {
  draft?: EditorDraft;
  session?: RunSessionStore;
  children: ReactNode;
}) {
  return (
    <StudioStoresProvider editor={createEditorStore(draft)} session={session}>
      <ReactFlowProvider>{children}</ReactFlowProvider>
    </StudioStoresProvider>
  );
}
