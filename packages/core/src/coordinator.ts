import {
  type AgentAdapter,
  type AgentHandle,
  type AgentHost,
  type AgentObservation,
  type AgentSettlement,
  type AgentStartInput,
  type Assignment,
  type Clock,
  type CommandError,
  type CorralDefinition,
  CreateRunRequest,
  type DecisionNode,
  type EventPayload,
  type IdFactory,
  type InputBinding,
  type ModelProfileSnapshot,
  type Receipt,
  type RequestPermit,
  type ResolvedInput,
  RunCommand,
  RunEvent,
  type RunEventType,
  type Scheduler,
  StartRunRequest,
  type SteerCommand,
  type StreamFrame,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
  type ToolAuthorization,
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
/** Recorded with every allowed tool call: role allowlists plus argument checks. */
const TOOL_POLICY_VERSION = 'role-allowlist@1';

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
  /** Model profiles per run mode (C-058). Defaults to simulated agents only. */
  models?: ModelResolver;
  /** Deadlines such as question timeouts. Without it, nothing times out. */
  timers?: Scheduler;
}

const NO_DEADLINES: Scheduler = { after: () => () => {} };

export type ModelResolution =
  | { ok: true; snapshot: ModelProfileSnapshot }
  | {
      ok: false;
      code: 'GRAPH_INVALID' | 'CAPABILITY_DENIED' | 'COMMAND_NOT_SUPPORTED';
      reason: string;
    };

/** Turns a role's model profile into the model a run will use, or says why it cannot. */
export interface ModelResolver {
  resolve(profile: string, mode: 'mock' | 'live'): ModelResolution;
}

/** The browser runtime and tests: every profile runs simulated; nothing runs live. */
export const SIMULATED_MODELS: ModelResolver = {
  resolve: (profile, mode) =>
    mode === 'mock'
      ? { ok: true, snapshot: { profile, provider: null, modelId: null, auth: 'mock' } }
      : {
          ok: false,
          code: 'COMMAND_NOT_SUPPORTED',
          reason: 'this runtime has no live model connection',
        },
};

interface Subscriber {
  runId: string;
  nextSeq: number;
  onEvent: (event: RunEvent) => void;
  onError: ((error: unknown) => void) | undefined;
  /** Transient text; only for subscribers present while it streams. */
  onFrame: ((frame: StreamFrame) => void) | undefined;
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
  /**
   * Model concurrency (Spec §9, CRL-RUN-005): a slot is held only while a model request is
   * open. A parent waiting for children or an answer holds none.
   */
  slots: { free: number; waiters: (() => void)[]; held: Map<string, string> };
  /** How every started execution ended, by task (await_tasks, a parent's own end). */
  taskOutcomes: Map<string, Promise<StepOutcome>>;
  /** Open questions and how to wake their askers. */
  questions: Map<string, OpenQuestion>;
  /** Executions whose cancel the Coordinator asked for: they settle as cancelled. */
  cancelRequested: Set<string>;
}

interface OpenQuestion {
  askerExecutionId: string;
  responderExecutionId: string;
  wake(result: Record<string, unknown>): void;
  cancelTimer(): void;
}

/** What starts an execution: its node, place in the call tree and reason to exist. */
interface ExecutionSpec {
  nodeId: string;
  iterationId: string | null;
  parentExecutionId: string | null;
  depth: number;
  assignment: Assignment;
  /** Inputs given by the caller (task brief, question), before the node's own bindings. */
  given: ResolvedInput[];
}

interface PreparedExecution {
  input: AgentStartInput;
  effectId: string;
  drafts: EventDraft[];
}

/** A refused tool call; `limit` marks the refusals that also record `limit.reached`. */
/** The opening and closing events every executed tool call commits. */
interface ToolFrame {
  toolCallId: string;
  opening: EventDraft[];
  closing(resultRef: string | null, error?: string | null): EventDraft[];
}

type Refusal = CommandError & {
  limit?: { kind: 'spawns' | 'questions' | 'depth'; used: number; max: number };
};

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
  private readonly models: ModelResolver;
  private readonly timers: Scheduler;
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
    this.models = deps.models ?? SIMULATED_MODELS;
    this.timers = deps.timers ?? NO_DEADLINES;
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
    // Every profile resolves now, so the run never meets an unusable model halfway.
    const models: Record<string, ModelProfileSnapshot> = {};
    const unusable: { code: CommandError['code']; message: string }[] = [];
    for (const profile of new Set(planned.definition.roles.map((r) => r.modelProfile))) {
      const resolution = this.models.resolve(profile, request.mode);
      if (resolution.ok) models[profile] = resolution.snapshot;
      else unusable.push({ code: resolution.code, message: `${profile}: ${resolution.reason}` });
    }
    const [firstUnusable] = unusable;
    if (firstUnusable) {
      return refuse({
        code: firstUnusable.code,
        message: unusable.map((u) => u.message).join('; '),
      });
    }
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
      models,
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
      slots: { free: definition.limits.maxModelConcurrency, waiters: [], held: new Map() },
      taskOutcomes: new Map(),
      questions: new Map(),
      cancelRequested: new Set(),
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
          modelProfiles: Object.values(models),
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
    onFrame?: (frame: StreamFrame) => void,
  ): () => void {
    if (!this.store.getRun(runId)) throw new Error(`run ${runId} does not exist`);
    const subscriber: Subscriber = { runId, nextSeq: afterSeq + 1, onEvent, onError, onFrame };
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
    const prepared = this.prepareExecution(run, {
      nodeId,
      iterationId,
      parentExecutionId: null,
      depth: 0,
      assignment: { kind: 'scheduled' },
      given: [],
    });
    this.commit(run, prepared.drafts);
    return this.launch(run, prepared);
  }

  /** The Task, Execution and start effect of one step, child or responder; not committed. */
  private prepareExecution(run: LiveRun, spec: ExecutionSpec): PreparedExecution {
    const definition = run.snapshot.definition;
    const node = definition.nodes.find((n) => n.id === spec.nodeId);
    const role = node?.type === 'agent' && definition.roles.find((r) => r.id === node.roleId);
    if (node?.type !== 'agent' || !role) {
      throw new Error(`plan references missing agent ${spec.nodeId}`);
    }
    const label = (id: string) => {
      const target = definition.nodes.find((n) => n.id === id);
      return { nodeId: id, label: target?.label ?? id };
    };
    const callables = run.plan.callables[spec.nodeId] ?? { delegate: [], question: [] };

    const taskId = this.ids.next('task');
    const executionId = this.ids.next('execution');
    const effectId = this.ids.next('effect');
    const attemptNo = 1;
    const input: AgentStartInput = {
      runId: run.runId,
      executionId,
      taskId,
      nodeId: spec.nodeId,
      attemptNo,
      role,
      modelProfile: role.modelProfile,
      mode: run.snapshot.mode,
      model: run.snapshot.models[role.modelProfile] ?? {
        profile: role.modelProfile,
        provider: null,
        modelId: null,
        auth: 'mock',
      },
      depth: spec.depth,
      assignment: spec.assignment,
      capabilities: {
        delegateTo: callables.delegate.map(label),
        askTo: callables.question.map(label),
      },
      inputs: [...spec.given, ...this.resolveInputs(run, node.inputBindings, spec.iterationId)],
    };
    const drafts: EventDraft[] = [
      {
        type: 'task.created',
        taskId,
        payload: {
          taskId,
          nodeId: spec.nodeId,
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
          parentExecutionId: spec.parentExecutionId,
          nodeId: spec.nodeId,
          taskId,
          attemptNo,
          depth: spec.depth,
          iterationId: spec.iterationId,
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
    ];
    return { input, effectId, drafts };
  }

  /** Starts a committed execution; resolves with how it ended. */
  private launch(run: LiveRun, prepared: PreparedExecution): Promise<StepOutcome> {
    const { input, effectId } = prepared;
    const outcome = (async () => {
      // Committed: only now does work leave the coordinator.
      let settlement: AgentSettlement;
      try {
        const handle = await this.agents.start(input, this.hostFor(run, input));
        run.handles.set(input.executionId, handle);
        if (run.cancelRequested.has(input.executionId)) await handle.cancel('cancelled');
        settlement = await handle.waitForSettlement();
      } catch (error) {
        settlement = { outcome: 'failed', error: String(error) };
      } finally {
        run.handles.delete(input.executionId);
      }
      // An execution owns its children: they end before it does (Spec §7.2).
      await this.cancelChildren(run, input.executionId, 'the parent execution ended');
      return this.settle(run, input, effectId, settlement);
    })();
    run.taskOutcomes.set(input.taskId, outcome);
    return outcome;
  }

  private liveChildren(run: LiveRun, executionId: string) {
    return Object.values(run.projection.executions).filter(
      (e) => e.parentExecutionId === executionId && !TERMINAL_EXECUTION_STATUSES.has(e.status),
    );
  }

  private async cancelChildren(run: LiveRun, executionId: string, reason: string) {
    const children = this.liveChildren(run, executionId);
    for (const child of children) this.requestCancel(run, child.executionId, reason);
    await Promise.all(children.map((child) => run.taskOutcomes.get(child.taskId)));
  }

  private requestCancel(run: LiveRun, executionId: string, reason: string) {
    run.cancelRequested.add(executionId);
    void run.handles
      .get(executionId)
      ?.cancel(reason)
      .catch(() => {});
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
    // The Coordinator decides: an execution it cancelled ends cancelled unless it finished.
    const cancelled = run.cancelRequested.has(input.executionId) && !submitted;
    const outcome = cancelled
      ? ('cancelled' as const)
      : settlement.outcome === 'succeeded' && !submitted
        ? ('failed' as const)
        : settlement.outcome;
    const error =
      !cancelled && settlement.outcome === 'succeeded' && !submitted
        ? input.assignment.kind === 'question'
          ? 'the responder finished without reply'
          : 'the agent finished without submit_result'
        : settlement.error;
    this.releaseSlots(run, input.executionId);

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
    // A responder that ends without answering closes its question; the asker is told.
    const unanswered = [...run.questions].find(
      ([, q]) => q.responderExecutionId === input.executionId,
    );
    if (unanswered) {
      const [questionId, question] = unanswered;
      run.questions.delete(questionId);
      question.cancelTimer();
      drafts.push(...this.askerResumes(run, question.askerExecutionId, questionId, 'cancelled'));
      this.commit(run, drafts);
      question.wake({ questionId, outcome: 'cancelled' });
    } else {
      this.commit(run, drafts);
    }
    return outcome === 'succeeded'
      ? { ok: true }
      : { ok: false, reason: error ?? `execution ${outcome}` };
  }

  // ── model slots ───────────────────────────────────────────────────────────

  private acquireSlot(run: LiveRun): Promise<void> {
    if (run.slots.free > 0) {
      run.slots.free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => run.slots.waiters.push(resolve));
  }

  private releaseSlot(run: LiveRun) {
    const next = run.slots.waiters.shift();
    if (next) next();
    else run.slots.free += 1;
  }

  private releaseSlots(run: LiveRun, executionId: string) {
    for (const [modelCallId, owner] of run.slots.held) {
      if (owner !== executionId) continue;
      run.slots.held.delete(modelCallId);
      this.releaseSlot(run);
    }
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

    // Authorized calls of this execution; each may run once.
    const authorized = new Map<string, { proposal: ToolProposal; ran: boolean }>();

    const authorizeTool = async (proposal: ToolProposal): Promise<ToolAuthorization> => {
      requireActive();
      const toolCallId = this.ids.next('tool_call');
      const refusal = this.toolRefusal(run, input, proposal);
      const error: CommandError | null = refusal
        ? { code: refusal.code, message: refusal.message }
        : null;
      const questionId = proposal.args.questionId;
      const late =
        proposal.name === 'reply' &&
        typeof questionId === 'string' &&
        run.projection.questions[questionId] &&
        run.projection.questions[questionId]?.status !== 'open';
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
        error
          ? {
              type: 'tool.blocked',
              executionId,
              payload: { executionId, toolCallId, reason: `${error.code}: ${error.message}` },
            }
          : {
              type: 'tool.allowed',
              executionId,
              payload: { executionId, toolCallId, policyVersion: TOOL_POLICY_VERSION },
            },
        ...(refusal?.limit
          ? [
              {
                type: 'limit.reached',
                executionId,
                payload: {
                  limitKind: refusal.limit.kind,
                  used: refusal.limit.used,
                  reserved: 0,
                  max: refusal.limit.max,
                },
              } satisfies EventDraft,
            ]
          : []),
        // A reply after the question closed is kept as an audit fact only (Technical-Design §8.3).
        ...(late
          ? [
              {
                type: 'observation.late',
                executionId,
                payload: {
                  originalEventType: 'reply',
                  originalRef: questionId as string,
                  whyIgnored: `the question was already ${run.projection.questions[questionId as string]?.status}`,
                },
              } satisfies EventDraft,
            ]
          : []),
      ]);
      if (error) return { ok: false, toolCallId, error };
      authorized.set(toolCallId, { proposal, ran: false });
      return { ok: true, toolCallId };
    };

    const executeTool = async (toolCallId: string): Promise<ToolOutcome> => {
      requireActive();
      const call = authorized.get(toolCallId);
      if (!call || call.ran) {
        return {
          ok: false,
          toolCallId,
          error: {
            code: 'CAPABILITY_DENIED',
            message: call ? 'this tool call already ran' : 'this tool call was not authorized',
          },
        };
      }
      call.ran = true;
      const effectId = this.ids.next('effect');
      const opening: EventDraft[] = [
        {
          type: 'effect.admitted',
          executionId,
          payload: {
            effectId,
            kind: 'tool',
            scope: executionId,
            epoch: input.attemptNo,
            reservationId: null,
          },
        },
        { type: 'tool.started', executionId, payload: { executionId, toolCallId, effectId } },
      ];
      const closing = (resultRef: string | null, error: string | null = null): EventDraft[] => [
        {
          type: 'tool.finished',
          executionId,
          payload: { executionId, toolCallId, resultRef, error },
        },
        {
          type: 'effect.settled',
          executionId,
          payload: { effectId, outcome: error ? 'failed' : 'succeeded' },
        },
      ];
      const tool = { opening, closing, toolCallId };
      switch (call.proposal.name) {
        case 'spawn_subagents':
          return this.spawnTool(run, input, call.proposal, tool);
        case 'await_tasks':
          return this.awaitTool(run, input, call.proposal, tool);
        case 'ask':
          return this.askTool(run, input, call.proposal, tool);
        case 'reply':
          return this.replyTool(run, input, call.proposal, tool);
        case 'read_artifact':
          return this.readTool(run, input, call.proposal, tool);
      }
      const { drafts, result, extra } = this.toolDrafts(
        run,
        input,
        call.proposal,
        lastCall,
        agent,
        tool,
      );
      this.commit(run, drafts, extra);
      return { ok: true, toolCallId, result };
    };

    return {
      prepareModelRequest: async (): Promise<RequestPermit> => {
        requireActive();
        const limits = run.snapshot.definition.limits;
        if (Object.keys(run.projection.modelCalls).length >= limits.maxModelCalls) {
          throw new Error(`LIMIT_REACHED: ${limits.maxModelCalls} model calls`);
        }
        // Wait for a model slot; a waiting execution is not in a request and holds none.
        await this.acquireSlot(run);
        try {
          requireActive();
        } catch (error) {
          this.releaseSlot(run);
          throw error;
        }
        const modelCallId = this.ids.next('model_call');
        const contextSnapshotId = this.ids.next('context_snapshot');
        const effectId = this.ids.next('effect');
        run.slots.held.set(modelCallId, executionId);
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
        if (run.slots.held.delete(observation.modelCallId)) this.releaseSlot(run);
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
                cachedInputTokens: observation.usage.cachedInputTokens ?? null,
                reasoningTokens: observation.usage.reasoningTokens ?? null,
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
        const authorization = await authorizeTool(proposal);
        return authorization.ok ? executeTool(authorization.toolCallId) : authorization;
      },
      authorizeTool: (proposal) => authorizeTool(proposal),
      executeTool: (toolCallId) => executeTool(toolCallId),

      streamText: (delta) => {
        // Only the open request of this execution streams; anything else is dropped.
        const call = run.projection.modelCalls[delta.modelCallId];
        if (lastCall?.modelCallId !== delta.modelCallId || !call || call.finished) return;
        if (run.projection.executions[executionId]?.status !== 'active') return;
        this.publishFrame({ runId: run.runId, ...delta });
      },
    };
  }

  /**
   * Every check that decides whether a tool call may run (CRL-SEC-001, CRL-RUN-004,
   * CRL-COL-002/003). Pure: nothing happens until an authorized call is executed. Unknown
   * tools, shell or code tools included, are refused: role allowlists name only Corral tools.
   */
  private toolRefusal(
    run: LiveRun,
    input: AgentStartInput,
    proposal: ToolProposal,
  ): Refusal | null {
    const { args } = proposal;
    const p = run.projection;
    const limits = run.snapshot.definition.limits;
    const collaboration = input.role.allowedCollaborationTools as readonly string[];
    const denied = (message: string): Refusal => ({ code: 'CAPABILITY_DENIED', message });
    if (proposal.name !== 'write_artifact' && proposal.name !== 'submit_result') {
      if (!collaboration.includes(proposal.name)) {
        return denied(
          ['spawn_subagents', 'await_tasks', 'ask', 'reply', 'read_artifact'].includes(
            proposal.name,
          )
            ? `role may not use ${proposal.name}`
            : `unknown tool ${proposal.name}`,
        );
      }
    }
    const callables = run.plan.callables[input.nodeId] ?? { delegate: [], question: [] };
    // Children and responders share one budget of dynamic executions (Spec §7.2).
    const spawned = Object.values(p.executions).filter((e) => e.parentExecutionId !== null).length;
    const live = Object.values(p.executions).filter(
      (e) => !TERMINAL_EXECUTION_STATUSES.has(e.status),
    ).length;
    const capacity = (count: number): Refusal | null => {
      if (input.depth + 1 > limits.maxDelegationDepth) {
        return {
          code: 'LIMIT_REACHED',
          message: `delegation depth is limited to ${limits.maxDelegationDepth}`,
          limit: { kind: 'depth', used: input.depth, max: limits.maxDelegationDepth },
        };
      }
      if (spawned + count > limits.maxSpawns) {
        return {
          code: 'LIMIT_REACHED',
          message: `this run may start ${limits.maxSpawns} delegated or responding executions`,
          limit: { kind: 'spawns', used: spawned, max: limits.maxSpawns },
        };
      }
      // Reserve resident capacity for the whole batch, or none of it (Technical-Design §8.1).
      if (live + count > this.policy.maxResidentExecutions) {
        return {
          code: 'RESOURCE_CAPACITY',
          message: `at most ${this.policy.maxResidentExecutions} executions may be alive at once`,
        };
      }
      return null;
    };

    switch (proposal.name) {
      case 'write_artifact': {
        if (!input.role.allowedWorkTools.includes('write_artifact')) {
          return denied('role may not write artifacts');
        }
        if (typeof args.text !== 'string') {
          return { code: 'SCHEMA_INVALID', message: 'text must be a string' };
        }
        if (utf8ToBytes(args.text).length > this.policy.maxArtifactBytes) {
          return {
            code: 'LIMIT_REACHED',
            message: `artifact versions are limited to ${this.policy.maxArtifactBytes} bytes`,
          };
        }
        return null;
      }
      case 'submit_result': {
        if (!input.role.allowedCollaborationTools.includes('submit_result')) {
          return denied('role may not submit results');
        }
        const ids = args.artifactVersionIds;
        const owned =
          Array.isArray(ids) &&
          ids.length > 0 &&
          ids.every(
            (id) =>
              typeof id === 'string' && p.artifacts[id]?.authorExecutionId === input.executionId,
          );
        return owned ? null : denied('only versions written by this execution can be submitted');
      }
      case 'spawn_subagents': {
        const tasks = args.tasks;
        if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 4) {
          return { code: 'SCHEMA_INVALID', message: 'tasks must list 1 to 4 tasks' };
        }
        for (const task of tasks as { targetNodeId?: unknown; brief?: unknown }[]) {
          if (typeof task?.brief !== 'string' || !task.brief.trim() || task.brief.length > 4000) {
            return {
              code: 'SCHEMA_INVALID',
              message: 'each task needs a brief of 1 to 4000 characters',
            };
          }
          if (
            typeof task.targetNodeId !== 'string' ||
            !callables.delegate.includes(task.targetNodeId)
          ) {
            return denied(
              `${input.nodeId} may not delegate to ${String(task?.targetNodeId)}: no capability link`,
            );
          }
        }
        return capacity(tasks.length);
      }
      case 'await_tasks': {
        const ids = args.taskIds;
        if (!Array.isArray(ids) || ids.length === 0) {
          return { code: 'SCHEMA_INVALID', message: 'taskIds must list the tasks to wait for' };
        }
        const mine = new Set(
          Object.values(p.executions)
            .filter((e) => e.parentExecutionId === input.executionId)
            .map((e) => e.taskId),
        );
        return ids.every((id) => typeof id === 'string' && mine.has(id))
          ? null
          : denied('only tasks this execution started can be awaited');
      }
      case 'ask': {
        if (typeof args.body !== 'string' || !args.body.trim() || args.body.length > 12000) {
          return { code: 'SCHEMA_INVALID', message: 'body must be 1 to 12000 characters' };
        }
        if (
          typeof args.targetNodeId !== 'string' ||
          !callables.question.includes(args.targetNodeId)
        ) {
          return denied(
            `${input.nodeId} may not ask ${String(args.targetNodeId)}: no capability link`,
          );
        }
        const asked = Object.keys(p.questions).length;
        if (asked >= limits.maxQuestions) {
          return {
            code: 'LIMIT_REACHED',
            message: `this run may ask ${limits.maxQuestions} questions`,
            limit: { kind: 'questions', used: asked, max: limits.maxQuestions },
          };
        }
        return capacity(1);
      }
      case 'reply': {
        const question = p.questions[String(args.questionId)];
        if (typeof args.body !== 'string' || !args.body.trim() || args.body.length > 12000) {
          return { code: 'SCHEMA_INVALID', message: 'body must be 1 to 12000 characters' };
        }
        const open =
          typeof args.questionId === 'string' ? run.questions.get(args.questionId) : undefined;
        if (!question || open?.responderExecutionId !== input.executionId) {
          return question && question.status !== 'open'
            ? {
                code: 'TARGET_TERMINAL',
                message: `question ${question.questionId} is already ${question.status}`,
              }
            : denied('this execution was not asked that question');
        }
        return null;
      }
      case 'read_artifact': {
        const id = args.artifactVersionId;
        if (typeof id !== 'string' || !p.artifacts[id]) {
          return { code: 'TARGET_NOT_FOUND', message: 'no such artifact version' };
        }
        return this.readable(run, input).has(id)
          ? null
          : denied('this version is not in this execution’s scope');
      }
    }
    return denied(`unknown tool ${proposal.name}`);
  }

  /**
   * What an execution may read: its own versions, its inputs, what its children submitted,
   * the versions a question to it refers to, and the evidence of answers it received.
   */
  private readable(run: LiveRun, input: AgentStartInput): Set<string> {
    const p = run.projection;
    const ids = new Set<string>();
    for (const a of Object.values(p.artifacts))
      if (a.authorExecutionId === input.executionId) ids.add(a.artifactVersionId);
    for (const i of input.inputs) if (i.artifactVersionId) ids.add(i.artifactVersionId);
    for (const child of Object.values(p.executions)) {
      if (child.parentExecutionId !== input.executionId) continue;
      for (const id of p.tasks[child.taskId]?.submittedArtifactVersionIds ?? []) ids.add(id);
    }
    for (const q of Object.values(p.questions)) {
      if (input.assignment.kind === 'question' && q.questionId === input.assignment.questionId) {
        for (const id of q.artifactRefs) ids.add(id);
      }
      if (q.senderExecutionId === input.executionId) {
        for (const id of q.answer?.evidenceRefs ?? []) ids.add(id);
      }
    }
    return ids;
  }

  /** The commit for write_artifact or submit_result: its effect, lifecycle and result. */
  private toolDrafts(
    run: LiveRun,
    input: AgentStartInput,
    proposal: ToolProposal,
    lastCall: { modelCallId: string; contextSnapshotId: string } | null,
    agent: Actor,
    tool: ToolFrame,
  ): { drafts: EventDraft[]; result: Record<string, unknown>; extra?: () => void } {
    const { executionId, taskId } = input;
    if (proposal.name === 'write_artifact') {
      const text = proposal.args.text as string;
      const bytes = utf8ToBytes(text);
      const existing = Object.values(run.projection.artifacts).filter(
        (a) => a.authorExecutionId === executionId,
      );
      const artifactId = existing[0]?.artifactId ?? this.ids.next('artifact');
      const artifactVersionId = this.ids.next('artifact_version');
      return {
        drafts: [
          ...tool.opening,
          {
            type: 'artifact.version_created',
            actor: agent,
            executionId,
            taskId,
            payload: {
              artifactId,
              version: existing.length + 1,
              artifactVersionId,
              parentVersionId: existing.at(-1)?.artifactVersionId ?? null,
              name: outputNameOf(run.snapshot.definition, input.nodeId),
              contract: input.role.outputContract,
              contentHash: bytesToHex(sha256(bytes)),
              byteLength: bytes.length,
              authorExecutionId: executionId,
              modelCallId: lastCall?.modelCallId ?? null,
              contextSnapshotId: lastCall?.contextSnapshotId ?? null,
            },
          },
          ...tool.closing(artifactVersionId),
        ],
        result: { artifactVersionId },
        // The body is written in the same transaction as the event that names it.
        extra: () => this.store.putArtifactText(run.runId, artifactVersionId, text),
      };
    }
    const ids = proposal.args.artifactVersionIds as string[];
    return {
      drafts: [
        ...tool.opening,
        {
          type: 'task.submitted',
          actor: agent,
          executionId,
          taskId,
          payload: { taskId, artifactVersionIds: ids },
        },
        {
          type: 'task.completed',
          taskId,
          payload: {
            taskId,
            completionEvidence: `${input.role.outputContract} contract: non-empty submission`,
          },
        },
        ...tool.closing(null),
      ],
      result: {},
    };
  }

  // ── collaboration tools (C-022–C-024) ─────────────────────────────────────

  /** Starts children of the caller in one commit, then each child's agent. */
  private async spawnTool(
    run: LiveRun,
    input: AgentStartInput,
    proposal: ToolProposal,
    tool: ToolFrame,
  ): Promise<ToolOutcome> {
    const tasks = proposal.args.tasks as { targetNodeId: string; brief: string }[];
    const children = tasks.map((task) =>
      this.prepareExecution(run, {
        nodeId: task.targetNodeId,
        iterationId: run.projection.executions[input.executionId]?.iterationId ?? null,
        parentExecutionId: input.executionId,
        depth: input.depth + 1,
        assignment: { kind: 'delegated', brief: task.brief, parentExecutionId: input.executionId },
        given: [{ name: 'task', kind: 'run_input', artifactVersionId: null, text: task.brief }],
      }),
    );
    this.commit(run, [
      ...tool.opening,
      ...children.flatMap((child) => child.drafts),
      ...tool.closing(null),
    ]);
    for (const child of children) void this.launch(run, child);
    return {
      ok: true,
      toolCallId: tool.toolCallId,
      result: { taskIds: children.map((c) => c.input.taskId) },
    };
  }

  /** Waits for the caller's children; the caller holds no model slot meanwhile. */
  private async awaitTool(
    run: LiveRun,
    input: AgentStartInput,
    proposal: ToolProposal,
    tool: ToolFrame,
  ): Promise<ToolOutcome> {
    const { executionId } = input;
    const taskIds = proposal.args.taskIds as string[];
    const p = run.projection;
    const targetIds = taskIds.map(
      (taskId) =>
        Object.values(p.executions).find((e) => e.taskId === taskId)?.executionId ?? taskId,
    );
    this.commit(run, [
      ...tool.opening,
      {
        type: 'execution.state_changed',
        executionId,
        payload: {
          executionId,
          from: 'active',
          to: 'waiting_children',
          activity: null,
          waitingOn: {
            kind: 'children',
            targetIds,
            reasonCode: 'awaiting_delegated_tasks',
            since: this.clock.nowIso(),
            deadline: null,
            required: true,
          },
        },
      },
    ]);
    await Promise.all(taskIds.map((taskId) => run.taskOutcomes.get(taskId)));
    const results = taskIds.map((taskId) => {
      const task = run.projection.tasks[taskId];
      return {
        taskId,
        status: task?.status ?? 'failed',
        artifactVersionIds: task?.status === 'completed' ? task.submittedArtifactVersionIds : [],
      };
    });
    this.commit(run, [
      {
        type: 'execution.state_changed',
        executionId,
        payload: {
          executionId,
          from: 'waiting_children',
          to: 'active',
          activity: 'model',
          waitingOn: null,
        },
      },
      ...tool.closing(null),
    ]);
    return { ok: true, toolCallId: tool.toolCallId, result: { tasks: results } };
  }

  /** A question becomes a new responder task under the asker, answered once or closed. */
  private async askTool(
    run: LiveRun,
    input: AgentStartInput,
    proposal: ToolProposal,
    tool: ToolFrame,
  ): Promise<ToolOutcome> {
    const { executionId } = input;
    const targetNodeId = proposal.args.targetNodeId as string;
    const body = proposal.args.body as string;
    const artifactRefs = (
      Array.isArray(proposal.args.artifactRefs) ? proposal.args.artifactRefs : []
    ).filter((id): id is string => typeof id === 'string' && Boolean(run.projection.artifacts[id]));
    const questionId = this.ids.next('question');
    const timeoutMs = run.snapshot.definition.limits.questionTimeoutMs;
    const deadline = new Date(Date.parse(this.clock.nowIso()) + timeoutMs).toISOString();
    const responder = this.prepareExecution(run, {
      nodeId: targetNodeId,
      iterationId: run.projection.executions[executionId]?.iterationId ?? null,
      parentExecutionId: executionId,
      depth: input.depth + 1,
      assignment: { kind: 'question', questionId, body, askerExecutionId: executionId },
      given: [
        { name: 'question', kind: 'run_input', artifactVersionId: null, text: body },
        ...artifactRefs.map((id) => ({
          name: 'reference',
          kind: 'explicit_version' as const,
          artifactVersionId: id,
          text: this.store.getArtifactText(run.runId, id) ?? '',
        })),
      ],
    });
    const role = run.snapshot.definition.nodes.find((n) => n.id === targetNodeId);

    const answer = new Promise<Record<string, unknown>>((resolve) => {
      run.questions.set(questionId, {
        askerExecutionId: executionId,
        responderExecutionId: responder.input.executionId,
        wake: resolve,
        cancelTimer: this.timers.after(timeoutMs, () => this.timeOut(run, questionId)),
      });
    });
    this.commit(run, [
      ...tool.opening,
      {
        type: 'message.question_created',
        actor: { kind: 'agent', id: executionId },
        executionId,
        payload: {
          questionId,
          taskId: responder.input.taskId,
          senderExecutionId: executionId,
          targetRoleId: role?.type === 'agent' ? role.roleId : targetNodeId,
          targetNodeId,
          body,
          artifactRefs,
          deadline,
        },
      },
      ...responder.drafts,
      {
        type: 'execution.state_changed',
        executionId,
        payload: {
          executionId,
          from: 'active',
          to: 'waiting_message',
          activity: null,
          waitingOn: {
            kind: 'message',
            targetIds: [questionId],
            reasonCode: 'awaiting_answer',
            since: this.clock.nowIso(),
            deadline,
            required: true,
          },
        },
      },
    ]);
    void this.launch(run, responder);
    const result = await answer;
    const closed = result.outcome === 'answered' ? questionId : null;
    this.commit(run, tool.closing(closed, closed ? null : `question ${result.outcome}`));
    return { ok: true, toolCallId: tool.toolCallId, result };
  }

  /** The asker leaves waiting_message in the commit that closes its question. */
  private askerResumes(
    run: LiveRun,
    askerExecutionId: string,
    questionId: string,
    outcome: 'answered' | 'cancelled' | 'timed_out',
    answerRef: string | null = null,
  ): EventDraft[] {
    const asker = run.projection.executions[askerExecutionId];
    return [
      { type: 'message.closed', payload: { questionId, outcome, answerRef } },
      ...(asker?.status === 'waiting_message'
        ? [
            {
              type: 'execution.state_changed',
              executionId: askerExecutionId,
              payload: {
                executionId: askerExecutionId,
                from: 'waiting_message',
                to: 'active',
                activity: 'model',
                waitingOn: null,
              },
            } satisfies EventDraft,
          ]
        : []),
    ];
  }

  private timeOut(run: LiveRun, questionId: string) {
    const question = run.questions.get(questionId);
    if (!question || this.storageError) return;
    run.questions.delete(questionId);
    try {
      this.commit(run, this.askerResumes(run, question.askerExecutionId, questionId, 'timed_out'));
    } catch {
      return;
    }
    // The responder's work is no longer wanted; a reply it still sends is only audited.
    this.requestCancel(run, question.responderExecutionId, 'the question timed out');
    question.wake({ questionId, outcome: 'timed_out' });
  }

  /** The single answer to an open question; the responder's task completes with it. */
  private async replyTool(
    run: LiveRun,
    input: AgentStartInput,
    proposal: ToolProposal,
    tool: ToolFrame,
  ): Promise<ToolOutcome> {
    const questionId = proposal.args.questionId as string;
    const question = run.questions.get(questionId);
    if (!question) {
      // Closed between authorization and execution (a timeout won the race).
      this.commit(run, tool.closing(null, 'the question already closed'));
      return {
        ok: false,
        toolCallId: tool.toolCallId,
        error: { code: 'TARGET_TERMINAL', message: 'the question already closed' },
      };
    }
    run.questions.delete(questionId);
    question.cancelTimer();
    const body = proposal.args.body as string;
    const evidenceRefs = (
      Array.isArray(proposal.args.evidenceRefs) ? proposal.args.evidenceRefs : []
    ).filter((id): id is string => typeof id === 'string' && Boolean(run.projection.artifacts[id]));
    this.commit(run, [
      ...tool.opening,
      {
        type: 'message.answer_committed',
        actor: { kind: 'agent', id: input.executionId },
        executionId: input.executionId,
        payload: {
          questionId,
          responseTaskId: input.taskId,
          responderExecutionId: input.executionId,
          body,
          evidenceRefs,
        },
      },
      {
        type: 'task.completed',
        taskId: input.taskId,
        payload: { taskId: input.taskId, completionEvidence: `answered question ${questionId}` },
      },
      ...this.askerResumes(run, question.askerExecutionId, questionId, 'answered', questionId),
      ...tool.closing(questionId),
    ]);
    question.wake({ questionId, outcome: 'answered', body, evidenceRefs });
    return { ok: true, toolCallId: tool.toolCallId, result: { questionId } };
  }

  /** Returns a version's text and records who read it (C-024). */
  private async readTool(
    run: LiveRun,
    input: AgentStartInput,
    proposal: ToolProposal,
    tool: ToolFrame,
  ): Promise<ToolOutcome> {
    const id = proposal.args.artifactVersionId as string;
    const text = this.store.getArtifactText(run.runId, id) ?? '';
    this.commit(run, [
      ...tool.opening,
      {
        type: 'artifact.read',
        executionId: input.executionId,
        payload: {
          requestedRef: id,
          resolvedVersionId: id,
          consumerExecutionId: input.executionId,
        },
      },
      ...tool.closing(id),
    ]);
    return { ok: true, toolCallId: tool.toolCallId, result: { artifactVersionId: id, text } };
  }

  private publishFrame(frame: StreamFrame) {
    for (const subscriber of this.subscribers) {
      if (subscriber.runId !== frame.runId || !subscriber.onFrame) continue;
      try {
        subscriber.onFrame(frame);
      } catch {
        // Frames are best effort; the committed log is the record.
      }
    }
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
