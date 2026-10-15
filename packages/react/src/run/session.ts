import type { CommandError, CorralDefinition, Receipt, RunEvent } from '@corral/contracts';
import { applyEvent, type RunProjection, type RuntimeTransport } from '@corral/core';
import { createStore, type StoreApi } from 'zustand/vanilla';

// Live view of one run. Everything shown comes from committed events or receipts: buttons
// show "sending" while a command is in flight, but status badges only change on server facts.

export interface RunSessionState {
  runId: string | null;
  /** The definition this run started from (labels for the run view). */
  definition: CorralDefinition | null;
  projection: RunProjection | null;
  outputText: string | null;
  startError: CommandError | null;
  streamError: string | null;
  pendingCommandIds: string[];
  receipts: Record<string, Receipt>;
  start(definition: CorralDefinition): Promise<void>;
  steer(executionId: string, text: string): Promise<Receipt>;
  refreshReceipt(commandId: string): Promise<void>;
  dispose(): void;
}

export type RunSessionStore = StoreApi<RunSessionState>;

export function defaultCommandId(): string {
  return `cmd_${globalThis.crypto.randomUUID()}`;
}

export function createRunSession(
  transport: RuntimeTransport,
  newCommandId: () => string = defaultCommandId,
): RunSessionStore {
  let unsubscribe: (() => void) | null = null;

  const store = createStore<RunSessionState>((set, get) => {
    const follow = async (runId: string) => {
      const snapshot = await transport.getSnapshot(runId);
      set({ projection: snapshot.projection });
      unsubscribe = transport.subscribe(runId, snapshot.seq, {
        onEvent: (event: RunEvent) => {
          const current = get().projection;
          if (!current) return;
          const projection = applyEvent(current, event);
          set({ projection });
          if (event.type === 'output.finalized')
            void loadOutput(runId, event.payload.artifactVersionIds);
          if (event.type.startsWith('directive.')) void refreshSteerReceipts();
        },
        onError: (error) => set({ streamError: String(error) }),
      });
    };

    const loadOutput = async (runId: string, versionIds: string[]) => {
      const [first] = versionIds;
      if (!first) return;
      set({ outputText: await transport.getArtifactText(runId, first) });
    };

    const refreshSteerReceipts = async () => {
      for (const receipt of Object.values(get().receipts)) {
        if (receipt.status === 'queued') await get().refreshReceipt(receipt.commandId);
      }
    };

    return {
      runId: null,
      definition: null,
      projection: null,
      outputText: null,
      startError: null,
      streamError: null,
      pendingCommandIds: [],
      receipts: {},

      async start(definition) {
        unsubscribe?.();
        set({
          runId: null,
          definition: null,
          projection: null,
          outputText: null,
          startError: null,
          receipts: {},
        });
        const { runId, receipt } = await transport.startRun({
          schemaVersion: '0.1',
          commandId: newCommandId(),
          definition,
          mode: 'mock',
        });
        if (!runId) {
          set({ startError: receipt.error ?? { code: 'SCHEMA_INVALID', message: 'run rejected' } });
          return;
        }
        set({ runId, definition });
        await follow(runId);
      },

      async steer(executionId, text) {
        const runId = get().runId;
        if (!runId) throw new Error('no active run');
        const commandId = newCommandId();
        set({ pendingCommandIds: [...get().pendingCommandIds, commandId] });
        try {
          const receipt = await transport.sendCommand({
            schemaVersion: '0.1',
            commandId,
            runId,
            type: 'steer',
            payload: { targetExecutionId: executionId, text, delivery: 'next_request' },
          });
          set({ receipts: { ...get().receipts, [commandId]: receipt } });
          return receipt;
        } finally {
          set({ pendingCommandIds: get().pendingCommandIds.filter((id) => id !== commandId) });
        }
      },

      async refreshReceipt(commandId) {
        const runId = get().runId;
        if (!runId) return;
        const receipt = await transport.getReceipt(runId, commandId);
        if (receipt) set({ receipts: { ...get().receipts, [commandId]: receipt } });
      },

      dispose() {
        unsubscribe?.();
        unsubscribe = null;
      },
    };
  });
  return store;
}
