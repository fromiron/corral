import {
  type AgentAdapter,
  type AgentHandle,
  type AgentHost,
  type AgentObservation,
  type AgentSettlement,
  type AgentStartInput,
  type Clock,
  type CommandError,
  type CorralDefinition,
  CreateRunRequest,
  type DecisionNode,
  type EventPayload,
  type IdFactory,
  type InputBinding,
  type Receipt,
  type RequestPermit,
  type ResolvedInput,
  RunCommand,
  RunEvent,
  type RunEventType,
  StartRunRequest,
  type SteerCommand,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
  type ToolOutcome,
  type ToolProposal,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from './canonical-json.ts';
import type { CompiledPlan } from './compiler/index.ts';
import { type InstallationPolicy, limitViolations, SPEC_HARD_CAPS } from './config.ts';
import { definitionHash } from './definition-hash.ts';
import { applyEvent, emptyProjection, type RunProjection } from './projection.ts';
import { planRun } from './run-plan.ts';
import {
  type GraphRunner,
  type IterationRef,
  type RoundOutcome,
  type RunnerCallbacks,
  type RunnerResult,
  SequentialPlanRunner,
  type StepOutcome,
} from './runner.ts';
import {
  InMemoryRunStore,
  type RunSnapshot,
  type RunStore,
  type RunSummary,
  type StoredCommand,
} from './store/run-store.ts';

// The single place domain state is decided (ADR-003, C-012/C-013). A command is validated and
// turned into events; the events, the projection they produce, the command record and artifact
// bodies are written in one RunStore transaction; only after that commit are effects (agent
// work) dispatched. If a commit fails, admission closes: nothing new starts while facts cannot
// be recorded. On start-up every run left unfinished by a previous process is marked
// interrupted and never re-run (RUN-007).

const USER = { kind: 'user', id: 'local_user' } as const;
const RUNTIME = { kind: 'runtime', id: 'coordinator' } as const;
/** Scope for run-creation commands, which have no run yet. */
const START_SCOPE = '*';

type Actor = { kind: 'user' | 'runtime' | 'agent'; id: string };
type EventDraft = {
  [T in RunEventType]: {
    type: T;
    payload: EventPayload<T>;
    actor?: Actor;
    executionId?: string;
    taskId?: string;
    commandId?: string;
  };
}[RunEventType];

export interface StartRunResult {
  runId: string | null;
  receipt: Receipt;
}

/** Resolves saved Corral revisions for `CreateRunRequest` (the server's repository). */
export interface DefinitionSource {
  getDefinition(corralId: string, definitionRevision: number): CorralDefinition | null;
}

export interface DecisionInput {
  runId: string;
  nodeId: string;
  mode: DecisionNode['mode'];
  iteration: IterationRef | null;
  projection: RunProjection;
}

/** Chooses a Decision branch. Reviews and approvals provide it in P5; tests script it. */
export interface DecisionPolicy {
  decide(input: DecisionInput): Promise<string>;
}

export interface CoordinatorDeps {
  clock: Clock;
  ids: IdFactory;
  agents: AgentAdapter;
  /** Where facts are committed. Defaults to memory (browser runtime, tests). */
  store?: RunStore;
  runner?: GraphRunner;
  decisions?: DecisionPolicy;
  /** Names this backend process in `run.interrupted` when it recovers older runs. */
  sessionId?: string;
  corrals?: DefinitionSource;
  /** Installation hard caps (C-062). Defaults to Spec §9. */
  policy?: InstallationPolicy;
}

interface Subscriber {
  runId: string;
  nextSeq: number;
  onEvent: (event: RunEvent) => void;
  onError: ((error: unknown) => void) | undefined;
}

interface LiveRun {
  runId: string;
  snapshot: RunSnapshot;
  plan: CompiledPlan;
  projection: RunProjection;
  /** Set when the run must not take another step (storage closed). */
  stop: { aborted: boolean };
  /** One promise per activation key: a replayed step joins the first one (C-013). */
  activations: Map<string, Promise<StepOutcome>>;
  handles: Map<string, AgentHandle>;
  /** The open round of each Loop node. */
  rounds: Map<string, { no: number; iterationId: string }>;
}

class StorageUnavailableError extends Error {}

export class Coordinator {
  private readonly clock: Clock;
  private readonly ids: IdFactory;
  private readonly agents: AgentAdapter;
  private readonly store: RunStore;
  private readonly runner: GraphRunner;
  private readonly decisions: DecisionPolicy | undefined;
  private readonly corrals: DefinitionSource | undefined;
  private readonly sessionId: string;
  private readonly policy: InstallationPolicy;
  private readonly live = new Map<string, LiveRun>();
  private readonly subscribers = new Set<Subscriber>();
  private storageError: string | null = null;

  constructor(deps: CoordinatorDeps) {
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.agents = deps.agents;
    this.store = deps.store ?? new InMemoryRunStore();
    this.runner = deps.runner ?? new SequentialPlanRunner();
    this.decisions = deps.decisions;
    this.corrals = deps.corrals;
    this.sessionId = deps.sessionId ?? 'backend_local';
    this.policy = deps.policy ?? SPEC_HARD_CAPS;
    this.recover();
  }

  /** False once a commit failed; reads keep working, nothing new is admitted. */
  get admitting(): boolean {
    return this.storageError === null;
  }

  // ── run creation (C-057) ──────────────────────────────────────────────────

  startRun(raw: StartRunRequest | CreateRunRequest): StartRunResult {
    const parsed =
      'definition' in raw ? StartRunRequest.safeParse(raw) : CreateRunRequest.safeParse(raw);
    if (!parsed.success) {
      return { runId: null, receipt: rejected(raw.commandId, 'none', schemaError(parsed.error)) };
    }
    const request = parsed.data;
    const payloadHash = hashOf(request);
    const previous = this.store.getCommand(START_SCOPE, request.commandId);
    if (previous) {
      if (previous.payloadHash !== payloadHash) {
        return { runId: null, receipt: conflict(request.commandId, previous.receipt.runId) };
      }
      return { runId: previous.runId, receipt: previous.receipt };
    }
    if (this.storageError) {
      return { runId: null, receipt: unavailable(request.commandId, 'none', this.storageError) };
    }

    const refuse = (error: CommandError): StartRunResult => {
      const receipt = rejected(request.commandId, 'none', error);
      // A definition that cannot run stays refused for this commandId; a busy workspace not.
      if (error.code !== 'RUN_ALREADY_ACTIVE') {
        this.recordStart({ payloadHash, receipt, runId: null });
      }
      return { runId: null, receipt };
    };

    const resolved = this.resolveDefinition(request);
    if ('error' in resolved) return refuse(resolved.error);
    const planned = planRun(resolved.definition, { decisions: this.decisions !== undefined });
    if (!planned.ok) {
      const code = planned.issues.some((i) => i.code === 'GRAPH_INVALID')
        ? 'GRAPH_INVALID'
        : 'COMMAND_NOT_SUPPORTED';
      const message = planned.issues
        .map((i) => `${i.nodeId ?? i.edgeId ?? i.linkId ?? 'graph'}: ${i.message}`)
        .join('; ');
      return refuse({ code, message });
    }
    const loopRounds = Math.max(
      0,
      ...Object.values(planned.plan.loops).map((l) => l.maxIterations),
    );
    const overCaps = limitViolations(planned.definition.limits, loopRounds, this.policy);
    if (overCaps.length > 0) return refuse({ code: 'GRAPH_INVALID', message: overCaps.join('; ') });
    const active = this.store.listRuns().find((r) => !TERMINAL_RUN_STATUSES.has(r.status));
    if (active) {
      return refuse({
        code: 'RUN_ALREADY_ACTIVE',
        message: `run ${active.runId} is still ${active.status}; one run at a time`,
      });
    }

    const runId = this.ids.next('run');
    const definition = planned.definition;
    const snapshot: RunSnapshot = {
      definition,
      definitionHash: definitionHash(definition),
      source:
        'corralId' in request
          ? { corralId: request.corralId, definitionRevision: request.definitionRevision }
          : null,
      criteriaVersionId: this.ids.next('criteria_version'),
      mode: request.mode,
      startedAt: this.clock.nowIso(),
    };
    const run: LiveRun = {
      runId,
      snapshot,
      plan: planned.plan,
      projection: emptyProjection(runId),
      stop: { aborted: false },
      activations: new Map(),
      handles: new Map(),
      rounds: new Map(),
    };

    const { events, projection } = this.prepare(run, [
      {
        type: 'run.started',
        actor: USER,
        commandId: request.commandId,
        payload: {
          corralId: definition.id,
          definitionHash: snapshot.definitionHash,
          inputHash: hashOf(definition.input),
          mode: request.mode,
          modelProfiles: [...new Set(definition.roles.map((r) => r.modelProfile))].map(
            (profile) => ({ profile, provider: null, modelId: null, auth: 'mock' as const }),
          ),
          limits: definition.limits,
        },
      },
      runState('created', 'validating', 'run_requested'),
      runState('validating', 'running', 'validation_passed'),
    ]);
    const started = events[0];
    const receipt: Receipt = {
      commandId: request.commandId,
      runId,
      status: 'applied',
      acceptedSeq: started?.runSeq ?? null,
      target: `run:${runId}`,
      requestedBoundary: 'immediate',
      relatedEventIds: started ? [started.eventId] : [],
    };
    try {
      this.persist(() => {
        this.store.insertRun({ runId, snapshot, projection: emptyProjection(runId) });
        this.write(runId, events, projection);
        this.store.putArtifactText(
          runId,
          snapshot.criteriaVersionId,
          definition.input.criteria.join('\n'),
        );
        this.store.putCommand({
          scope: START_SCOPE,
          commandId: request.commandId,
          payloadHash,
          receipt,
          runId,
          directiveId: null,
        });
      });
    } catch {
      return { runId: null, receipt: unavailable(request.commandId, 'none', this.storageError) };
    }
    this.live.set(runId, run);
    this.publish(run, projection);
    this.schedule(run, () => this.drive(run));
    return { runId, receipt };
  }

  private resolveDefinition(
    request: StartRunRequest | CreateRunRequest,
  ): { definition: unknown } | { error: CommandError } {
    if ('definition' in request) return { definition: request.definition };
    const saved = this.corrals?.getDefinition(request.corralId, request.definitionRevision);
    if (!saved) {
      return {
        error: {
          code: 'TARGET_NOT_FOUND',
          message: `Corral ${request.corralId} has no revision ${request.definitionRevision}`,
        },
      };
    }
    // Copy, so later changes to the caller's object cannot reach the snapshot.
    const copy = JSON.parse(JSON.stringify(saved)) as CorralDefinition;
    return { definition: request.input ? { ...copy, input: request.input } : copy };
  }

  private recordStart(record: { payloadHash: string; receipt: Receipt; runId: string | null }) {
    try {
      this.persist(() =>
        this.store.putCommand({
          scope: START_SCOPE,
          commandId: record.receipt.commandId,
          directiveId: null,
          ...record,
        }),
      );
    } catch {
      // Admission is closed; the caller still gets the refusal.
    }
  }

  // ── run commands ──────────────────────────────────────────────────────────

  submit(raw: RunCommand): Receipt {
    const parsed = RunCommand.safeParse(raw);
    if (!parsed.success) return rejected(raw.commandId, raw.runId, schemaError(parsed.error));
    const command = parsed.data;
    if (!this.store.getRun(command.runId)) {
      return rejected(command.commandId, command.runId, {
        code: 'TARGET_NOT_FOUND',
        message: `run ${command.runId} does not exist`,
      });
    }
    const payloadHash = hashOf(command);
    const previous = this.store.getCommand(command.runId, command.commandId);
    if (previous) {
      if (previous.payloadHash !== payloadHash) return conflict(command.commandId, command.runId);
      return this.currentReceipt(previous);
    }
    if (this.storageError) {
      return unavailable(command.commandId, command.runId, this.storageError);
    }
    try {
      if (command.type === 'steer') return this.steer(command, payloadHash);
      const receipt = rejected(command.commandId, command.runId, {
        code: 'COMMAND_NOT_SUPPORTED',
        message: `${command.type} is not available in this runtime yet`,
      });
      this.persist(() =>
        this.store.putCommand({
          scope: command.runId,
          commandId: command.commandId,
          payloadHash,
          receipt,
          runId: command.runId,
          directiveId: null,
        }),
      );
      return receipt;
    } catch {
      return unavailable(command.commandId, command.runId, this.storageError);
    }
  }

  private steer(command: SteerCommand, payloadHash: string): Receipt {
    const { runId } = command;
    const executionId = command.payload.targetExecutionId;
    const run = this.live.get(runId);
    const execution = this.projectionOf(runId)?.executions[executionId];
    const record = (receipt: Receipt, directiveId: string | null = null): StoredCommand => ({
      scope: runId,
      commandId: command.commandId,
      payloadHash,
      receipt,
      runId,
      directiveId,
    });
    const refuse = (error: CommandError): Receipt => {
      const receipt = rejected(command.commandId, runId, error, `execution:${executionId}`);
      this.persist(() => this.store.putCommand(record(receipt)));
      return receipt;
    };
    if (!execution) {
      return refuse({
        code: 'TARGET_NOT_FOUND',
        message: `execution ${executionId} does not exist`,
      });
    }
    if (
      !run ||
      TERMINAL_EXECUTION_STATUSES.has(execution.status) ||
      TERMINAL_RUN_STATUSES.has(run.projection.status)
    ) {
      return refuse({ code: 'TARGET_TERMINAL', message: `execution ${executionId} has finished` });
    }
    const directiveId = this.ids.next('directive');
    this.commit(
      run,
      [
        {
          type: 'directive.accepted',
          actor: USER,
          commandId: command.commandId,
          executionId,
          payload: { directiveId, targetExecutionId: executionId, text: command.payload.text },
        },
      ],
      // The receipt is stored with the event, so a lost response can be asked for again.
      (events) => {
        const accepted = events[0];
        this.store.putCommand(
          record(
            {
              commandId: command.commandId,
              runId,
              status: 'queued',
              acceptedSeq: accepted?.runSeq ?? null,
              target: `execution:${executionId}`,
              requestedBoundary: 'next_request',
              relatedEventIds: accepted ? [accepted.eventId] : [],
            },
            directiveId,
          ),
        );
      },
    );
    const stored = this.store.getCommand(runId, command.commandId);
    if (!stored) throw new Error(`command ${command.commandId} was not recorded`);
    return this.currentReceipt(stored);
  }

  /** A steer receipt follows its directive: queued until a request carries it. */
  private currentReceipt(record: StoredCommand): Receipt {
    if (!record.directiveId || !record.runId) return record.receipt;
    const directive = this.projectionOf(record.runId)?.directives[record.directiveId];
    const status = (() => {
      switch (directive?.status) {
        case 'delivered':
          return 'applied' as const;
        case 'expired':
          return 'expired' as const;
        case 'not_delivered':
        case 'delivery_unknown':
          return 'cancelled' as const;
        case 'rejected':
          return 'rejected' as const;
        default:
          return 'queued' as const;
      }
    })();
    return { ...record.receipt, status };
  }

  // ── queries ───────────────────────────────────────────────────────────────

  listRuns(): RunSummary[] {
    return this.store.listRuns();
  }

  /** Whether a run-creation command is already recorded (a resend, not a new run). */
  hasStartCommand(commandId: string): boolean {
    return this.store.getCommand(START_SCOPE, commandId) !== null;
  }

  getReceipt(runId: string, commandId: string): Receipt | null {
    const record = this.store.getCommand(runId, commandId);
    if (record) return this.currentReceipt(record);
    const start = this.store.getCommand(START_SCOPE, commandId);
    return start?.runId === runId ? start.receipt : null;
  }

  /** Null when the run does not exist. */
  findSnapshot(runId: string): { projection: RunProjection; seq: number } | null {
    const projection = this.projectionOf(runId);
    return projection ? { projection, seq: projection.lastSeq } : null;
  }

  getSnapshot(runId: string): { projection: RunProjection; seq: number } {
    const snapshot = this.findSnapshot(runId);
    if (!snapshot) throw new Error(`run ${runId} does not exist`);
    return snapshot;
  }

  getRunSnapshot(runId: string): RunSnapshot | null {
    return this.store.getRun(runId)?.snapshot ?? null;
  }

  getArtifactText(runId: string, artifactVersionId: string): string | null {
    return this.store.getArtifactText(runId, artifactVersionId);
  }

  /** Delivers every event after `afterSeq` exactly once, in order, then follows live commits. */
  subscribe(
    runId: string,
    afterSeq: number,
    onEvent: (event: RunEvent) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    if (!this.store.getRun(runId)) throw new Error(`run ${runId} does not exist`);
    const subscriber: Subscriber = { runId, nextSeq: afterSeq + 1, onEvent, onError };
    this.subscribers.add(subscriber);
    void Promise.resolve().then(() => this.pump(subscriber));
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private projectionOf(runId: string): RunProjection | null {
    return this.live.get(runId)?.projection ?? this.store.getRun(runId)?.projection ?? null;
  }

  // ── commit and fan-out ────────────────────────────────────────────────────

  private prepare(
    run: { runId: string; projection: RunProjection },
    drafts: EventDraft[],
  ): { events: RunEvent[]; projection: RunProjection } {
    let projection = run.projection;
    const events: RunEvent[] = [];
    for (const draft of drafts) {
      const { actor, ...rest } = draft;
      const event = RunEvent.parse({
        schemaVersion: '0.1',
        eventId: this.ids.next('event'),
        runId: run.runId,
        runSeq: projection.lastSeq + 1,
        recordedAt: this.clock.nowIso(),
        actor: actor ?? RUNTIME,
        causedByEventIds: [],
        ...rest,
      });
      projection = applyEvent(projection, event);
      events.push(deepFreeze(event));
    }
    return { events, projection };
  }

  private write(runId: string, events: RunEvent[], projection: RunProjection) {
    this.store.appendEvents(runId, events);
    this.store.saveProjection(runId, projection);
  }

  /** Runs one transaction; a failure closes admission and stops every live run. */
  private persist(write: () => void) {
    if (this.storageError) throw new StorageUnavailableError(this.storageError);
    try {
      this.store.transaction(write);
    } catch (error) {
      this.closeAdmission(error);
      throw new StorageUnavailableError(this.storageError ?? 'storage failed');
    }
  }

  private closeAdmission(error: unknown) {
    if (this.storageError) return;
    this.storageError = `facts can no longer be recorded: ${String(error)}`;
    for (const run of this.live.values()) {
      run.stop.aborted = true;
      for (const handle of run.handles.values()) {
        void handle.cancel('storage unavailable').catch(() => {});
      }
    }
  }

  /** Commits drafts (plus `extra` writes) atomically, then updates readers. */
  private commit(run: LiveRun, drafts: EventDraft[], extra?: (events: RunEvent[]) => void) {
    const { events, projection } = this.prepare(run, drafts);
    this.persist(() => {
      this.write(run.runId, events, projection);
      extra?.(events);
    });
    this.publish(run, projection);
    return events;
  }

  private publish(run: LiveRun, projection: RunProjection) {
    run.projection = projection;
    for (const subscriber of this.subscribers) {
      if (subscriber.runId === run.runId) {
        void Promise.resolve().then(() => this.pump(subscriber));
      }
    }
    if (TERMINAL_RUN_STATUSES.has(projection.status)) this.live.delete(run.runId);
  }

  private pump(subscriber: Subscriber) {
    while (this.subscribers.has(subscriber)) {
      const [event] = this.store.readEvents(subscriber.runId, subscriber.nextSeq - 1, 1);
      if (!event) return;
      subscriber.nextSeq += 1;
      try {
        subscriber.onEvent(event);
      } catch (error) {
        // A failing consumer is detached and told why; it must re-read from a snapshot.
        this.subscribers.delete(subscriber);
        subscriber.onError?.(error);
      }
    }
  }

  private schedule(run: LiveRun, effect: () => Promise<void>) {
    void Promise.resolve()
      .then(effect)
      .catch((error: unknown) => this.failRun(run, `internal_error: ${String(error)}`));
  }

  private failRun(run: LiveRun, reason: string) {
    const status = run.projection.status;
    if (TERMINAL_RUN_STATUSES.has(status) || this.storageError) return;
    try {
      this.commit(run, [...this.closeRounds(run), runState(status, 'failed', reason)]);
    } catch {
      // Storage is gone; the next start marks this run interrupted.
    }
  }

  // ── recovery (RUN-007) ────────────────────────────────────────────────────

  private recover() {
    for (const summary of this.store.listRuns()) {
      if (TERMINAL_RUN_STATUSES.has(summary.status)) continue;
      const stored = this.store.getRun(summary.runId);
      if (!stored) continue;
      const { events, projection } = this.prepare(
        { runId: summary.runId, projection: stored.projection },
        this.interruption(stored.projection),
      );
      try {
        this.persist(() => this.write(summary.runId, events, projection));
      } catch {
        return;
      }
    }
  }

  /** Ends what a dead process left open, without starting anything again. */
  private interruption(p: RunProjection): EventDraft[] {
    const drafts: EventDraft[] = [];
    for (const effect of Object.values(p.effects)) {
      if (effect.status !== 'admitted') continue;
      // It may have reached the provider; nobody knows. It is never dispatched again.
      drafts.push({
        type: 'effect.settled',
        payload: { effectId: effect.effectId, outcome: 'unknown' },
      });
    }
    for (const executionId of p.executionOrder) {
      const execution = p.executions[executionId];
      if (!execution || TERMINAL_EXECUTION_STATUSES.has(execution.status)) continue;
      drafts.push({
        type: 'execution.settled',
        executionId,
        payload: {
          executionId,
          outcome: 'failed',
          terminationMode: 'unconfirmed',
          error: 'interrupted: the backend restarted',
        },
      });
    }
    for (const directiveId of p.directiveOrder) {
      const directive = p.directives[directiveId];
      if (directive?.status !== 'queued' && directive?.status !== 'attached_to_request') continue;
      drafts.push({
        type: 'directive.undelivered',
        executionId: directive.targetExecutionId,
        payload: {
          directiveId,
          status: directive.status === 'queued' ? 'not_delivered' : 'delivery_unknown',
          reason: 'the backend restarted before the directive was delivered',
        },
      });
    }
    for (const iterations of Object.values(p.loopIterations)) {
      const open = iterations.map((id) => p.iterations[id]).find((i) => i && !i.outcome);
      if (!open) continue;
      drafts.push({
        type: 'loop.iteration_finished',
        payload: {
          loopNodeId: open.loopNodeId,
          iterationId: open.iterationId,
          outcome: 'cancelled',
          submittedVersionIds: [],
        },
      });
    }
    drafts.push(
      {
        type: 'run.interrupted',
        payload: { previousStatus: p.status, backendSessionId: this.sessionId },
      },
      runState(p.status, 'interrupted', 'backend_restarted'),
    );
    return drafts;
  }

  // ── graph execution ───────────────────────────────────────────────────────

  private async drive(run: LiveRun): Promise<void> {
    const result = await this.runner.run(run.plan, this.callbacksFor(run), run.stop);
    this.conclude(run, result);
  }

  private conclude(run: LiveRun, result: RunnerResult) {
    if (run.projection.status !== 'running') return;
    switch (result.kind) {
      case 'finished':
        // finalizeOutput already ended the run; reaching here still running is a runner bug.
        this.failRun(run, `runner_finished_without_output: ${result.outputNodeId}`);
        return;
      case 'failed':
        this.failRun(run, `execution_failed: ${result.nodeId}`);
        return;
      case 'stopped':
        return;
      // Loop caps, rejections and inconclusive reviews ask the user through approvals (P5).
      // Only an injected decision policy reaches them today; they end the run plainly.
      case 'cap_reached':
        this.failRun(run, `loop_cap_reached: ${result.loopId}`);
        return;
      case 'rejected':
        this.failRun(run, `rejected: ${result.nodeId}`);
        return;
      case 'needs_user':
        this.failRun(run, `needs_user: ${result.nodeId} ${result.branch}`);
        return;
    }
  }

  private callbacksFor(run: LiveRun): RunnerCallbacks {
    return {
      activate: (nodeId, iteration) => this.activate(run, nodeId, iteration),
      decide: async (nodeId, iteration) => {
        const step = run.plan.steps[nodeId];
        if (step?.kind !== 'decision' || !this.decisions) {
          throw new Error(`no decision policy for ${nodeId}`);
        }
        return this.decisions.decide({
          runId: run.runId,
          nodeId,
          mode: step.mode,
          iteration,
          projection: run.projection,
        });
      },
      finalize: async (outputNodeId) => this.finalizeOutput(run, outputNodeId),
      loopEntered: async (loopId, no) => {
        if (!run.plan.loops[loopId]) throw new Error(`plan has no Loop ${loopId}`);
        const iterationId = this.ids.next('iteration');
        this.commit(run, [
          {
            type: 'loop.iteration_started',
            payload: {
              loopNodeId: loopId,
              iterationId,
              no,
              pinnedCarryInputs: [],
              criteriaVersionId: run.snapshot.criteriaVersionId,
            },
          },
        ]);
        run.rounds.set(loopId, { no, iterationId });
      },
      loopLeft: async (loopId, no, outcome) => {
        const round = run.rounds.get(loopId);
        if (round?.no !== no) throw new Error(`Loop ${loopId} round ${no} is not open`);
        this.commit(run, [this.roundFinished(run, loopId, round.iterationId, outcome)]);
        run.rounds.delete(loopId);
      },
    };
  }

  private roundFinished(
    run: LiveRun,
    loopNodeId: string,
    iterationId: string,
    outcome: RoundOutcome | 'cancelled',
  ): EventDraft {
    const submittedVersionIds = Object.values(run.projection.executions)
      .filter((e) => e.iterationId === iterationId)
      .flatMap((e) => run.projection.tasks[e.taskId]?.submittedArtifactVersionIds ?? []);
    return {
      type: 'loop.iteration_finished',
      payload: { loopNodeId, iterationId, outcome, submittedVersionIds },
    };
  }

  private closeRounds(run: LiveRun): EventDraft[] {
    const drafts = [...run.rounds].map(([loopId, round]) =>
      this.roundFinished(run, loopId, round.iterationId, 'cancelled'),
    );
    run.rounds.clear();
    return drafts;
  }

  /**
   * Starts one scheduled step. The activation key is (node, Loop round): calling again with
   * the same key returns the first activation's outcome instead of creating another Task.
   */
  private activate(
    run: LiveRun,
    nodeId: string,
    iteration: IterationRef | null,
  ): Promise<StepOutcome> {
    const round = iteration ? run.rounds.get(iteration.loopId) : undefined;
    if (iteration && round?.no !== iteration.no) {
      return Promise.reject(
        new Error(`Loop ${iteration.loopId} round ${iteration.no} is not open`),
      );
    }
    const key = `${nodeId}@${round?.iterationId ?? '-'}`;
    const existing = run.activations.get(key);
    if (existing) return existing;
    const outcome = this.runAgent(run, nodeId, round?.iterationId ?? null);
    run.activations.set(key, outcome);
    return outcome;
  }

  private async runAgent(
    run: LiveRun,
    nodeId: string,
    iterationId: string | null,
  ): Promise<StepOutcome> {
    const definition = run.snapshot.definition;
    const node = definition.nodes.find((n) => n.id === nodeId);
    const role = node?.type === 'agent' && definition.roles.find((r) => r.id === node.roleId);
    if (node?.type !== 'agent' || !role) throw new Error(`plan references missing agent ${nodeId}`);

    const taskId = this.ids.next('task');
    const executionId = this.ids.next('execution');
    const effectId = this.ids.next('effect');
    const attemptNo = 1;
    const input: AgentStartInput = {
      runId: run.runId,
      executionId,
      taskId,
      nodeId,
      attemptNo,
      role,
      modelProfile: role.modelProfile,
      inputs: this.resolveInputs(run, node.inputBindings, iterationId),
    };
    this.commit(run, [
      {
        type: 'task.created',
        taskId,
        payload: {
          taskId,
          nodeId,
          roleId: role.id,
          contract: role.outputContract,
          dependsOnTaskIds: [],
        },
      },
      {
        type: 'execution.created',
        executionId,
        taskId,
        payload: {
          executionId,
          parentExecutionId: null,
          nodeId,
          taskId,
          attemptNo,
          depth: 0,
          iterationId,
          modelProfile: role.modelProfile,
        },
      },
      {
        type: 'task.attempt_assigned',
        taskId,
        executionId,
        payload: { taskId, executionId, attemptNo },
      },
      {
        type: 'effect.admitted',
        executionId,
        payload: {
          effectId,
          kind: 'spawn',
          scope: executionId,
          epoch: attemptNo,
          reservationId: null,
        },
      },
      {
        type: 'execution.state_changed',
        executionId,
        payload: { executionId, from: 'queued', to: 'active', activity: 'model', waitingOn: null },
      },
    ]);

    // Committed: only now does work leave the coordinator.
    let settlement: AgentSettlement;
    try {
      const handle = await this.agents.start(input, this.hostFor(run, input));
      run.handles.set(executionId, handle);
      settlement = await handle.waitForSettlement();
    } catch (error) {
      settlement = { outcome: 'failed', error: String(error) };
    } finally {
      run.handles.delete(executionId);
    }
    return this.settle(run, input, effectId, settlement);
  }

  private resolveInputs(
    run: LiveRun,
    bindings: InputBinding[],
    iterationId: string | null,
  ): ResolvedInput[] {
    const { brief, criteria } = run.snapshot.definition.input;
    const previousRound = iterationId ? this.previousRound(run, iterationId) : null;
    return bindings.flatMap((binding): ResolvedInput[] => {
      if (binding.kind === 'run_input') {
        const text = binding.name === 'criteria' ? criteria.join('\n') : brief;
        return [{ name: binding.name, kind: 'run_input', artifactVersionId: null, text }];
      }
      const source = binding.sourceNodeId ?? '';
      let versionId: string | undefined;
      if (binding.kind === 'task_output') versionId = this.submittedOutputOf(run, source)[0];
      if (binding.kind === 'previous_iteration_output' && previousRound) {
        versionId = this.submittedOutputOf(run, source, previousRound)[0];
      }
      if (binding.kind === 'explicit_version') versionId = binding.artifactVersionId;
      const text = versionId ? this.store.getArtifactText(run.runId, versionId) : null;
      if (!versionId || text === null) {
        if (binding.optional) return [];
        throw new Error(`input "${binding.name}" (${binding.kind}) has no submitted version`);
      }
      return [{ name: binding.name, kind: binding.kind, artifactVersionId: versionId, text }];
    });
  }

  private previousRound(run: LiveRun, iterationId: string): string | null {
    const current = run.projection.iterations[iterationId];
    if (!current) return null;
    const rounds = run.projection.loopIterations[current.loopNodeId] ?? [];
    return rounds[rounds.indexOf(iterationId) - 1] ?? null;
  }

  /** The latest completed submission of a node, optionally within one Loop round. */
  private submittedOutputOf(run: LiveRun, nodeId: string, iterationId?: string): string[] {
    const executions = run.projection.nodeExecutions[nodeId] ?? [];
    for (const executionId of [...executions].reverse()) {
      const execution = run.projection.executions[executionId];
      if (iterationId !== undefined && execution?.iterationId !== iterationId) continue;
      const task = run.projection.tasks[execution?.taskId ?? ''];
      if (task?.status === 'completed') return task.submittedArtifactVersionIds;
    }
    return [];
  }

  private settle(
    run: LiveRun,
    input: AgentStartInput,
    effectId: string,
    settlement: AgentSettlement,
  ): StepOutcome {
    const execution = run.projection.executions[input.executionId];
    if (!execution || TERMINAL_EXECUTION_STATUSES.has(execution.status) || this.storageError) {
      // Already ended elsewhere (run over, storage closed): a late report changes nothing.
      return { ok: false, reason: 'the execution had already ended' };
    }
    const task = run.projection.tasks[input.taskId];
    const submitted = task?.status === 'completed';
    const outcome =
      settlement.outcome === 'succeeded' && !submitted ? ('failed' as const) : settlement.outcome;
    const error =
      settlement.outcome === 'succeeded' && !submitted
        ? 'the agent finished without submit_result'
        : settlement.error;

    const drafts: EventDraft[] = [
      {
        type: 'execution.settled',
        executionId: input.executionId,
        payload: {
          executionId: input.executionId,
          outcome,
          terminationMode: 'normal',
          ...(error ? { error } : {}),
        },
      },
      { type: 'effect.settled', executionId: input.executionId, payload: { effectId, outcome } },
    ];
    for (const effect of Object.values(run.projection.effects)) {
      // A model request still open when its agent stopped may or may not have been billed.
      if (effect.kind !== 'model_request' || effect.scope !== input.executionId) continue;
      if (effect.status !== 'admitted') continue;
      drafts.push({
        type: 'effect.settled',
        executionId: input.executionId,
        payload: { effectId: effect.effectId, outcome: 'unknown' },
      });
    }
    for (const directiveId of run.projection.directiveOrder) {
      const directive = run.projection.directives[directiveId];
      if (directive?.targetExecutionId !== input.executionId || directive.status !== 'queued') {
        continue;
      }
      drafts.push({
        type: 'directive.undelivered',
        executionId: input.executionId,
        payload: {
          directiveId,
          status: 'expired',
          reason: 'the target execution finished before another model request',
        },
      });
    }
    this.commit(run, drafts);
    return outcome === 'succeeded'
      ? { ok: true }
      : { ok: false, reason: error ?? `execution ${outcome}` };
  }

  private finalizeOutput(run: LiveRun, outputNodeId: string) {
    const output = run.snapshot.definition.nodes.find((n) => n.id === outputNodeId);
    if (output?.type !== 'output') throw new Error('plan references a missing output node');
    const versions = output.inputBindings.flatMap((b) =>
      b.kind === 'task_output' ? this.submittedOutputOf(run, b.sourceNodeId ?? '') : [],
    );
    if (versions.length === 0) throw new Error('output has no submitted version');
    // The output and the run's success are one fact: readers never see one without the other.
    this.commit(run, [
      {
        type: 'output.finalized',
        payload: { nodeId: output.id, artifactVersionIds: versions, approvalId: null },
      },
      runState('running', 'succeeded', 'output_finalized'),
    ]);
  }

  // ── agent host: the only way an agent affects the run ─────────────────────

  private hostFor(run: LiveRun, input: AgentStartInput): AgentHost {
    const { executionId } = input;
    const agent: Actor = { kind: 'agent', id: executionId };
    let lastCall: { modelCallId: string; contextSnapshotId: string; effectId: string } | null =
      null;

    const requireActive = () => {
      const status = run.projection.executions[executionId]?.status;
      if (status !== 'active' || run.projection.status !== 'running' || this.storageError) {
        throw new Error(`execution ${executionId} is not active`);
      }
    };

    return {
      prepareModelRequest: async (): Promise<RequestPermit> => {
        requireActive();
        const limits = run.snapshot.definition.limits;
        if (Object.keys(run.projection.modelCalls).length >= limits.maxModelCalls) {
          throw new Error(`LIMIT_REACHED: ${limits.maxModelCalls} model calls`);
        }
        const modelCallId = this.ids.next('model_call');
        const contextSnapshotId = this.ids.next('context_snapshot');
        const effectId = this.ids.next('effect');
        // The snapshot takes every directive queued for this execution right now.
        const queued = run.projection.directiveOrder
          .map((id) => run.projection.directives[id])
          .filter((d) => d?.targetExecutionId === executionId && d.status === 'queued')
          .map((d) => ({ directiveId: d?.directiveId ?? '', text: d?.text ?? '' }));
        const directiveIds = queued.map((d) => d.directiveId);
        this.commit(run, [
          ...directiveIds.map(
            (directiveId): EventDraft => ({
              type: 'directive.attached',
              executionId,
              payload: { directiveId, contextSnapshotId, modelCallId },
            }),
          ),
          {
            type: 'model.request_prepared',
            executionId,
            payload: {
              executionId,
              modelCallId,
              contextSnapshotId,
              profile: input.modelProfile,
              configRevision: 0,
              directiveIds,
              inputArtifactVersionIds: input.inputs.flatMap((i) =>
                i.artifactVersionId ? [i.artifactVersionId] : [],
              ),
            },
          },
          {
            type: 'effect.admitted',
            executionId,
            payload: {
              effectId,
              kind: 'model_request',
              scope: executionId,
              epoch: input.attemptNo,
              reservationId: null,
            },
          },
          // The mock transport starts the request synchronously with the permit.
          ...directiveIds.map(
            (directiveId): EventDraft => ({
              type: 'directive.dispatched',
              executionId,
              payload: { directiveId, modelCallId, executionEpoch: input.attemptNo },
            }),
          ),
        ]);
        lastCall = { modelCallId, contextSnapshotId, effectId };
        return {
          modelCallId,
          contextSnapshotId,
          profile: input.modelProfile,
          maxOutputTokens: limits.maxOutputTokensPerCall,
          directives: queued,
        };
      },

      observe: async (observation: AgentObservation) => {
        requireActive();
        const effectId =
          lastCall?.modelCallId === observation.modelCallId ? lastCall.effectId : null;
        const settled: EventDraft[] = effectId
          ? [{ type: 'effect.settled', executionId, payload: { effectId, outcome: 'succeeded' } }]
          : [];
        this.commit(run, [
          {
            type: 'model.finished',
            actor: agent,
            executionId,
            payload: {
              executionId,
              modelCallId: observation.modelCallId,
              responseRef: null,
              rawUsage: observation.rawUsage ?? null,
              normalizedUsage: {
                inputTokens: observation.usage.inputTokens,
                outputTokens: observation.usage.outputTokens,
                cachedInputTokens: null,
                reasoningTokens: null,
              },
              certainty:
                observation.usage.inputTokens === null && observation.usage.outputTokens === null
                  ? 'unknown'
                  : 'reported',
            },
          },
          ...settled,
        ]);
      },

      invokeTool: async (proposal: ToolProposal): Promise<ToolOutcome> => {
        requireActive();
        const toolCallId = this.ids.next('tool_call');
        this.commit(run, [
          {
            type: 'tool.requested',
            actor: agent,
            executionId,
            payload: {
              executionId,
              toolCallId,
              name: proposal.name,
              validatedArgs: summarizeArgs(proposal.args),
            },
          },
        ]);
        const block = (error: CommandError): ToolOutcome => {
          this.commit(run, [
            {
              type: 'tool.blocked',
              executionId,
              payload: { executionId, toolCallId, reason: `${error.code}: ${error.message}` },
            },
          ]);
          return { ok: false, toolCallId, error };
        };

        if (proposal.name === 'write_artifact') {
          if (!input.role.allowedWorkTools.includes('write_artifact')) {
            return block({ code: 'CAPABILITY_DENIED', message: 'role may not write artifacts' });
          }
          const text = proposal.args.text;
          if (typeof text !== 'string') {
            return block({ code: 'SCHEMA_INVALID', message: 'text must be a string' });
          }
          const bytes = utf8ToBytes(text);
          if (bytes.length > this.policy.maxArtifactBytes) {
            return block({
              code: 'LIMIT_REACHED',
              message: `artifact versions are limited to ${this.policy.maxArtifactBytes} bytes`,
            });
          }
          const artifactVersionId = this.writeArtifact(run, input, text, bytes, lastCall, agent);
          return { ok: true, toolCallId, result: { artifactVersionId } };
        }

        if (proposal.name === 'submit_result') {
          if (!input.role.allowedCollaborationTools.includes('submit_result')) {
            return block({ code: 'CAPABILITY_DENIED', message: 'role may not submit results' });
          }
          const ids = proposal.args.artifactVersionIds;
          const owned =
            Array.isArray(ids) &&
            ids.length > 0 &&
            ids.every(
              (id) =>
                typeof id === 'string' &&
                run.projection.artifacts[id]?.authorExecutionId === executionId,
            );
          if (!owned) {
            return block({
              code: 'CAPABILITY_DENIED',
              message: 'only versions written by this execution can be submitted',
            });
          }
          this.commit(run, [
            {
              type: 'task.submitted',
              actor: agent,
              executionId,
              taskId: input.taskId,
              payload: { taskId: input.taskId, artifactVersionIds: ids as string[] },
            },
            {
              type: 'task.completed',
              taskId: input.taskId,
              payload: {
                taskId: input.taskId,
                completionEvidence: `${input.role.outputContract} contract: non-empty submission`,
              },
            },
          ]);
          return { ok: true, toolCallId, result: {} };
        }

        return block({ code: 'CAPABILITY_DENIED', message: `unknown tool ${proposal.name}` });
      },
    };
  }

  private writeArtifact(
    run: LiveRun,
    input: AgentStartInput,
    text: string,
    bytes: Uint8Array,
    lastCall: { modelCallId: string; contextSnapshotId: string } | null,
    agent: Actor,
  ): string {
    const existing = Object.values(run.projection.artifacts).filter(
      (a) => a.authorExecutionId === input.executionId,
    );
    const artifactId = existing[0]?.artifactId ?? this.ids.next('artifact');
    const parent = existing.at(-1)?.artifactVersionId ?? null;
    const artifactVersionId = this.ids.next('artifact_version');
    this.commit(
      run,
      [
        {
          type: 'artifact.version_created',
          actor: agent,
          executionId: input.executionId,
          taskId: input.taskId,
          payload: {
            artifactId,
            version: existing.length + 1,
            artifactVersionId,
            parentVersionId: parent,
            name: outputNameOf(run.snapshot.definition, input.nodeId),
            contract: input.role.outputContract,
            contentHash: bytesToHex(sha256(bytes)),
            byteLength: bytes.length,
            authorExecutionId: input.executionId,
            modelCallId: lastCall?.modelCallId ?? null,
            contextSnapshotId: lastCall?.contextSnapshotId ?? null,
          },
        },
      ],
      // The body is written in the same transaction as the event that names it.
      () => this.store.putArtifactText(run.runId, artifactVersionId, text),
    );
    return artifactVersionId;
  }
}

function runState(from: RunProjection['status'], to: RunProjection['status'], reasonCode: string) {
  return { type: 'run.state_changed', payload: { from, to, reasonCode } } satisfies EventDraft;
}

function outputNameOf(definition: CorralDefinition, nodeId: string): string {
  const node = definition.nodes.find((n) => n.id === nodeId);
  return node?.type === 'agent' ? node.outputName : nodeId;
}

/** Tool arguments for the audit log; long strings become their size and hash. */
function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 256) {
      const bytes = utf8ToBytes(value);
      summary[key] = { bytes: bytes.length, sha256: bytesToHex(sha256(bytes)) };
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

function hashOf(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
}

function rejected(
  commandId: string,
  runId: string,
  error: CommandError,
  target = `run:${runId}`,
): Receipt {
  return {
    commandId,
    runId,
    status: 'rejected',
    acceptedSeq: null,
    target,
    requestedBoundary: 'immediate',
    relatedEventIds: [],
    error,
  };
}

function conflict(commandId: string, runId: string): Receipt {
  return rejected(commandId, runId, {
    code: 'IDEMPOTENCY_CONFLICT',
    message: `command ${commandId} was already used with a different payload`,
  });
}

function unavailable(commandId: string, runId: string, reason: string | null): Receipt {
  return rejected(commandId, runId, {
    code: 'STORAGE_UNAVAILABLE',
    message: reason ?? 'facts can no longer be recorded',
  });
}

function schemaError(error: { issues: { path: PropertyKey[]; message: string }[] }): CommandError {
  const first = error.issues[0];
  return {
    code: 'SCHEMA_INVALID',
    message: first
      ? `${first.path.map(String).join('.') || '(root)'}: ${first.message}`
      : 'invalid',
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
