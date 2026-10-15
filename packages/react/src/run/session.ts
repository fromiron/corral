import type { CommandError, CorralDefinition, EventOf, Receipt, RunEvent } from '@corral/contracts';
import {
  applyEvent,
  emptyProjection,
  type RunProjection,
  type RuntimeTransport,
} from '@corral/core';
import { createStore, type StoreApi } from 'zustand/vanilla';

// Live view of one run. Everything shown comes from committed events or receipts: buttons
// show "sending" while a command is in flight, but status badges only change on server facts.

export interface RunSessionState {
  runId: string | null;
  /** The definition this run started from (labels for the run view). */
  definition: CorralDefinition | null;
  projection: RunProjection | null;
  /** Every committed event of the run, in order (Timeline, C-060). */
  events: RunEvent[];
  outputText: string | null;
  startError: CommandError | null;
  streamError: string | null;
  /** Set when `open` was asked for a run this runtime does not have. */
  missingRunId: string | null;
  pendingCommandIds: string[];
  receipts: Record<string, Receipt>;
  /** Starts a run; with `saved`, from that saved revision (the local server's way). */
  start(definition: CorralDefinition, saved?: SavedRevision): Promise<void>;
  /** Follows an existing run, such as after a reload or from a link. */
  open(runId: string): Promise<void>;
  steer(executionId: string, text: string): Promise<Receipt>;
  refreshReceipt(commandId: string): Promise<void>;
  dispose(): void;
}

export type RunSessionStore = StoreApi<RunSessionState>;

export interface SavedRevision {
  corralId: string;
  definitionRevision: number;
}

export function defaultCommandId(): string {
  return `cmd_${globalThis.crypto.randomUUID()}`;
}

export function createRunSession(
  transport: RuntimeTransport,
  newCommandId: () => string = defaultCommandId,
): RunSessionStore {
  let unsubscribe: (() => void) | null = null;

  const store = createStore<RunSessionState>((set, get) => {
    /**
     * Follows a run from its first event: one ordered stream builds both the projection and
     * the Timeline's event list. Events are applied in batches, so a long replay renders once.
     */
    const follow = async (runId: string) => {
      set({ projection: emptyProjection(runId), events: [] });
      let pending: RunEvent[] = [];
      let scheduled = false;
      const flush = () => {
        scheduled = false;
        const batch = pending;
        pending = [];
        if (get().runId !== runId) return;
        let projection = get().projection ?? emptyProjection(runId);
        for (const event of batch) projection = applyEvent(projection, event);
        set({ projection, events: [...get().events, ...batch] });
        const finalized = batch.find(
          (e): e is EventOf<'output.finalized'> => e.type === 'output.finalized',
        );
        if (finalized) void loadOutput(runId, finalized.payload.artifactVersionIds);
        if (batch.some((e) => e.type.startsWith('directive.'))) void refreshSteerReceipts();
      };
      unsubscribe = transport.subscribe(runId, 0, {
        onEvent: (event: RunEvent) => {
          pending.push(event);
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(flush);
          }
        },
        onError: (error) => set({ streamError: String(error) }),
      });
    };

    const reset = () => {
      unsubscribe?.();
      unsubscribe = null;
      set({
        runId: null,
        definition: null,
        projection: null,
        events: [],
        outputText: null,
        startError: null,
        streamError: null,
        missingRunId: null,
        receipts: {},
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
      events: [],
      outputText: null,
      startError: null,
      streamError: null,
      missingRunId: null,
      pendingCommandIds: [],
      receipts: {},

      async start(definition, saved) {
        reset();
        const commandId = newCommandId();
        const { runId, receipt } = await transport.startRun(
          saved
            ? { schemaVersion: '0.1', commandId, ...saved, mode: 'mock' }
            : { schemaVersion: '0.1', commandId, definition, mode: 'mock' },
        );
        if (!runId) {
          set({ startError: receipt.error ?? { code: 'SCHEMA_INVALID', message: 'run rejected' } });
          return;
        }
        set({ runId, definition });
        await follow(runId);
      },

      async open(runId) {
        if (get().runId === runId) return;
        reset();
        const definition = await transport.getRunDefinition(runId);
        if (!definition) {
          set({ missingRunId: runId });
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
