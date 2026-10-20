import type { RoleRunOverrides } from '@corral/contracts';
import {
  type CommandError,
  type CorralDefinition,
  type EventOf,
  type HarnessOverrides,
  type Receipt,
  type RunCommand,
  type RunEvent,
  type StartFrom,
  type StreamFrame,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import {
  applyEvent,
  canonicalJson,
  emptyProjection,
  type RunProjection,
  type RuntimeTransport,
} from '@corral/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { RunRecovery } from './recovery.ts';

// Live view of one run. Everything shown comes from committed events or receipts: buttons
// show "sending" while a command is in flight, but status badges only change on server facts.

export interface RunSessionState {
  runId: string | null;
  /** The definition this run started from (labels for the run view). */
  definition: CorralDefinition | null;
  definitionError: string | null;
  projection: RunProjection | null;
  /** Every committed event of the run, in order (Timeline, C-060). */
  events: RunEvent[];
  /**
   * Text of model calls while they stream (C-018). Never a fact: a gap stops a call's text
   * (`broken`), and the committed output replaces it (Technical-Design §12).
   */
  streams: Record<string, StreamText>;
  /** Artifact bodies loaded for viewing, by version id (immutable once loaded). */
  artifactTexts: Record<string, string>;
  outputText: string | null;
  startError: CommandError | null;
  streamError: string | null;
  /** Set when `open` was asked for a run this runtime does not have. */
  missingRunId: string | null;
  pendingCommandIds: string[];
  receipts: Record<string, Receipt>;
  commandError: string | null;
  /** Lost responses retain their exact command across run navigation for safe recovery. */
  unconfirmedCommands: Record<string, { command: RunCommand; error: string }>;
  sendCommand(command: SessionCommand): Promise<Receipt>;
  retryCommand(commandId: string): Promise<Receipt>;
  /** Starts a run; with `saved`, from that saved revision (the local server's way). */
  /** `startFrom`: an earlier version whose text the new run's brief starts from (CR-007). */
  start(
    definition: CorralDefinition,
    saved?: SavedRevision,
    mode?: 'mock' | 'live',
    startFrom?: StartFrom,
    harnessOverrides?: HarnessOverrides,
    roleOverrides?: RoleRunOverrides,
  ): Promise<void>;
  /** Follows an existing run, such as after a reload or from a link. */
  open(runId: string): Promise<void>;
  /** Loads immutable text; reload retries a body that could not be verified by a reader. */
  loadArtifact(artifactVersionId: string, options?: { reload?: boolean }): Promise<void>;
  steer(executionId: string, text: string): Promise<Receipt>;
  /** Approves or rejects a pending approval, for the exact subject the person was shown. */
  resolveApproval(approvalId: string, decision: 'approve' | 'reject'): Promise<Receipt>;
  refreshReceipt(commandId: string): Promise<void>;
  dispose(): void;
}

export type SessionCommand = {
  [K in RunCommand['type']]: Omit<
    Extract<RunCommand, { type: K }>,
    'schemaVersion' | 'commandId' | 'runId'
  >;
}[RunCommand['type']];

export type RunSessionStore = StoreApi<RunSessionState>;

export interface StreamText {
  text: string;
  /** The chunk index expected next. */
  next: number;
  broken: boolean;
  /** Loaded from the immutable response referenced by a committed model.finished event. */
  completed?: boolean;
}

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
  recovery?: RunRecovery,
): RunSessionStore {
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  const receiptRefreshes = new Map<
    string,
    { version: number; dirty: boolean; promise: Promise<void> }
  >();

  const store = createStore<RunSessionState>((set, get) => {
    /**
     * Follows a run from its first event: one ordered stream builds both the projection and
     * the Timeline's event list. Events are applied in batches, so a long replay renders once.
     */
    const follow = async (runId: string, version: number) => {
      const restored = recovery?.events(runId) ?? [];
      set({
        projection: restored.reduce(applyEvent, emptyProjection(runId)),
        events: restored,
        streams: {},
      });
      let pending: RunEvent[] = [];
      let scheduled = false;
      const flush = () => {
        scheduled = false;
        const batch = pending;
        pending = [];
        if (generation !== version) return;
        let projection = get().projection ?? emptyProjection(runId);
        for (const event of batch) projection = applyEvent(projection, event);
        set({ projection, events: [...get().events, ...batch], streamError: null });
        recovery?.committed(runId, get().events);
        for (const event of batch) {
          if (event.type === 'model.finished' && event.payload.responseRef) {
            void restoreResponse(
              runId,
              event.payload.modelCallId,
              event.payload.responseRef,
              version,
            );
          }
        }
        const finalized = batch.find(
          (e): e is EventOf<'output.finalized'> => e.type === 'output.finalized',
        );
        if (finalized) void loadOutput(runId, finalized.payload.artifactVersionIds, version);
        refreshAffectedReceipts(batch, projection);
      };
      let frames: StreamFrame[] = [];
      let framesScheduled = false;
      const flushFrames = () => {
        framesScheduled = false;
        const batch = frames;
        frames = [];
        if (generation !== version) return;
        const streams = { ...get().streams };
        for (const frame of batch) {
          const current = streams[frame.modelCallId] ?? { text: '', next: 0, broken: false };
          if (
            current.completed ||
            current.broken ||
            get().projection?.modelCalls[frame.modelCallId]?.finished ||
            frame.chunkIndex < current.next
          )
            continue;
          streams[frame.modelCallId] =
            frame.chunkIndex === current.next
              ? { text: current.text + frame.text, next: current.next + 1, broken: false }
              : { ...current, broken: true };
        }
        set({ streams });
      };
      // Immutable outputs referenced by cached committed events are read from the host again.
      for (const event of restored) {
        if (event.type === 'model.finished' && event.payload.responseRef)
          void restoreResponse(
            runId,
            event.payload.modelCallId,
            event.payload.responseRef,
            version,
          );
        if (event.type === 'output.finalized')
          void loadOutput(runId, event.payload.artifactVersionIds, version);
      }
      unsubscribe = transport.subscribe(runId, restored.at(-1)?.runSeq ?? 0, {
        onEvent: (event: RunEvent) => {
          pending.push(event);
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(flush);
          }
        },
        onFrame: (frame: StreamFrame) => {
          frames.push(frame);
          if (!framesScheduled) {
            framesScheduled = true;
            queueMicrotask(flushFrames);
          }
        },
        onError: (error) => {
          if (generation === version) set({ streamError: String(error) });
        },
      });
    };

    const refreshDefinition = async (runId: string, version: number) => {
      try {
        const definition = await transport.getRunDefinition(runId);
        if (generation !== version) return;
        set({ definition, definitionError: definition ? null : 'Run definition unavailable' });
      } catch {
        if (generation === version) set({ definitionError: 'Run definition unavailable' });
      }
    };

    const reset = () => {
      generation++;
      unsubscribe?.();
      unsubscribe = null;
      set({
        runId: null,
        definition: null,
        definitionError: null,
        projection: null,
        events: [],
        streams: {},
        artifactTexts: {},
        outputText: null,
        startError: null,
        streamError: null,
        missingRunId: null,
        receipts: {},
        commandError: null,
        pendingCommandIds: [],
      });
    };

    const loadOutput = async (runId: string, versionIds: string[], version: number) => {
      const [first] = versionIds;
      if (!first) return;
      try {
        const outputText = await transport.getArtifactText(runId, first);
        if (generation === version) set({ outputText });
      } catch (error) {
        if (generation === version) set({ streamError: String(error) });
      }
    };

    const restoreResponse = async (
      runId: string,
      modelCallId: string,
      responseRef: string,
      version: number,
    ) => {
      try {
        const text = await transport.getArtifactText(runId, responseRef);
        if (text === null || generation !== version) return;
        set({
          streams: {
            ...get().streams,
            [modelCallId]: {
              text,
              next: get().streams[modelCallId]?.next ?? 0,
              broken: false,
              completed: true,
            },
          },
        });
      } catch (error) {
        if (generation === version) set({ streamError: String(error) });
      }
    };

    const refreshAffectedReceipts = (events: RunEvent[], projection: RunProjection) => {
      const affected = new Set<string>();
      for (const event of events) {
        if (
          event.type === 'directive.attached' ||
          event.type === 'directive.dispatched' ||
          event.type === 'directive.undelivered'
        ) {
          const commandId = projection.directives[event.payload.directiveId]?.commandId;
          if (commandId) affected.add(commandId);
        } else if (event.type === 'cancel.confirmed' && event.commandId) {
          affected.add(event.commandId);
        } else if (
          event.type === 'run.state_changed' &&
          (event.payload.to === 'paused' ||
            event.payload.reasonCode === 'resumed' ||
            TERMINAL_RUN_STATUSES.has(event.payload.to))
        ) {
          for (const receipt of Object.values(get().receipts))
            if (receipt.status === 'accepted' && receipt.requestedBoundary === 'safe_boundary')
              affected.add(receipt.commandId);
        }
      }
      for (const id of affected) {
        const receipt = get().receipts[id];
        if (receipt?.status === 'queued' || receipt?.status === 'accepted')
          void get()
            .refreshReceipt(id)
            .catch(() => undefined);
      }
    };

    const transmit = async (command: RunCommand, recover = false): Promise<Receipt> => {
      const { commandId, runId } = command;
      const version = generation;
      set({ commandError: null, pendingCommandIds: [...get().pendingCommandIds, commandId] });
      try {
        recovery?.pending(command);
        const receipt =
          (recover ? await transport.getReceipt(runId, commandId) : null) ??
          (await transport.sendCommand(command));
        recovery?.confirmed(runId, commandId);
        const unconfirmedCommands = { ...get().unconfirmedCommands };
        delete unconfirmedCommands[commandId];
        set({ unconfirmedCommands });
        if (generation === version && get().runId === runId) {
          set({ receipts: { ...get().receipts, [commandId]: receipt } });
          if (receipt.status === 'queued' || receipt.status === 'accepted')
            void get()
              .refreshReceipt(commandId)
              .catch(() => undefined);
        }
        return receipt;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({
          unconfirmedCommands: {
            ...get().unconfirmedCommands,
            [commandId]: { command, error: message },
          },
        });
        if (generation === version) set({ commandError: message });
        throw error;
      } finally {
        if (generation === version)
          set({ pendingCommandIds: get().pendingCommandIds.filter((id) => id !== commandId) });
      }
    };

    const recoverCommands = async (runId: string, version: number) => {
      if (!recovery) return;
      const saved = recovery.commands(runId);
      const unconfirmedCommands = { ...get().unconfirmedCommands };
      for (const command of saved)
        unconfirmedCommands[command.commandId] = {
          command,
          error: 'Previous response was not confirmed. Checking the host receipt.',
        };
      set({ unconfirmedCommands });
      for (const command of saved) {
        try {
          // Reads only. A missing receipt leaves explicit retry to the person.
          const receipt = await transport.getReceipt(runId, command.commandId);
          if (!receipt || generation !== version) continue;
          recovery.confirmed(runId, command.commandId);
          const remaining = { ...get().unconfirmedCommands };
          delete remaining[command.commandId];
          set({
            unconfirmedCommands: remaining,
            receipts: { ...get().receipts, [command.commandId]: receipt },
          });
        } catch {
          // Keep the exact request and ID. Connectivity errors never imply rejection.
        }
      }
    };

    return {
      runId: null,
      definition: null,
      definitionError: null,
      projection: null,
      events: [],
      streams: {},
      artifactTexts: {},
      outputText: null,
      startError: null,
      streamError: null,
      missingRunId: null,
      pendingCommandIds: [],
      receipts: {},
      commandError: null,
      unconfirmedCommands: {},

      async start(definition, saved, mode = 'mock', startFrom, harnessOverrides, roleOverrides) {
        reset();
        const version = generation;
        const commandId = newCommandId();
        const from = {
          ...(startFrom ? { startFrom } : {}),
          ...(harnessOverrides && Object.keys(harnessOverrides).length ? { harnessOverrides } : {}),
          ...(roleOverrides && Object.keys(roleOverrides).length ? { roleOverrides } : {}),
        };
        try {
          const { runId, receipt } = await transport.startRun(
            saved
              ? { schemaVersion: '0.1', commandId, ...saved, mode, ...from }
              : { schemaVersion: '0.1', commandId, definition, mode, ...from },
          );
          if (generation !== version) return;
          if (!runId) {
            set({
              startError: receipt.error ?? { code: 'SCHEMA_INVALID', message: 'run rejected' },
            });
            return;
          }
          set({ runId, definition: null });
          await follow(runId, version);
          await refreshDefinition(runId, version);
        } catch (error) {
          if (generation === version) set({ streamError: String(error) });
        }
      },

      async loadArtifact(artifactVersionId, options) {
        const runId = get().runId;
        const version = generation;
        if (!runId || (!options?.reload && artifactVersionId in get().artifactTexts)) return;
        const text = await transport.getArtifactText(runId, artifactVersionId);
        if (generation === version) {
          if (text !== null) {
            set({ artifactTexts: { ...get().artifactTexts, [artifactVersionId]: text } });
          } else if (options?.reload) {
            const artifactTexts = { ...get().artifactTexts };
            delete artifactTexts[artifactVersionId];
            set({ artifactTexts });
          }
        }
      },

      async open(runId) {
        if (get().runId === runId && unsubscribe && !get().streamError) {
          if (!get().definition) await refreshDefinition(runId, generation);
          return;
        }
        reset();
        // The requested identity owns loading, missing and failed states too. Keeping it
        // here lets consumers display this request's error without accepting a prior run's.
        set({ runId });
        const version = generation;
        try {
          const definition = await transport.getRunDefinition(runId);
          if (generation !== version) return;
          if (!definition) {
            set({ missingRunId: runId });
            return;
          }
          set({ runId, definition });
          await follow(runId, version);
          await recoverCommands(runId, version);
        } catch (error) {
          if (generation === version) set({ streamError: String(error) });
        }
      },

      async sendCommand(command) {
        const runId = get().runId;
        if (!runId) throw new Error('no active run');
        const candidate = structuredClone({
          ...command,
          schemaVersion: '0.1' as const,
          commandId: '',
          runId,
        });
        const prior = [
          ...Object.values(get().unconfirmedCommands).map((entry) => entry.command),
          ...(recovery?.commands(runId) ?? []),
        ].find((saved) => canonicalJson({ ...saved, commandId: '' }) === canonicalJson(candidate));
        return prior
          ? transmit(prior, true)
          : transmit({ ...candidate, commandId: newCommandId() });
      },

      async retryCommand(commandId) {
        const pending = get().unconfirmedCommands[commandId];
        if (!pending || pending.command.runId !== get().runId)
          throw new Error('no unconfirmed command for this run');
        return transmit(pending.command, true);
      },

      async steer(executionId, text) {
        return get().sendCommand({
          type: 'steer',
          payload: { targetExecutionId: executionId, text, delivery: 'next_request' },
        });
      },

      async resolveApproval(approvalId, decision) {
        const approval = get().projection?.approvals[approvalId];
        if (!approval) throw new Error('no such approval');
        return get().sendCommand({
          type: 'resolve_approval',
          expectedControlRevision: get().projection?.controlRevision ?? 0,
          payload: { approvalId, decision, subjectVersionId: approval.subjectVersionIds[0] ?? '' },
        });
      },

      async refreshReceipt(commandId) {
        const runId = get().runId;
        const version = generation;
        if (!runId) return;
        const existing = receiptRefreshes.get(commandId);
        if (existing?.version === version) {
          existing.dirty = true;
          return existing.promise;
        }
        const refresh = { version, dirty: false, promise: Promise.resolve() };
        receiptRefreshes.set(commandId, refresh);
        refresh.promise = (async () => {
          do {
            refresh.dirty = false;
            const receipt = await transport.getReceipt(runId, commandId);
            if (receipt && generation === version)
              set({ receipts: { ...get().receipts, [commandId]: receipt } });
          } while (refresh.dirty && generation === version);
        })().finally(() => {
          if (receiptRefreshes.get(commandId) === refresh) receiptRefreshes.delete(commandId);
        });
        return refresh.promise;
      },

      dispose() {
        generation++;
        unsubscribe?.();
        unsubscribe = null;
      },
    };
  });
  return store;
}
