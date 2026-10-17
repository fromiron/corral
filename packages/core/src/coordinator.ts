import {
  type AgentAdapter,
  type AgentHandle,
  type AgentHost,
  type AgentObservation,
  type AgentSettlement,
  type AgentStartInput,
  type AnswerExtensionUiCommand,
  type Assignment,
  type BrokerFileToolName,
  type Clock,
  type CommandError,
  type CorralDefinition,
  CreateRunRequest,
  type DecisionCancellation,
  type DecisionNode,
  EffectiveHarnessSnapshot,
  type EventPayload,
  ExtensionUiNotice,
  ExtensionUiRequest,
  type ExtensionUiResult,
  FILE_TOOLS,
  type HarnessBindingRef,
  HarnessReport,
  type IdFactory,
  type InputBinding,
  type ModelProfileSnapshot,
  ModelRequestRecord,
  ProviderPayloadRecord,
  type Receipt,
  type RequestPermit,
  type ResolveApprovalCommand,
  type ResolvedInput,
  ReviewArtifact,
  RunCommand,
  RunEvent,
  type RunEventType,
  type RunLimits,
  type RunReference,
  type Scheduler,
  StartRunRequest,
  type SteerCommand,
  type StreamFrame,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
  type ToolAuthorization,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolProposal,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  type AdmissionConfig,
  type AdmissionGates,
  type AdmissionObserver,
  type GateDecision,
  type ModelGateView,
  notifyObservers,
  type ObserverContext,
  resolveGates,
  runGates,
  type ToolGateView,
} from './admission/index.ts';
import { admitModelRequest, settlementFor } from './budget.ts';
import { canonicalJson } from './canonical-json.ts';
import type { CompiledPlan } from './compiler/index.ts';
import { type InstallationPolicy, limitViolations, SPEC_HARD_CAPS } from './config.ts';
import {
  createDecisionHub,
  type JudgmentConfig,
  requestTiming,
  resolveDecisionSettings,
} from './decisions/index.ts';
import { definitionHash } from './definition-hash.ts';
import { LogicalDeadline } from './limits.ts';
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

export interface ToolCancellation {
  readonly aborted: boolean;
  onCancel(fn: () => void): () => void;
}
export interface ExternalTools {
  execute(
    input: {
      name: 'search' | 'read_document';
      args: Record<string, unknown>;
      mode: 'mock' | 'live';
      runId: string;
      executionId: string;
    },
    cancellation: ToolCancellation,
  ): Promise<Record<string, unknown>>;
}

/**
 * Files in a session's managed worktree (CR-012). The runtime that has worktrees provides it;
 * a run may use file tools only when `available` says its session has one.
 */
export interface FileTools {
  available(runId: string): boolean;
  planCheck?(
    input: import('@corral/contracts').CheckExecution,
    cancellation: ToolCancellation,
  ): Promise<import('@corral/contracts').CheckPlan>;
  runCheck?(
    input: import('@corral/contracts').CheckExecution,
    plan: import('@corral/contracts').CheckPlan,
    approvedFingerprint: string | null,
    cancellation: ToolCancellation,
  ): Promise<import('@corral/contracts').VerificationReport & { stale: boolean }>;
  execute(
    input: {
      name: BrokerFileToolName;
      args: Record<string, unknown>;
      runId: string;
      executionId: string;
      toolCallId: string;
    },
    cancellation: ToolCancellation,
  ): Promise<Record<string, unknown>>;
}

/** A refusal a tool backend explains to the agent (no local paths in the message). */
export class ToolRefusal extends Error {
  readonly code: CommandError['code'];
  constructor(code: CommandError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface CoordinatorDeps {
  tools?: ExternalTools;
  files?: FileTools;
  harnesses?: HarnessResolver;
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
  /** Admission gates and observers (ADR-024). Defaults to today's checks, no observers. */
  admission?: AdmissionConfig;
  /** reasoning_effort judgment providers and workspace settings (CR-003). Observe only. */
  judgments?: JudgmentConfig;
}

/** Resolves immutable, trusted revisions without importing extension code. */
export interface HarnessResolver {
  resolve(
    binding: HarnessBindingRef,
    definition: CorralDefinition,
    roleId: string,
  ): EffectiveHarnessSnapshot | null;
  readSkill?(snapshot: EffectiveHarnessSnapshot, path: string): Record<string, unknown>;
}

const NO_DEADLINES: Scheduler = { after: () => () => {} };
const TERMINAL_TASK = new Set(['failed', 'cancelled']);

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
  closingExecutions: Set<string>;
  /** Pending approvals and how to continue once the person decides (C-029). */
  approvals: Map<string, (decision: 'approve' | 'reject') => void>;
  extensionUi: Map<string, PendingExtensionUi>;
  uiRequestCount: number;
  uiNoticeCount: number;
  /** The inputs each execution was started with: what a reviewer actually reviewed. */
  inputsByExecution: Map<string, ResolvedInput[]>;
  /** What each execution was started with, for judgments of its requests (CR-003). */
  startInputs: Map<string, AgentStartInput>;
  /** Why a Loop stopped at its cap: the person declined, or the hard cap was reached. */
  limits: RunLimits;
  criteriaVersionId: string;
  pendingCriteriaVersionId: string | null;
  cancelDeadline: () => void;
  requestDeadlines: Map<string, () => void>;
  nodePatches: Map<
    string,
    {
      patchId: string;
      modelProfile: string;
      model: ModelProfileSnapshot;
      prompt: string;
      revision: number;
    }
  >;
  assignments: Map<string, ExecutionSpec>;
  executionOutcomes: Map<string, Promise<StepOutcome>>;
  boundaries: Set<string>;
  boundaryWaiters: Set<() => void>;
  cancelListeners: Map<string, Set<() => void>>;
  toolOutcomes: Map<string, Set<Promise<ToolOutcome>>>;
  capStop: 'declined' | 'hard_cap' | null;
}

interface OpenQuestion {
  askerExecutionId: string;
  responderExecutionId: string;
  wake(result: Record<string, unknown>): void;
  cancelTimer(): void;
  deadline: LogicalDeadline;
}

interface PendingExtensionUi {
  requestId: string;
  input: AgentStartInput;
  request: ExtensionUiRequest;
  due: number;
  finish(result: ExtensionUiResult): void;
}

/** What starts an execution: its node, place in the call tree and reason to exist. */
interface ExecutionSpec {
  previousExecutionId?: string;
  taskId?: string;
  attemptNo?: number;
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
  effectId: string;
  toolCallId: string;
  opening: EventDraft[];
  closing(resultRef: string | null, error?: string | null): EventDraft[];
}

type Refusal = Extract<GateDecision, { kind: 'refuse' }>;

/** Tool stages admit or refuse; a gate asking for a person's approval is a refusal there. */
function toolRefusal(decision: GateDecision): Refusal | null {
  if (decision.kind === 'allow') return null;
  if (decision.kind === 'refuse') return decision;
  return {
    kind: 'refuse',
    code: 'CAPABILITY_DENIED',
    message: 'a tool call cannot wait for a person’s approval',
  };
}

class StorageUnavailableError extends Error {}

export class Coordinator {
  private readonly clock: Clock;
  private readonly ids: IdFactory;
  private readonly agents: AgentAdapter;
  private readonly store: RunStore;
  private readonly runner: GraphRunner;
  private readonly decisions: DecisionPolicy | undefined;
  private readonly gates: AdmissionGates;
  private readonly observers: readonly AdmissionObserver[];
  private readonly judgments: JudgmentConfig | undefined;
  private readonly corrals: DefinitionSource | undefined;
  private readonly sessionId: string;
  private readonly policy: InstallationPolicy;
  private readonly models: ModelResolver;
  private readonly timers: Scheduler;
  private readonly tools: ExternalTools | undefined;
  private readonly files: FileTools | undefined;
  private readonly harnesses: HarnessResolver | undefined;
  private readonly live = new Map<string, LiveRun>();
  private readonly subscribers = new Set<Subscriber>();
  private storageError: string | null = null;
  private terminationUnconfirmed = false;
  private readonly drainingRuns = new Set<LiveRun>();

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
    this.tools = deps.tools;
    this.files = deps.files;
    this.harnesses = deps.harnesses;
    this.gates = resolveGates(deps.admission);
    this.judgments = deps.judgments;
    this.observers = [
      ...(deps.admission?.observers ?? []),
      ...(deps.judgments
        ? [
            createDecisionHub({
              providers: deps.judgments.providers,
              settingsOf: (runId) => this.live.get(runId)?.projection.decisionSettings ?? null,
              startInputOf: (runId, executionId) =>
                this.live.get(runId)?.startInputs.get(executionId) ?? null,
            }),
          ]
        : []),
    ];
    this.recover();
  }

  /** False once a commit failed; reads keep working, nothing new is admitted. */
  get admitting(): boolean {
    return (
      this.storageError === null && !this.terminationUnconfirmed && this.drainingRuns.size === 0
    );
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

    if (this.terminationUnconfirmed || this.drainingRuns.size > 0)
      return refuse({
        code: 'RESOURCE_CAPACITY',
        message:
          'a worker termination is unconfirmed; restart the backend before starting another run',
      });
    const resolved = this.resolveDefinition(request);
    if ('error' in resolved) return refuse(resolved.error);
    const seeded = request.startFrom
      ? this.startFromVersion(resolved.definition, request.startFrom)
      : resolved;
    if ('error' in seeded) return refuse(seeded.error);
    const referenced = request.references?.length
      ? this.withReferences(seeded.definition, request.references)
      : seeded;
    if ('error' in referenced) return refuse(referenced.error);
    const planned = planRun(referenced.definition);
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
      if (resolution.ok)
        models[profile] = JSON.parse(canonicalJson(resolution.snapshot)) as ModelProfileSnapshot;
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

    const harnesses: Record<string, EffectiveHarnessSnapshot> = {};
    for (const role of planned.definition.roles) {
      if (!role.harness) continue;
      try {
        const snapshot = EffectiveHarnessSnapshot.parse(
          this.harnesses?.resolve(role.harness, planned.definition, role.id),
        );
        if (
          snapshot.binding.profileId !== role.harness.profileId ||
          snapshot.binding.revision !== role.harness.revision ||
          (snapshot.policy === 'strict' && snapshot.resources.some((r) => r.kind === 'extension'))
        )
          throw new Error('invalid binding');
        harnesses[role.id] = snapshot;
      } catch {
        return refuse({
          code: 'CAPABILITY_DENIED',
          message: `harness for role ${role.id} is unavailable, untrusted or incompatible`,
        });
      }
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
      ...(Object.keys(harnesses).length ? { harnesses } : {}),
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
      closingExecutions: new Set(),
      approvals: new Map(),
      extensionUi: new Map(),
      uiRequestCount: 0,
      uiNoticeCount: 0,
      inputsByExecution: new Map(),
      startInputs: new Map(),
      capStop: null,
      limits: { ...definition.limits },
      criteriaVersionId: snapshot.criteriaVersionId,
      pendingCriteriaVersionId: null,
      cancelDeadline: () => {},
      requestDeadlines: new Map(),
      nodePatches: new Map(),
      assignments: new Map(),
      executionOutcomes: new Map(),
      boundaries: new Set(),
      boundaryWaiters: new Set(),
      cancelListeners: new Map(),
      toolOutcomes: new Map(),
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
          criteriaVersionId: snapshot.criteriaVersionId,
          ...(snapshot.harnesses ? { harnesses: snapshot.harnesses } : {}),
          ...(request.startFrom ? { startedFrom: request.startFrom } : {}),
          ...(this.judgments
            ? {
                decisions: resolveDecisionSettings(this.judgments, {
                  mode: request.mode,
                  maxModelCalls: definition.limits.maxModelCalls,
                }),
              }
            : {}),
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
        this.store.insertRun({
          runId,
          snapshot,
          projection: emptyProjection(runId),
          sessionId: request.sessionId ?? null,
        });
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
    run.cancelDeadline = this.timers.after(run.limits.runDeadlineMs, () => {
      if (TERMINAL_RUN_STATUSES.has(run.projection.status)) return;
      this.commit(run, [
        {
          type: 'limit.reached',
          payload: {
            limitKind: 'deadline',
            used: run.limits.runDeadlineMs,
            reserved: 0,
            max: run.limits.runDeadlineMs,
          },
        },
      ]);
      this.submit({
        schemaVersion: '0.1',
        runId,
        commandId: `deadline_${runId}`,
        type: 'cancel',
        payload: { scope: { kind: 'run' }, reason: 'run_deadline' },
      });
    });
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

  /**
   * CR-007: the brief of a run that starts from an earlier version, read from that run's own
   * record. The text is copied, so the new run never refers to the old run's versions.
   */
  private startFromVersion(
    definition: unknown,
    from: { runId: string; artifactVersionId: string },
  ): { definition: unknown } | { error: CommandError } {
    const source = this.findSnapshot(from.runId);
    const version = source?.projection.artifacts[from.artifactVersionId];
    const text = version ? this.store.getArtifactText(from.runId, from.artifactVersionId) : null;
    if (!version || text === null) {
      return {
        error: {
          code: 'TARGET_NOT_FOUND',
          message: `run ${from.runId} has no version ${from.artifactVersionId}`,
        },
      };
    }
    if (utf8ToBytes(text).length > this.policy.maxArtifactBytes) {
      return {
        error: {
          code: 'LIMIT_REACHED',
          message: `the version is larger than this installation's ${this.policy.maxArtifactBytes} byte artifact cap`,
        },
      };
    }
    const parsed = definition as CorralDefinition;
    if (!parsed?.input || typeof parsed.input.brief !== 'string') return { definition };
    const brief = [
      parsed.input.brief,
      '',
      'Start from this earlier version:',
      `(${version.name} v${version.version} from run ${from.runId})`,
      '',
      text,
    ].join('\n');
    return { definition: { ...parsed, input: { ...parsed.input, brief } } };
  }

  /**
   * CR-016: what the person pointed at with `@`, listed after the brief. Files, folders, runs
   * and roles are pointers; they grant nothing. Results are copied at the chosen version, within
   * one artifact cap for all of them together, like CR-007.
   */
  private withReferences(
    definition: unknown,
    references: readonly RunReference[],
  ): { definition: unknown } | { error: CommandError } {
    const parsed = definition as CorralDefinition;
    if (!parsed?.input || typeof parsed.input.brief !== 'string') return { definition };
    const missing = (message: string) => ({
      error: { code: 'TARGET_NOT_FOUND' as const, message },
    });
    const lines = [
      '',
      'References (pointers the person chose; they do not grant access to files or tools):',
    ];
    const copied: string[] = [];
    let bytes = 0;
    for (const reference of references) {
      if (reference.kind === 'file') {
        const range = reference.lines
          ? ` (lines ${reference.lines.start}-${reference.lines.end})`
          : '';
        lines.push(`- file ${reference.path}${range}`);
      } else if (reference.kind === 'folder') {
        lines.push(`- folder ${reference.path.replace(/\/+$/, '')}/`);
      } else if (reference.kind === 'run') {
        const source = this.findSnapshot(reference.runId);
        if (!source) return missing(`run ${reference.runId} does not exist`);
        lines.push(`- run ${reference.runId} (${source.projection.status})`);
      } else if (reference.kind === 'role') {
        const role = parsed.roles?.find((r) => r.id === reference.roleId);
        if (!role) return missing(`this team has no role ${reference.roleId}`);
        lines.push(`- role ${role.id} (${role.name})`);
      } else {
        const source = this.findSnapshot(reference.runId);
        const version = source?.projection.artifacts[reference.artifactVersionId];
        const text = version
          ? this.store.getArtifactText(reference.runId, reference.artifactVersionId)
          : null;
        if (!version || text === null)
          return missing(`run ${reference.runId} has no version ${reference.artifactVersionId}`);
        bytes += utf8ToBytes(text).length;
        if (bytes > this.policy.maxArtifactBytes)
          return {
            error: {
              code: 'LIMIT_REACHED',
              message: `the referenced results are larger than this installation's ${this.policy.maxArtifactBytes} byte artifact cap`,
            },
          };
        lines.push(
          `- result ${version.name} v${version.version} from run ${reference.runId} (below)`,
        );
        copied.push(
          `\n--- ${version.name} v${version.version} from run ${reference.runId} ---\n${text}`,
        );
      }
    }
    const brief = [parsed.input.brief, ...lines, ...copied].join('\n');
    return { definition: { ...parsed, input: { ...parsed.input, brief } } };
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
      if (command.type === 'resolve_approval') return this.resolveApproval(command, payloadHash);
      if (command.type === 'answer_extension_ui')
        return this.answerExtensionUi(command, payloadHash);
      return this.control(command, payloadHash);
    } catch {
      return unavailable(command.commandId, command.runId, this.storageError);
    }
  }

  /** Persist command identity together with its control facts. */
  private controlReceipt(
    run: LiveRun,
    command: RunCommand,
    payloadHash: string,
    drafts: EventDraft[],
    status: Receipt['status'],
    boundary: Receipt['requestedBoundary'],
    extra?: () => void,
  ): Receipt {
    let receipt!: Receipt;
    this.commit(
      run,
      drafts.map((d) => ({ ...d, commandId: command.commandId, actor: USER })),
      (events) => {
        receipt = {
          commandId: command.commandId,
          runId: run.runId,
          status,
          acceptedSeq: events[0]?.runSeq ?? run.projection.lastSeq,
          target:
            command.type === 'cancel' && command.payload.scope.kind !== 'run'
              ? command.payload.scope.kind === 'execution'
                ? `execution:${command.payload.scope.executionId}`
                : `task:${command.payload.scope.taskId}`
              : command.type === 'restart_task'
                ? `task:${command.payload.taskId}`
                : `run:${run.runId}`,
          requestedBoundary: boundary,
          relatedEventIds: events.map((e) => e.eventId),
        };
        this.store.putCommand({
          scope: run.runId,
          commandId: command.commandId,
          payloadHash,
          receipt,
          runId: run.runId,
          directiveId: null,
        });
        extra?.();
      },
    );
    return receipt;
  }

  private refuseControl(command: RunCommand, payloadHash: string, error: CommandError): Receipt {
    const receipt = rejected(command.commandId, command.runId, error);
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
  }

  private control(
    command: Exclude<RunCommand, SteerCommand | ResolveApprovalCommand | AnswerExtensionUiCommand>,
    payloadHash: string,
  ): Receipt {
    const run = this.live.get(command.runId);
    const refuse = (code: CommandError['code'], message: string) =>
      this.refuseControl(command, payloadHash, { code, message });
    if (!run || TERMINAL_RUN_STATUSES.has(run.projection.status))
      return refuse('TARGET_TERMINAL', 'the run has ended');
    if (
      command.expectedControlRevision !== undefined &&
      command.expectedControlRevision !== run.projection.controlRevision
    )
      return refuse(
        'STALE_CONTROL_REVISION',
        `control revision is ${run.projection.controlRevision}`,
      );
    if (run.projection.status === 'cancelling' && command.type !== 'cancel')
      return refuse('TARGET_TERMINAL', 'the run is cancelling');
    if (command.type === 'patch') return this.patch(run, command, payloadHash);
    if (command.type === 'restart_task') return this.restart(run, command, payloadHash);
    if (command.type === 'pause') {
      const current = run.projection.status;
      if (current === 'cancelling') return refuse('TARGET_TERMINAL', 'the run is cancelling');
      const receipt = this.controlReceipt(
        run,
        command,
        payloadHash,
        current === 'paused' || current === 'pausing'
          ? []
          : [runState(current, 'pausing', 'pause_requested')],
        current === 'paused' ? 'applied' : 'accepted',
        'safe_boundary',
      );
      for (const q of run.questions.values()) q.deadline.pause();
      this.maybePaused(run);
      return receipt;
    }
    if (command.type === 'resume') {
      if (run.projection.status === 'cancelling')
        return refuse('TARGET_TERMINAL', 'the run is cancelling');
      const drafts: EventDraft[] = [];
      if (run.projection.status === 'paused' || run.projection.status === 'pausing') {
        const waiting =
          run.approvals.size > 0 ||
          Object.values(run.projection.tasks).some((t) => t.status === 'blocked');
        drafts.push(
          runState(run.projection.status, waiting ? 'awaiting_user' : 'running', 'resumed'),
        );
        for (const e of Object.values(run.projection.executions))
          if (e.status === 'paused')
            drafts.push({
              type: 'execution.state_changed',
              executionId: e.executionId,
              payload: {
                executionId: e.executionId,
                from: e.status,
                to: 'active',
                activity: 'model',
                waitingOn: null,
              },
            });
      }
      const receipt = this.controlReceipt(
        run,
        command,
        payloadHash,
        drafts,
        'applied',
        'immediate',
      );
      for (const q of run.questions.values()) q.deadline.resume();
      this.wake(run);
      return receipt;
    }
    const scope = command.payload.scope;
    const target =
      scope.kind === 'run'
        ? null
        : scope.kind === 'execution'
          ? run.projection.executions[scope.executionId]
          : Object.values(run.projection.executions)
              .filter((e) => e.taskId === scope.taskId)
              .at(-1);
    if (scope.kind !== 'run' && !target)
      return refuse('TARGET_NOT_FOUND', 'the cancellation target does not exist');
    if (target && TERMINAL_EXECUTION_STATUSES.has(target.status))
      return refuse('TARGET_TERMINAL', 'the cancellation target has ended');
    const affected = new Set<string>(
      scope.kind === 'run'
        ? Object.values(run.projection.executions)
            .filter((e) => !TERMINAL_EXECUTION_STATUSES.has(e.status))
            .map((e) => e.executionId)
        : target
          ? [target.executionId]
          : [],
    );
    for (const id of affected)
      for (const e of Object.values(run.projection.executions))
        if (e.parentExecutionId === id && !TERMINAL_EXECUTION_STATUSES.has(e.status))
          affected.add(e.executionId);
    const drafts: EventDraft[] = [
      {
        type: 'cancel.requested',
        payload: { scope, fenceSeq: run.projection.lastSeq + 1, reason: command.payload.reason },
      },
    ];
    if (scope.kind === 'run')
      drafts.push(runState(run.projection.status, 'cancelling', 'cancel_requested'));
    else if (
      target &&
      run.projection.tasks[target.taskId]?.status !== 'completed' &&
      run.assignments.get(target.executionId)?.assignment.kind !== 'question' &&
      !['pausing', 'paused'].includes(run.projection.status)
    )
      drafts.push(runState(run.projection.status, 'awaiting_user', 'required_task_cancelling'));
    for (const id of affected) {
      const e = run.projection.executions[id];
      if (!e) continue;
      drafts.push({
        type: 'execution.state_changed',
        executionId: id,
        payload: {
          executionId: id,
          from: e.status,
          to: 'cancelling',
          activity: null,
          waitingOn: null,
        },
      });
      for (const d of Object.values(run.projection.directives))
        if (d.targetExecutionId === id && d.status === 'queued')
          drafts.push({
            type: 'directive.undelivered',
            executionId: id,
            payload: {
              directiveId: d.directiveId,
              status: 'not_delivered',
              reason: 'the scope was cancelled before dispatch',
            },
          });
    }
    const receipt = this.controlReceipt(
      run,
      command,
      payloadHash,
      drafts,
      'accepted',
      'safe_boundary',
    );
    if (scope.kind === 'run') run.stop.aborted = true;
    for (const id of affected) this.requestCancel(run, id, command.payload.reason);
    for (const [questionId, q] of run.questions)
      if (affected.has(q.askerExecutionId) || affected.has(q.responderExecutionId)) {
        run.questions.delete(questionId);
        q.cancelTimer();
        this.commit(run, this.askerResumes(run, q.askerExecutionId, questionId, 'cancelled'));
        q.wake({ questionId, outcome: 'cancelled' });
      }
    if (scope.kind === 'run') {
      for (const resolve of run.approvals.values()) resolve('reject');
      run.approvals.clear();
    }
    this.wake(run);
    const ids = [...affected];
    // The adapter forces shutdown after 10s, then has 10s to confirm process exit.
    const cancelTimeout = this.timers.after(10_000, () => {
      const unsettled = ids.filter((id) => {
        const execution = run.projection.executions[id];
        return execution && !TERMINAL_EXECUTION_STATUSES.has(execution.status);
      });
      if (!unsettled.length || TERMINAL_RUN_STATUSES.has(run.projection.status)) return;
      const timedOut: EventDraft[] = unsettled.map((executionId) => ({
        type: 'execution.settled',
        executionId,
        payload: {
          executionId,
          outcome: 'failed',
          terminationMode: 'unconfirmed',
          error: 'termination_unconfirmed',
        },
      }));
      for (const executionId of unsettled) {
        this.releaseSlots(run, executionId);
        for (const call of Object.values(run.projection.modelCalls))
          if (call.executionId === executionId) {
            run.requestDeadlines.get(call.modelCallId)?.();
            run.requestDeadlines.delete(call.modelCallId);
            const settled = settlementFor(run.projection.budget, call.modelCallId, null);
            if (settled) timedOut.push({ type: 'budget.settled', payload: settled });
          }
        for (const effect of Object.values(run.projection.effects))
          if (effect.scope === executionId && effect.status === 'admitted')
            timedOut.push({
              type: 'effect.settled',
              payload: { effectId: effect.effectId, outcome: 'unknown' },
            });
      }
      this.commit(run, timedOut);
      this.terminationUnconfirmed = true;
      this.failRun(run, 'termination_unconfirmed');
      this.wake(run);
    });
    void Promise.all(ids.map((id) => run.executionOutcomes.get(id)))
      .then(() => {
        cancelTimeout();
        if (TERMINAL_RUN_STATUSES.has(run.projection.status) || this.storageError) return;
        const settlements = this.store
          .readEvents(run.runId, 0)
          .filter((e) => e.type === 'execution.settled' && ids.includes(e.payload.executionId));
        if (
          settlements.some(
            (e) => e.type === 'execution.settled' && e.payload.terminationMode === 'unconfirmed',
          )
        )
          return;
        const confirmed: EventDraft[] = [
          {
            type: 'cancel.confirmed',
            commandId: command.commandId,
            payload: {
              scope,
              settlementRefs: settlements.map((e) => e.eventId),
              forced: settlements.some(
                (e) => e.type === 'execution.settled' && e.payload.terminationMode === 'forced',
              ),
            },
          },
        ];
        if (scope.kind === 'run')
          confirmed.push(
            ...this.closeRounds(run),
            runState(run.projection.status, 'cancelled', 'cancel_confirmed'),
          );
        else if (
          target &&
          run.projection.tasks[target.taskId]?.status !== 'completed' &&
          run.assignments.get(target.executionId)?.assignment.kind !== 'question'
        ) {
          confirmed.push({
            type: 'task.blocked',
            taskId: target.taskId,
            payload: {
              taskId: target.taskId,
              cause: 'required_task_cancelled',
              requiredUserAction: 'restart_or_cancel',
            },
          });
          if (!['pausing', 'paused'].includes(run.projection.status))
            confirmed.push(
              runState(run.projection.status, 'awaiting_user', 'required_task_cancelled'),
            );
        }
        this.commit(run, confirmed);
      })
      .catch(() => this.failRun(run, 'cancellation_cleanup_failed'));
    return receipt;
  }

  private patch(
    run: LiveRun,
    command: Extract<RunCommand, { type: 'patch' }>,
    payloadHash: string,
  ): Receipt {
    const change = command.payload;
    const refuse = (code: CommandError['code'], message: string) =>
      this.refuseControl(command, payloadHash, { code, message });
    let before: Record<string, unknown> = {},
      after: Record<string, unknown> = {};
    let patchedModel: ModelProfileSnapshot | undefined;
    const node =
      'nodeId' in change ? run.snapshot.definition.nodes.find((n) => n.id === change.nodeId) : null;
    if ('nodeId' in change && !node)
      return refuse('TARGET_NOT_FOUND', 'the patch node does not exist');
    if (change.kind === 'node_future') {
      if (node?.type !== 'agent')
        return refuse('SCHEMA_INVALID', 'node_future requires an agent node');
      const role = run.snapshot.definition.roles.find((r) => r.id === node.roleId);
      if (!role) return refuse('TARGET_NOT_FOUND', 'the node role does not exist');
      const current = run.nodePatches.get(node.id);
      before = {
        modelProfile: current?.modelProfile ?? role.modelProfile,
        prompt: current?.prompt ?? role.prompt,
      };
      after = {
        ...before,
        ...(change.modelProfile ? { modelProfile: change.modelProfile } : {}),
        ...(change.prompt ? { prompt: change.prompt } : {}),
      };
      if (change.modelProfile) {
        const resolved = this.models.resolve(change.modelProfile, run.snapshot.mode);
        if (!resolved.ok) return refuse(resolved.code, resolved.reason);
        patchedModel = JSON.parse(canonicalJson(resolved.snapshot)) as ModelProfileSnapshot;
        after.modelSnapshot = patchedModel;
      } else patchedModel = current?.model ?? run.snapshot.models[role.modelProfile];
      if (!patchedModel) return refuse('CAPABILITY_DENIED', 'the pinned model is unavailable');
    } else if (change.kind === 'loop_limit') {
      if (node?.type !== 'loop') return refuse('SCHEMA_INVALID', 'loop_limit requires a Loop node');
      if (change.maxIterations > this.policy.maxLoopIterations)
        return refuse('LIMIT_REACHED', 'loop cap exceeds installation policy');
      before = { maxIterations: run.plan.loops[node.id]?.maxIterations ?? node.maxIterations };
      after = { maxIterations: change.maxIterations };
    } else if (change.kind === 'run_limits') {
      for (const [key, value] of Object.entries(change.changes))
        if (value > this.policy[key as keyof InstallationPolicy])
          return refuse('LIMIT_REACHED', `${key} exceeds installation policy`);
      before = Object.fromEntries(
        Object.keys(change.changes).map((k) => [k, run.limits[k as keyof typeof run.limits]]),
      );
      after = { ...change.changes };
    } else {
      const current = run.pendingCriteriaVersionId ?? run.criteriaVersionId;
      if (change.baseCriteriaVersionId !== current)
        return refuse('STALE_CONTROL_REVISION', 'the criteria version changed');
      if (!run.rounds.size)
        return refuse(
          'CRITERIA_CHANGE_REQUIRES_NEW_RUN',
          'criteria can change only inside an unfinished Loop',
        );
      before = { criteriaVersionId: current };
      after = { criteriaVersionId: this.ids.next('criteria_version'), criteria: change.criteria };
    }
    const patchId = command.commandId;
    const drafts: EventDraft[] = [
      {
        type: 'patch.committed',
        payload: {
          patchId,
          kind: change.kind,
          scope: { nodeId: 'nodeId' in change ? change.nodeId : null },
          before,
          after,
          controlRevision: run.projection.controlRevision + 1,
        },
      },
    ];
    if (change.kind === 'criteria')
      for (const r of Object.values(run.projection.reviews))
        if (!r.stale)
          drafts.push({
            type: 'review.stale',
            payload: {
              reviewVersionId: r.reviewVersionId,
              newCriteriaVersionId: String(after.criteriaVersionId),
              cause: 'criteria_changed',
            },
          });
    const receipt = this.controlReceipt(
      run,
      command,
      payloadHash,
      drafts,
      'applied',
      change.kind === 'run_limits' ? 'immediate' : 'next_activation',
      () => {
        if (change.kind === 'criteria')
          this.store.putArtifactText(
            run.runId,
            String(after.criteriaVersionId),
            change.criteria.join('\n'),
          );
      },
    );
    if (change.kind === 'node_future')
      run.nodePatches.set(change.nodeId, {
        patchId,
        modelProfile: String(after.modelProfile),
        model: patchedModel as ModelProfileSnapshot,
        prompt: String(after.prompt),
        revision: run.projection.controlRevision,
      });
    else if (change.kind === 'loop_limit') {
      const step = run.plan.steps[change.nodeId];
      if (step?.kind === 'loop') step.maxIterations = change.maxIterations;
      const loop = run.plan.loops[change.nodeId];
      if (loop) loop.maxIterations = change.maxIterations;
    } else if (change.kind === 'run_limits') run.limits = { ...run.limits, ...change.changes };
    else {
      run.pendingCriteriaVersionId = String(after.criteriaVersionId);
      for (const [oldId, resolve] of [...run.approvals]) {
        const old = run.projection.approvals[oldId];
        if (old?.status !== 'stale') continue;
        run.approvals.delete(oldId);
        const nextId = this.ids.next('approval');
        run.approvals.set(nextId, resolve);
        this.commit(run, [
          {
            type: 'approval.requested',
            payload: {
              approvalId: nextId,
              kind: old.kind,
              subjectVersionIds: old.subjectVersionIds,
              criteriaVersionId: run.pendingCriteriaVersionId,
            },
          },
        ]);
      }
    }
    return receipt;
  }

  private restart(
    run: LiveRun,
    command: Extract<RunCommand, { type: 'restart_task' }>,
    payloadHash: string,
  ): Receipt {
    const { taskId, previousExecutionId, instruction } = command.payload;
    if (['pausing', 'paused'].includes(run.projection.status))
      return this.refuseControl(command, payloadHash, {
        code: 'RESTART_NOT_ALLOWED',
        message: 'Resume the run before restarting this task',
      });
    const task = run.projection.tasks[taskId],
      previous = run.projection.executions[previousExecutionId],
      spec = run.assignments.get(previousExecutionId);
    const parent = previous?.parentExecutionId
      ? run.projection.executions[previous.parentExecutionId]
      : null;
    if (!task || !previous)
      return this.refuseControl(command, payloadHash, {
        code: 'TARGET_NOT_FOUND',
        message: 'the task or execution does not exist',
      });
    if (
      previous.taskId !== taskId ||
      previous.status !== 'cancelled' ||
      task.status !== 'blocked' ||
      task.attemptCount !== previous.attemptNo ||
      !spec ||
      parent?.status !== 'waiting_children' ||
      !parent.waitingOn?.targetIds.includes(previousExecutionId)
    )
      return this.refuseControl(command, payloadHash, {
        code: 'RESTART_NOT_ALLOWED',
        message: 'the parent must still be waiting for this cancelled current task',
      });
    const spawned = Object.values(run.projection.executions).filter(
      (e) => e.parentExecutionId !== null,
    ).length;
    if (spawned >= run.limits.maxSpawns)
      return this.refuseControl(command, payloadHash, {
        code: 'LIMIT_REACHED',
        message: 'the spawn attempt limit was reached',
      });
    const prepared = this.prepareExecution(run, {
      ...spec,
      taskId,
      previousExecutionId,
      attemptNo: previous.attemptNo + 1,
      given: [
        ...spec.given.filter(
          (i) => i.name !== 'restart_instruction' && i.name !== 'previous_attempt_result',
        ),
        ...Object.values(run.projection.artifacts)
          .filter((a) => a.authorExecutionId === previousExecutionId)
          .map((a) => ({
            name: 'previous_attempt_result',
            kind: 'explicit_version' as const,
            artifactVersionId: a.artifactVersionId,
            text: this.store.getArtifactText(run.runId, a.artifactVersionId) ?? '',
          })),
        {
          name: 'restart_instruction',
          kind: 'run_input',
          artifactVersionId: null,
          text: instruction,
        },
      ],
    });
    const waiting =
      run.approvals.size > 0 ||
      Object.values(run.projection.tasks).some(
        (t) => t.taskId !== taskId && t.status === 'blocked',
      );
    const receipt = this.controlReceipt(
      run,
      command,
      payloadHash,
      [
        ...prepared.drafts,
        {
          type: 'execution.state_changed',
          executionId: parent.executionId,
          payload: {
            executionId: parent.executionId,
            from: parent.status,
            to: parent.status,
            activity: parent.activity,
            waitingOn: {
              ...parent.waitingOn,
              targetIds: parent.waitingOn.targetIds.map((id) =>
                id === previousExecutionId ? prepared.input.executionId : id,
              ),
            },
          },
        },
        runState(run.projection.status, waiting ? 'awaiting_user' : 'running', 'task_restarted'),
      ],
      'applied',
      'immediate',
    );
    const outcome = this.launch(run, prepared);
    void outcome.then(() => this.wake(run));
    this.wake(run);
    return receipt;
  }

  private wake(run: LiveRun) {
    for (const wake of run.boundaryWaiters) wake();
    run.boundaryWaiters.clear();
  }

  private async boundary(run: LiveRun, executionId?: string): Promise<void> {
    if (executionId) run.boundaries.add(executionId);
    try {
      while (
        run.projection.status === 'pausing' ||
        run.projection.status === 'paused' ||
        run.projection.status === 'awaiting_user'
      ) {
        this.maybePaused(run);
        if (run.stop.aborted || (executionId && run.cancelRequested.has(executionId)))
          throw new Error('scope cancelled');
        await new Promise<void>((resolve) => run.boundaryWaiters.add(resolve));
      }
      if (
        run.stop.aborted ||
        TERMINAL_RUN_STATUSES.has(run.projection.status) ||
        (executionId && run.cancelRequested.has(executionId))
      )
        throw new Error('scope cancelled');
    } finally {
      if (executionId) run.boundaries.delete(executionId);
    }
  }

  private maybePaused(run: LiveRun) {
    if (run.projection.status !== 'pausing') return;
    const activeEffects = Object.values(run.projection.effects).some(
      (e) =>
        e.status === 'admitted' &&
        e.kind !== 'spawn' &&
        !(
          e.kind === 'tool' &&
          ['waiting_children', 'waiting_message', 'waiting_approval'].includes(
            run.projection.executions[e.scope]?.status ?? '',
          )
        ),
    );
    const workerAway = Object.values(run.projection.executions).some(
      (e) =>
        !TERMINAL_EXECUTION_STATUSES.has(e.status) &&
        !run.boundaries.has(e.executionId) &&
        !['waiting_children', 'waiting_message', 'waiting_approval', 'paused'].includes(e.status),
    );
    if (activeEffects || workerAway) return;
    const drafts: EventDraft[] = [];
    for (const id of run.boundaries) {
      const e = run.projection.executions[id];
      if (e?.status === 'active')
        drafts.push({
          type: 'execution.state_changed',
          executionId: id,
          payload: {
            executionId: id,
            from: e.status,
            to: 'paused',
            activity: null,
            waitingOn: null,
          },
        });
    }
    drafts.push(runState('pausing', 'paused', 'safe_boundary_reached'));
    this.commit(run, drafts);
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
    if (
      command.expectedControlRevision !== undefined &&
      command.expectedControlRevision !== run.projection.controlRevision
    )
      return refuse({
        code: 'STALE_CONTROL_REVISION',
        message: `control revision is ${run.projection.controlRevision}`,
      });
    if (run.cancelRequested.has(executionId) || run.projection.status === 'cancelling')
      return refuse({ code: 'TARGET_TERMINAL', message: 'the scope is cancelling' });
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
    run.handles.get(executionId)?.pushDirective?.({ directiveId, text: command.payload.text });
    const stored = this.store.getCommand(runId, command.commandId);
    if (!stored) throw new Error(`command ${command.commandId} was not recorded`);
    return this.currentReceipt(stored);
  }

  /** A steer receipt follows its directive: queued until a request carries it. */
  private currentReceipt(record: StoredCommand): Receipt {
    if (!record.directiveId || !record.runId) {
      if (!record.runId || record.receipt.status !== 'accepted') return record.receipt;
      const events = this.store.readEvents(record.runId, 0);
      const own = events.filter((e) => e.commandId === record.commandId);
      const cancel = own.find((e) => e.type === 'cancel.requested');
      const pause =
        record.receipt.requestedBoundary === 'safe_boundary' && !cancel
          ? events.findLast(
              (e) =>
                e.type === 'run.state_changed' &&
                e.payload.to === 'pausing' &&
                e.runSeq <= (record.receipt.acceptedSeq ?? 0),
            )
          : undefined;
      const pauseResolution = pause
        ? events.find(
            (e) =>
              e.runSeq > pause.runSeq &&
              e.type === 'run.state_changed' &&
              (e.payload.to === 'paused' ||
                e.payload.reasonCode === 'resumed' ||
                TERMINAL_RUN_STATUSES.has(e.payload.to)),
          )
        : undefined;
      let status: Receipt['status'] = record.receipt.status;
      if (cancel) {
        if (own.some((e) => e.type === 'cancel.confirmed')) status = 'applied';
      } else if (pauseResolution?.type === 'run.state_changed') {
        const { to, reasonCode } = pauseResolution.payload;
        status =
          to === 'paused'
            ? 'applied'
            : reasonCode === 'resumed'
              ? 'superseded'
              : to === 'cancelled'
                ? 'cancelled'
                : 'expired';
      }
      return {
        ...record.receipt,
        status,
        relatedEventIds: own.map((e) => e.eventId),
      };
    }
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
    const related = this.store
      // A directive cannot precede its acceptance, even when this run has a long history.
      .readEvents(record.runId, Math.max(0, (record.receipt.acceptedSeq ?? 1) - 1))
      .filter((e) => 'directiveId' in e.payload && e.payload.directiveId === record.directiveId)
      .map((e) => e.eventId);
    return { ...record.receipt, status, relatedEventIds: related };
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
      for (const execution of Object.values(run.projection.executions))
        if (!TERMINAL_EXECUTION_STATUSES.has(execution.status))
          this.requestCancel(run, execution.executionId, 'storage unavailable');
      for (const [questionId, q] of run.questions) {
        q.cancelTimer();
        q.wake({ questionId, outcome: 'cancelled' });
      }
      run.questions.clear();
      for (const resolve of run.approvals.values()) resolve('reject');
      run.approvals.clear();
      this.wake(run);
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
    notifyObservers(this.observers, projection, events, () => this.observerContext(run));
    return events;
  }

  /** What observers may do: record decision facts while the run is open (ADR-024). */
  private observerContext(run: LiveRun): ObserverContext {
    const open = () =>
      this.live.get(run.runId) === run && !TERMINAL_RUN_STATUSES.has(run.projection.status);
    return {
      runId: run.runId,
      isOpen: open,
      record: (drafts) => {
        if (!open() || this.storageError) return false;
        // An ended worker cannot collect a judgment. Its admitted provider effect still closes.
        drafts = drafts.filter(
          (draft) =>
            !draft.executionId ||
            !run.closingExecutions.has(draft.executionId) ||
            draft.type === 'effect.settled',
        );
        if (!drafts.length) return false;
        const allowed = new Set([
          'decision.requested',
          'decision.observed',
          'decision.failed',
          'limit.reached',
          'effect.admitted',
          'effect.settled',
        ]);
        // Only decision effects: an observer can never admit model or tool work.
        if (
          drafts.some(
            (d) =>
              d.type === 'effect.admitted' && (d.payload as { kind?: unknown }).kind !== 'decision',
          )
        )
          return false;
        if (drafts.some((d) => !allowed.has(d.type))) return false;
        const timed = drafts.map((d) =>
          d.type === 'decision.observed'
            ? {
                ...d,
                payload: {
                  ...d.payload,
                  ...requestTiming(
                    run.projection,
                    String((d.payload.subject as { modelCallId: string }).modelCallId),
                  ),
                },
              }
            : d,
        );
        try {
          this.commit(run, timed as unknown as EventDraft[]);
          return true;
        } catch {
          return false;
        }
      },
      onCancel: (executionId, fn) => {
        const listeners = run.cancelListeners.get(executionId) ?? new Set<() => void>();
        run.cancelListeners.set(executionId, listeners);
        listeners.add(fn);
        if (run.cancelRequested.has(executionId)) fn();
        return () => {
          listeners.delete(fn);
        };
      },
      after: (ms, fn) => this.timers.after(ms, fn),
      monotonicMs: () => this.clock.monotonicMs(),
      nextId: () => this.ids.next('decision'),
      nextEffectId: () => this.ids.next('effect'),
      status: () => run.projection.status,
    };
  }

  private publish(run: LiveRun, projection: RunProjection) {
    run.projection = projection;
    for (const subscriber of this.subscribers) {
      if (subscriber.runId === run.runId) {
        void Promise.resolve().then(() => this.pump(subscriber));
      }
    }
    if (TERMINAL_RUN_STATUSES.has(projection.status)) {
      this.live.delete(run.runId);
      run.cancelDeadline();
      this.wake(run);
    }
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
      .catch((error: unknown) => {
        if (!run.stop.aborted) this.failRun(run, `internal_error: ${String(error)}`);
      });
  }

  private failRun(run: LiveRun, reason: string) {
    const status = run.projection.status;
    if (TERMINAL_RUN_STATUSES.has(status) || this.storageError) return;
    run.stop.aborted = true;
    const active = Object.values(run.projection.executions).filter(
      (e) => !TERMINAL_EXECUTION_STATUSES.has(e.status),
    );
    if (active.length) this.drainingRuns.add(run);
    const drafts: EventDraft[] = active.map((e) => ({
      type: 'execution.state_changed',
      executionId: e.executionId,
      payload: {
        executionId: e.executionId,
        from: e.status,
        to: 'cancelling',
        activity: null,
        waitingOn: null,
      },
    }));
    for (const e of active) this.requestCancel(run, e.executionId, 'run failed');
    for (const [questionId, q] of run.questions) {
      q.cancelTimer();
      drafts.push({
        type: 'message.closed',
        payload: { questionId, outcome: 'cancelled', answerRef: null },
      });
      q.wake({ questionId, outcome: 'cancelled' });
    }
    run.questions.clear();
    for (const resolve of run.approvals.values()) resolve('reject');
    run.approvals.clear();
    this.wake(run);
    try {
      this.commit(run, [...drafts, ...this.closeRounds(run), runState(status, 'failed', reason)]);
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
    for (const reservationId of Object.keys(p.budget.reservations)) {
      const settled = settlementFor(p.budget, reservationId, null);
      if (settled) drafts.push({ type: 'budget.settled', payload: settled });
    }
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
    for (const question of Object.values(p.questions)) {
      if (question.status !== 'open') continue;
      drafts.push({
        type: 'message.closed',
        payload: { questionId: question.questionId, outcome: 'cancelled', answerRef: null },
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
    if (['pausing', 'paused'].includes(run.projection.status)) await this.boundary(run);
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
      // The person stopped it: at the Loop cap, at an approval, or after an inconclusive review.
      case 'cap_reached':
        if (run.capStop === 'hard_cap')
          this.failRun(run, `loop_hard_cap_reached: ${result.loopId}`);
        else this.endRun(run, 'cancelled', `loop_cap_declined: ${result.loopId}`);
        return;
      case 'rejected':
        this.endRun(run, 'cancelled', `rejected: ${result.nodeId}`);
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
        await this.boundary(run);
        const step = run.plan.steps[nodeId];
        if (step?.kind !== 'decision') throw new Error(`${nodeId} is not a decision`);
        if (this.decisions) {
          return this.decisions.decide({
            runId: run.runId,
            nodeId,
            mode: step.mode,
            iteration,
            projection: run.projection,
          });
        }
        return this.decide(run, nodeId, step.mode);
      },
      loopCapReached: async (loopId, rounds) => this.atLoopCap(run, loopId, rounds),
      finalize: async (outputNodeId) => this.finalizeOutput(run, outputNodeId),
      loopEntered: async (loopId, no) => {
        await this.boundary(run);
        const loop = run.plan.loops[loopId];
        if (!loop) throw new Error(`plan has no Loop ${loopId}`);
        if (run.pendingCriteriaVersionId) {
          run.criteriaVersionId = run.pendingCriteriaVersionId;
          run.pendingCriteriaVersionId = null;
        }
        const iterationId = this.ids.next('iteration');
        this.commit(run, [
          {
            type: 'loop.iteration_started',
            payload: {
              loopNodeId: loopId,
              iterationId,
              no,
              // What the previous round hands to this one, fixed now (C-026).
              pinnedCarryInputs: this.carriedInto(run, loop.members, loopId),
              criteriaVersionId: run.criteriaVersionId,
            },
          },
        ]);
        const policyPatches = Object.values(run.projection.patches);
        const patches = [
          policyPatches.findLast(
            (p) => p.kind === 'criteria' && p.after.criteriaVersionId === run.criteriaVersionId,
          ),
          policyPatches.findLast((p) => p.kind === 'loop_limit' && p.scope.nodeId === loopId),
        ].filter((p) => p !== undefined);
        if (patches.length)
          this.commit(
            run,
            patches.map((p) => ({
              type: 'patch.activated',
              payload: { patchId: p.patchId, iterationId },
            })),
          );
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
    await this.boundary(run);
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
    const baseRole = node?.type === 'agent' && definition.roles.find((r) => r.id === node.roleId);
    if (node?.type !== 'agent' || !baseRole) {
      throw new Error(`plan references missing agent ${spec.nodeId}`);
    }
    const patch = run.nodePatches.get(spec.nodeId);
    const role = patch
      ? { ...baseRole, modelProfile: patch.modelProfile, prompt: patch.prompt }
      : baseRole;
    const model = patch?.model ?? run.snapshot.models[role.modelProfile];
    if (!model) throw new Error('the pinned model is unavailable');
    const label = (id: string) => {
      const target = definition.nodes.find((n) => n.id === id);
      return { nodeId: id, label: target?.label ?? id };
    };
    const callables = run.plan.callables[spec.nodeId] ?? { delegate: [], question: [] };

    const taskId = spec.taskId ?? this.ids.next('task');
    const executionId = this.ids.next('execution');
    const effectId = this.ids.next('effect');
    const attemptNo = spec.attemptNo ?? 1;
    const input: AgentStartInput = {
      runId: run.runId,
      executionId,
      taskId,
      nodeId: spec.nodeId,
      attemptNo,
      role,
      ...(run.snapshot.harnesses?.[role.id] ? { harness: run.snapshot.harnesses[role.id] } : {}),
      modelProfile: role.modelProfile,
      mode: run.snapshot.mode,
      model: JSON.parse(canonicalJson(model)) as ModelProfileSnapshot,
      depth: spec.depth,
      round: spec.iterationId ? (run.projection.iterations[spec.iterationId]?.no ?? null) : null,
      criteriaVersionId: run.criteriaVersionId,
      assignment: spec.assignment,
      capabilities: {
        delegateTo: callables.delegate.map(label),
        askTo: callables.question.map(label),
      },
      inputs: [...spec.given, ...this.resolveInputs(run, node.inputBindings, spec.iterationId)],
    };
    run.inputsByExecution.set(executionId, input.inputs);
    run.startInputs.set(executionId, input);
    run.assignments.set(executionId, spec);
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
          ...(spec.previousExecutionId ? { previousExecutionId: spec.previousExecutionId } : {}),
          nodeId: spec.nodeId,
          taskId,
          attemptNo,
          depth: spec.depth,
          iterationId: spec.iterationId,
          modelProfile: role.modelProfile,
          configRevision: patch?.revision ?? run.projection.controlRevision,
          criteriaVersionId: run.criteriaVersionId,
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
    if (spec.taskId) drafts.splice(0, 1);
    if (patch)
      drafts.push({ type: 'patch.activated', payload: { patchId: patch.patchId, executionId } });
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
        run.closingExecutions.add(input.executionId);
        for (const pending of run.extensionUi.values())
          if (pending.input.executionId === input.executionId)
            this.closeExtensionUi(run, pending.requestId, 'execution_ended');
        for (const listener of run.cancelListeners.get(input.executionId) ?? []) listener();
        // A worker can end while awaiting a child; stop children before draining those tools.
        await this.cancelChildren(run, input.executionId, 'the parent execution ended');
        await Promise.allSettled(run.toolOutcomes.get(input.executionId) ?? []);
        run.handles.delete(input.executionId);
      }
      return this.settle(run, input, effectId, settlement);
    })();
    run.taskOutcomes.set(input.taskId, outcome);
    run.executionOutcomes.set(input.executionId, outcome);
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
    for (const pending of run.extensionUi.values())
      if (pending.input.executionId === executionId)
        this.closeExtensionUi(run, pending.requestId, 'cancelled');
    for (const listener of run.cancelListeners.get(executionId) ?? []) listener();
    for (const child of this.liveChildren(run, executionId))
      this.requestCancel(run, child.executionId, reason);
    this.wake(run);
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
        const text =
          binding.name === 'criteria'
            ? (this.store.getArtifactText(run.runId, run.criteriaVersionId) ?? criteria.join('\n'))
            : brief;
        return [{ name: binding.name, kind: 'run_input', artifactVersionId: null, text }];
      }
      const source = binding.sourceNodeId ?? '';
      let versionId: string | undefined;
      if (binding.kind === 'task_output') {
        // Inside a Loop, a producer in the same round is read from this round (C-026).
        const sameRound = iterationId !== null && this.loopOf(run, source) !== null;
        versionId = this.submittedOutputOf(run, source, sameRound ? iterationId : undefined)[0];
      }
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
    for (const pending of run.extensionUi.values())
      if (pending.input.executionId === input.executionId)
        this.closeExtensionUi(run, pending.requestId, 'execution_ended');
    const execution = run.projection.executions[input.executionId];
    if (!execution || TERMINAL_EXECUTION_STATUSES.has(execution.status) || this.storageError) {
      // Already ended elsewhere (run over, storage closed): a late report changes nothing.
      return { ok: false, reason: 'the execution had already ended' };
    }
    const task = run.projection.tasks[input.taskId];
    const submitted = task?.status === 'completed';
    // The Coordinator decides: an execution it cancelled ends cancelled unless it finished.
    const cancelled = run.cancelRequested.has(input.executionId) && !submitted;
    const outcome =
      settlement.terminationMode === 'unconfirmed'
        ? ('failed' as const)
        : cancelled
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
    for (const call of Object.values(run.projection.modelCalls))
      if (call.executionId === input.executionId) {
        run.requestDeadlines.get(call.modelCallId)?.();
        run.requestDeadlines.delete(call.modelCallId);
      }

    const drafts: EventDraft[] = [];
    for (const call of Object.values(run.projection.modelCalls))
      if (call.executionId === input.executionId) {
        const settled = settlementFor(run.projection.budget, call.modelCallId, null);
        if (settled) drafts.push({ type: 'budget.settled', payload: settled });
      }
    drafts.push(
      {
        type: 'execution.settled',
        executionId: input.executionId,
        payload: {
          executionId: input.executionId,
          outcome,
          terminationMode: settlement.terminationMode ?? 'normal',
          ...(error ? { error } : {}),
        },
      },
      { type: 'effect.settled', executionId: input.executionId, payload: { effectId, outcome } },
    );
    for (const effect of Object.values(run.projection.effects)) {
      // A model request still open when its agent stopped may or may not have been billed.
      if (
        (effect.kind !== 'model_request' && !(input.harness && effect.kind === 'tool')) ||
        effect.scope !== input.executionId
      )
        continue;
      if (effect.status !== 'admitted') continue;
      drafts.push({
        type: 'effect.settled',
        executionId: input.executionId,
        payload: { effectId: effect.effectId, outcome: 'unknown' },
      });
    }
    for (const directiveId of run.projection.directiveOrder) {
      const directive = run.projection.directives[directiveId];
      if (
        directive?.targetExecutionId !== input.executionId ||
        !['queued', 'attached_to_request'].includes(directive.status)
      ) {
        continue;
      }
      drafts.push({
        type: 'directive.undelivered',
        executionId: input.executionId,
        payload: {
          directiveId,
          status:
            directive.status === 'attached_to_request'
              ? 'delivery_unknown'
              : cancelled
                ? 'not_delivered'
                : 'expired',
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
    if (
      Object.values(run.projection.executions).every((e) =>
        TERMINAL_EXECUTION_STATUSES.has(e.status),
      )
    )
      this.drainingRuns.delete(run);
    this.maybePaused(run);
    if (settlement.terminationMode === 'unconfirmed') {
      this.terminationUnconfirmed = true;
      this.failRun(run, 'termination_unconfirmed');
    }
    return outcome === 'succeeded' || submitted
      ? { ok: true }
      : { ok: false, reason: error ?? `execution ${outcome}` };
  }

  // ── model slots ───────────────────────────────────────────────────────────

  private async acquireSlot(run: LiveRun, executionId: string): Promise<void> {
    if (run.slots.free > 0) {
      run.slots.free -= 1;
      return;
    }
    const listeners = run.cancelListeners.get(executionId) ?? new Set<() => void>();
    run.cancelListeners.set(executionId, listeners);
    run.boundaries.add(executionId);
    try {
      await new Promise<void>((resolve, reject) => {
        const granted = () => {
          listeners.delete(cancel);
          resolve();
        };
        const cancel = () => {
          const index = run.slots.waiters.indexOf(granted);
          if (index !== -1) run.slots.waiters.splice(index, 1);
          listeners.delete(cancel);
          reject(new Error('scope cancelled'));
        };
        listeners.add(cancel);
        run.slots.waiters.push(granted);
        this.maybePaused(run);
      });
    } finally {
      run.boundaries.delete(executionId);
    }
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

  private async finalizeOutput(run: LiveRun, outputNodeId: string) {
    await this.boundary(run);
    const output = run.snapshot.definition.nodes.find((n) => n.id === outputNodeId);
    if (output?.type !== 'output') throw new Error('plan references a missing output node');
    const versions = output.inputBindings.flatMap((b) =>
      b.kind === 'task_output' ? this.submittedOutputOf(run, b.sourceNodeId ?? '') : [],
    );
    if (versions.length === 0) throw new Error('output has no submitted version');
    let approvalId: string | null = null;
    if (output.requireApproval) {
      // Final approval binds the exact draft, its latest review and the criteria (Technical-Design §9.3).
      const review = this.latestReview(run);
      const requested = this.requestApproval(run, 'final_output', [
        ...versions,
        ...(review ? [review] : []),
      ]);
      approvalId = requested.approvalId;
      if ((await requested.decision) === 'reject') {
        this.endRun(run, 'cancelled', 'final_output_rejected');
        return;
      }
    }
    if (run.stop.aborted || TERMINAL_RUN_STATUSES.has(run.projection.status)) return;
    await this.boundary(run);
    // The output and the run's success are one fact: readers never see one without the other.
    this.commit(run, [
      {
        type: 'output.finalized',
        payload: { nodeId: output.id, artifactVersionIds: versions, approvalId },
      },
      runState('running', 'succeeded', 'output_finalized'),
    ]);
  }

  // ── reviews and approvals (C-027–C-029) ───────────────────────────────────

  /** The built-in decisions: review verdicts, the person's approvals, and simple rules. */
  private async decide(run: LiveRun, nodeId: string, mode: DecisionNode['mode']): Promise<string> {
    const node = run.snapshot.definition.nodes.find((n) => n.id === nodeId);
    const round = this.openRoundOf(run, nodeId);
    if (mode === 'rule') {
      const p = run.projection;
      const unfinished = Object.values(p.tasks).some(
        (t) => t.status !== 'completed' && !TERMINAL_TASK.has(t.status),
      );
      return unfinished ? 'no' : 'yes';
    }
    const bound = (node?.type === 'decision' ? node.inputBindings : []).flatMap((b) =>
      b.kind === 'task_output' && b.sourceNodeId
        ? this.submittedOutputOf(
            run,
            b.sourceNodeId,
            round && this.loopOf(run, b.sourceNodeId) ? round : undefined,
          )
        : [],
    );
    if (mode === 'approval') {
      const review = this.latestReview(run);
      const requested = this.requestApproval(run, 'user_action', [
        ...bound,
        ...(review ? [review] : []),
      ]);
      return requested.decision;
    }

    // Review: the verdict counts only for the draft and criteria actually reviewed.
    const reviewVersionId = bound[0];
    if (!reviewVersionId) throw new Error(`${nodeId} has no review to read`);
    const recorded = this.recordReview(run, reviewVersionId);
    if (run.pendingCriteriaVersionId) {
      const requested = this.requestApproval(run, 'user_action', [
        recorded.targetVersionId,
        reviewVersionId,
      ]);
      return (await requested.decision) === 'approve' ? 'revise' : 'reject';
    }
    if (recorded.verdict !== 'inconclusive') return recorded.verdict;
    // Not a usable verdict: the person decides whether the draft goes on.
    const requested = this.requestApproval(run, 'user_action', [
      recorded.targetVersionId,
      reviewVersionId,
    ]);
    return (await requested.decision) === 'approve'
      ? run.pendingCriteriaVersionId
        ? 'revise'
        : 'pass'
      : 'reject';
  }

  /** Validates a submitted review against what its reviewer was given (CRL-ART-003). */
  private recordReview(run: LiveRun, reviewVersionId: string) {
    const author = run.projection.artifacts[reviewVersionId]?.authorExecutionId ?? '';
    const reviewed = (run.inputsByExecution.get(author) ?? []).flatMap((i) =>
      i.artifactVersionId ? [i.artifactVersionId] : [],
    );
    const criteriaVersionId = run.criteriaVersionId;
    const text = this.store.getArtifactText(run.runId, reviewVersionId) ?? '';
    let parsed: ReturnType<typeof ReviewArtifact.safeParse> | null = null;
    try {
      parsed = ReviewArtifact.safeParse(JSON.parse(text));
    } catch {
      parsed = null;
    }
    const problem = !parsed?.success
      ? 'the review is not valid review JSON'
      : !reviewed.includes(parsed.data.targetArtifactVersionId)
        ? `the review names ${parsed.data.targetArtifactVersionId}, not the version it was given`
        : parsed.data.criteriaVersionId !== criteriaVersionId
          ? `the review uses criteria ${parsed.data.criteriaVersionId}, not ${criteriaVersionId}`
          : null;
    const review = problem || !parsed?.success ? null : parsed.data;
    const payload = {
      reviewVersionId,
      targetVersionId: review?.targetArtifactVersionId ?? reviewed[0] ?? reviewVersionId,
      criteriaVersionId,
      verdict: review?.verdict ?? ('inconclusive' as const),
      issues: review
        ? review.issues
        : [
            {
              criterionId: 'review_format',
              reason: problem ?? 'invalid review',
              severity: 'required' as const,
              evidenceRefs: [],
            },
          ],
    };
    this.commit(run, [
      { type: 'review.recorded', payload },
      ...(run.pendingCriteriaVersionId
        ? [
            {
              type: 'review.stale' as const,
              payload: {
                reviewVersionId,
                newCriteriaVersionId: run.pendingCriteriaVersionId,
                cause: 'criteria_changed',
              },
            },
          ]
        : []),
    ]);
    return payload;
  }

  private latestReview(run: LiveRun): string | null {
    return Object.keys(run.projection.reviews).at(-1) ?? null;
  }

  /** Asks the person; the run waits in `awaiting_user` until resolve_approval. */
  private requestApproval(
    run: LiveRun,
    kind: 'final_output' | 'loop_cap' | 'user_action',
    subjectVersionIds: string[],
  ): { approvalId: string; decision: Promise<'approve' | 'reject'> } {
    const approvalId = this.ids.next('approval');
    const decision = new Promise<'approve' | 'reject'>((resolve) => {
      run.approvals.set(approvalId, resolve);
    });
    this.commit(run, [
      {
        type: 'approval.requested',
        payload: {
          approvalId,
          kind,
          subjectVersionIds,
          criteriaVersionId: run.pendingCriteriaVersionId ?? run.criteriaVersionId,
        },
      },
      runState(run.projection.status, 'awaiting_user', `approval_requested: ${kind}`),
    ]);
    return { approvalId, decision };
  }

  /** At the Loop cap: ask for one more round, unless the installation's hard cap is reached. */
  private async atLoopCap(
    run: LiveRun,
    loopId: string,
    rounds: number,
  ): Promise<'continue' | 'stop'> {
    if (rounds >= this.policy.maxLoopIterations) {
      run.capStop = 'hard_cap';
      this.commit(run, [
        {
          type: 'limit.reached',
          payload: {
            limitKind: 'loop_iterations',
            used: rounds,
            reserved: 0,
            max: this.policy.maxLoopIterations,
          },
        },
      ]);
      return 'stop';
    }
    const members = run.plan.loops[loopId]?.members ?? [];
    const round = run.rounds.get(loopId)?.iterationId;
    const latest = members.flatMap((m) => this.submittedOutputOf(run, m, round));
    const requested = this.requestApproval(run, 'loop_cap', latest);
    if ((await requested.decision) === 'approve') {
      await this.boundary(run);
      return 'continue';
    }
    run.capStop = 'declined';
    return 'stop';
  }

  /** The person's answer to a pending approval: once, for the exact subject (CRL-RNS-008). */
  private resolveApproval(command: ResolveApprovalCommand, payloadHash: string): Receipt {
    const { runId } = command;
    const { approvalId, decision, subjectVersionId } = command.payload;
    const run = this.live.get(runId);
    const projection = this.projectionOf(runId);
    const approval = projection?.approvals[approvalId];
    const record = (receipt: Receipt): StoredCommand => ({
      scope: runId,
      commandId: command.commandId,
      payloadHash,
      receipt,
      runId,
      directiveId: null,
    });
    const refuse = (error: CommandError): Receipt => {
      const receipt = rejected(command.commandId, runId, error, `approval:${approvalId}`);
      this.persist(() => this.store.putCommand(record(receipt)));
      return receipt;
    };
    if (!approval)
      return refuse({ code: 'TARGET_NOT_FOUND', message: `no approval ${approvalId}` });
    const resume = run?.approvals.get(approvalId);
    if (approval.status !== 'pending' || !run || !resume) {
      return refuse({
        code: 'APPROVAL_STALE',
        message: `approval ${approvalId} is already ${approval.status}`,
      });
    }
    if (command.expectedControlRevision !== run.projection.controlRevision) {
      return refuse({
        code: 'STALE_CONTROL_REVISION',
        message: `control revision is ${run.projection.controlRevision}`,
      });
    }
    if (
      approval.criteriaVersionId &&
      approval.criteriaVersionId !== (run.pendingCriteriaVersionId ?? run.criteriaVersionId)
    )
      return refuse({ code: 'APPROVAL_STALE', message: 'the completion criteria changed' });
    if (subjectVersionId !== approval.subjectVersionIds[0]) {
      return refuse({
        code: 'APPROVAL_STALE',
        message: `approval ${approvalId} is for ${approval.subjectVersionIds[0]}, not ${subjectVersionId}`,
      });
    }
    this.commit(
      run,
      [
        {
          type: 'approval.resolved',
          actor: USER,
          commandId: command.commandId,
          payload: {
            approvalId,
            decision,
            actor: USER.id,
            subjectVersionIds: approval.subjectVersionIds,
          },
        },
        ...(['paused', 'pausing'].includes(run.projection.status)
          ? []
          : [
              runState(
                run.projection.status,
                run.extensionUi.size > 0 ||
                  Object.values(run.projection.tasks).some((t) => t.status === 'blocked')
                  ? 'awaiting_user'
                  : 'running',
                'approval_resolved',
              ),
            ]),
      ],
      (committed) => {
        const first = committed[0];
        this.store.putCommand(
          record({
            commandId: command.commandId,
            runId,
            status: 'applied',
            acceptedSeq: first?.runSeq ?? null,
            target: `approval:${approvalId}`,
            requestedBoundary: 'immediate',
            relatedEventIds: first ? [first.eventId] : [],
          }),
        );
      },
    );
    run.approvals.delete(approvalId);
    resume(decision);
    this.wake(run);
    const stored = this.store.getCommand(runId, command.commandId);
    if (!stored) throw new Error(`command ${command.commandId} was not recorded`);
    return stored.receipt;
  }

  /** Versions the previous round hands to the next through previous_iteration_output. */
  private carriedInto(run: LiveRun, members: string[], loopId: string): string[] {
    const previous =
      run.rounds.get(loopId)?.iterationId ?? run.projection.loopIterations[loopId]?.at(-1);
    if (!previous) return [];
    const definition = run.snapshot.definition;
    return members.flatMap((memberId) => {
      const node = definition.nodes.find((n) => n.id === memberId);
      const bindings = node && 'inputBindings' in node ? node.inputBindings : [];
      return bindings.flatMap((b) =>
        b.kind === 'previous_iteration_output' && b.sourceNodeId
          ? this.submittedOutputOf(run, b.sourceNodeId, previous)
          : [],
      );
    });
  }

  private loopOf(run: LiveRun, nodeId: string): string | null {
    const node = run.snapshot.definition.nodes.find((n) => n.id === nodeId);
    return node && 'loopId' in node && node.loopId ? node.loopId : null;
  }

  private openRoundOf(run: LiveRun, nodeId: string): string | null {
    const loopId = this.loopOf(run, nodeId);
    return loopId ? (run.rounds.get(loopId)?.iterationId ?? null) : null;
  }

  /** Ends a running (or waiting) run by the person's decision. */
  private endRun(run: LiveRun, to: 'cancelled', reason: string) {
    if (run.projection.status === 'cancelling' || TERMINAL_RUN_STATUSES.has(run.projection.status))
      return;
    const status = run.projection.status;
    if (TERMINAL_RUN_STATUSES.has(status)) return;
    this.commit(run, [...this.closeRounds(run), runState(status, to, reason)]);
  }

  // ── agent host: the only way an agent affects the run ─────────────────────

  private uiContinuation(run: LiveRun, pending: PendingExtensionUi): EventDraft[] {
    const { executionId } = pending.input;
    if (
      run.stop.aborted ||
      run.cancelRequested.has(executionId) ||
      TERMINAL_RUN_STATUSES.has(run.projection.status) ||
      run.projection.status === 'cancelling'
    )
      return [];
    const execution = run.projection.executions[executionId];
    const drafts: EventDraft[] =
      execution?.status === 'waiting_approval'
        ? [
            {
              type: 'execution.state_changed',
              executionId,
              payload: {
                executionId,
                from: execution.status,
                to: ['paused', 'pausing'].includes(run.projection.status) ? 'paused' : 'active',
                activity: null,
                waitingOn: null,
              },
            },
          ]
        : [];
    if (
      run.projection.status === 'awaiting_user' &&
      run.extensionUi.size === 1 &&
      !run.approvals.size &&
      !Object.values(run.projection.tasks).some((task) => task.status === 'blocked')
    )
      drafts.push(runState('awaiting_user', 'running', 'extension_ui_closed'));
    return drafts;
  }

  private closeExtensionUi(
    run: LiveRun,
    requestId: string,
    reason: 'timeout' | 'cancelled' | 'execution_ended',
  ) {
    const pending = run.extensionUi.get(requestId);
    if (!pending) return;
    try {
      if (!this.storageError && !TERMINAL_RUN_STATUSES.has(run.projection.status))
        this.commit(run, [
          {
            type: 'extension.ui_expired',
            executionId: pending.input.executionId,
            payload: {
              requestId,
              executionId: pending.input.executionId,
              attemptNo: pending.input.attemptNo,
              reason,
            },
          },
          ...this.uiContinuation(run, pending),
        ]);
    } finally {
      run.extensionUi.delete(requestId);
      pending.finish({ status: reason === 'timeout' ? 'expired' : 'cancelled' });
      this.wake(run);
    }
  }

  private requestExtensionUi(
    run: LiveRun,
    input: AgentStartInput,
    raw: ExtensionUiRequest,
    cancellation?: DecisionCancellation,
  ): Promise<ExtensionUiResult> {
    const request = ExtensionUiRequest.parse(raw);
    const { executionId, attemptNo } = input;
    const execution = run.projection.executions[executionId];
    if (
      !input.harness ||
      input.harness.policy !== 'trusted-native' ||
      !execution ||
      execution.status !== 'active' ||
      run.stop.aborted ||
      run.cancelRequested.has(executionId) ||
      !['running', 'awaiting_user'].includes(run.projection.status) ||
      run.projection.tasks[input.taskId]?.activeExecutionId !== executionId ||
      this.storageError
    )
      throw new Error('extension UI target is unavailable');
    if (cancellation?.aborted) return Promise.resolve({ status: 'cancelled' });
    if (
      run.uiRequestCount >= 100 ||
      [...run.extensionUi.values()].some((pending) => pending.input.executionId === executionId)
    )
      throw new Error('extension UI request limit reached');
    const requestId = this.ids.next('approval');
    const bodyRef = this.ids.next('artifact_version');
    const body = canonicalJson(request);
    const due = this.clock.monotonicMs() + request.timeoutMs;
    const deadline = new Date(Date.parse(this.clock.nowIso()) + request.timeoutMs).toISOString();
    let resolve!: (result: ExtensionUiResult) => void;
    let cancelTimer = () => {};
    let unsubscribe = () => {};
    const result = new Promise<ExtensionUiResult>((done) => {
      resolve = done;
    });
    const pending: PendingExtensionUi = {
      requestId,
      input,
      request,
      due,
      finish: (answer) => {
        cancelTimer();
        unsubscribe();
        resolve(answer);
      },
    };
    this.commit(
      run,
      [
        {
          type: 'extension.ui_requested',
          executionId,
          payload: {
            requestId,
            executionId,
            attemptNo,
            kind: request.kind,
            bodyRef,
            bodyHash: hashOf(request),
            deadline,
          },
        },
        {
          type: 'execution.state_changed',
          executionId,
          payload: {
            executionId,
            from: execution.status,
            to: 'waiting_approval',
            activity: null,
            waitingOn: {
              kind: 'approval',
              targetIds: [requestId],
              reasonCode: 'extension_ui',
              since: this.clock.nowIso(),
              deadline,
              required: true,
            },
          },
        },
        ...(run.projection.status === 'running'
          ? [runState('running', 'awaiting_user', 'extension_ui_requested')]
          : []),
      ],
      () => this.store.putArtifactText(run.runId, bodyRef, body),
    );
    run.extensionUi.set(requestId, pending);
    run.uiRequestCount += 1;
    cancelTimer = this.timers.after(request.timeoutMs, () =>
      this.closeExtensionUi(run, requestId, 'timeout'),
    );
    unsubscribe =
      cancellation?.onCancel(() => this.closeExtensionUi(run, requestId, 'cancelled')) ??
      (() => {});
    return result;
  }

  private answerExtensionUi(command: AnswerExtensionUiCommand, payloadHash: string): Receipt {
    const run = this.live.get(command.runId);
    const pending = run?.extensionUi.get(command.payload.requestId);
    const refuse = (code: CommandError['code'], message: string) =>
      this.refuseControl(command, payloadHash, { code, message });
    if (!run || !pending) return refuse('TARGET_TERMINAL', 'the extension UI request has closed');
    const { input, request } = pending;
    if (
      command.payload.executionId !== input.executionId ||
      command.payload.attemptNo !== input.attemptNo ||
      run.cancelRequested.has(input.executionId) ||
      run.projection.tasks[input.taskId]?.activeExecutionId !== input.executionId
    )
      return refuse('TARGET_TERMINAL', 'the extension UI target changed');
    if (pending.due <= this.clock.monotonicMs()) {
      this.closeExtensionUi(run, pending.requestId, 'timeout');
      return refuse('TARGET_TERMINAL', 'the extension UI request expired');
    }
    if (command.expectedControlRevision !== run.projection.controlRevision)
      return refuse('STALE_CONTROL_REVISION', 'the control revision changed');
    const value = command.payload.value;
    if (
      value !== null &&
      (request.kind === 'confirm'
        ? typeof value !== 'boolean'
        : typeof value !== 'string' ||
          (request.kind === 'select' && !request.options.includes(value)))
    )
      return refuse('SCHEMA_INVALID', 'the answer does not match the requested input');
    const answerRef = this.ids.next('artifact_version');
    const receipt = this.controlReceipt(
      run,
      command,
      payloadHash,
      [
        {
          type: 'extension.ui_answered',
          executionId: input.executionId,
          payload: {
            requestId: pending.requestId,
            executionId: input.executionId,
            attemptNo: input.attemptNo,
            answerRef,
            answerHash: hashOf(value),
          },
        },
        ...this.uiContinuation(run, pending),
      ],
      'applied',
      'immediate',
      () => this.store.putArtifactText(run.runId, answerRef, canonicalJson(value)),
    );
    run.extensionUi.delete(pending.requestId);
    pending.finish(value === null ? { status: 'cancelled' } : { status: 'answered', value });
    this.wake(run);
    return receipt;
  }

  private hostFor(run: LiveRun, input: AgentStartInput): AgentHost {
    const { executionId, harness } = input;
    const agent: Actor = { kind: 'agent', id: executionId };
    let lastCall: { modelCallId: string; contextSnapshotId: string; effectId: string } | null =
      null;
    let harnessState: 'unloaded' | 'loaded' | 'failed' = 'unloaded';
    const descriptors = new Map<string, ToolDescriptor>();
    const nativeEffects = new Map<string, string>();
    const recordedPayloads = new Set<string>();
    const toolView = (proposal: ToolProposal): ToolGateView => ({
      ...this.toolView(run, input, proposal),
      ...(descriptors.has(proposal.name) ? { descriptor: descriptors.get(proposal.name)! } : {}),
    });

    const requireActive = () => {
      const status = run.projection.executions[executionId]?.status;
      if (
        status !== 'active' ||
        run.projection.status !== 'running' ||
        run.cancelRequested.has(executionId) ||
        run.closingExecutions.has(executionId) ||
        run.projection.tasks[input.taskId]?.activeExecutionId !== executionId ||
        this.storageError
      ) {
        throw new Error(`execution ${executionId} is not active`);
      }
    };

    // Authorized calls of this execution; each may run once.
    const authorized = new Map<string, { proposal: ToolProposal; ran: boolean }>();

    const authorizeTool = async (proposal: ToolProposal): Promise<ToolAuthorization> => {
      if (harness && harnessState !== 'loaded') throw new Error('harness not loaded');
      // A caller cannot change the approved object while awaiting execution.
      if (harness) proposal = JSON.parse(canonicalJson(proposal)) as ToolProposal;
      const questionId = proposal.name === 'reply' ? proposal.args.questionId : null;
      // Checks a pause cannot change run before the safe boundary (Technical-Design §5.4).
      const early = toolRefusal(runGates(this.gates['tool.pre_boundary'], toolView(proposal)));
      if (early) {
        const error: CommandError = { code: early.code, message: early.message };
        if (proposal.name === 'reply') {
          // A reply after the question closed is kept as an audit fact only.
          this.commit(run, [
            {
              type: 'observation.late',
              executionId,
              payload: {
                originalEventType: 'reply',
                originalRef: typeof questionId === 'string' ? questionId : null,
                whyIgnored: early.message,
              },
            },
          ]);
          return { ok: false, toolCallId: this.ids.next('tool_call'), error };
        }
        const toolCallId = this.ids.next('tool_call');
        this.commit(run, [
          {
            type: 'tool.requested',
            actor: agent,
            executionId,
            payload: { executionId, toolCallId, name: proposal.name, validatedArgs: {} },
          },
          {
            type: 'tool.blocked',
            executionId,
            payload: { executionId, toolCallId, reason: `${error.code}: ${error.message}` },
          },
        ]);
        return { ok: false, toolCallId, error };
      }
      do {
        await this.boundary(run, executionId);
      } while (run.projection.status !== 'running');
      requireActive();
      const toolCallId = this.ids.next('tool_call');
      const refusal = toolRefusal(runGates(this.gates['tool.authorize'], toolView(proposal)));
      const error: CommandError | null = refusal
        ? { code: refusal.code, message: refusal.message }
        : null;

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
            validatedArgs: error
              ? {}
              : harness
                ? {
                    hash: hashOf(proposal.args),
                    bytes: utf8ToBytes(canonicalJson(proposal.args)).length,
                  }
                : summarizeArgs(proposal.args),
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
              payload: {
                executionId,
                toolCallId,
                policyVersion: harness ? 'role-allowlist@2' : TOOL_POLICY_VERSION,
              },
            },
        ...(refusal?.limit
          ? [
              {
                type: 'limit.reached',
                executionId,
                payload: {
                  limitKind: refusal.limit.kind,
                  used: refusal.limit.used,
                  reserved: refusal.limit.reserved ?? 0,
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
      do {
        await this.boundary(run, executionId);
      } while (run.projection.status !== 'running');
      requireActive();
      const call = authorized.get(toolCallId);
      if (call && descriptors.get(call.proposal.name)?.source.startsWith('extension:'))
        return {
          ok: false,
          toolCallId,
          error: { code: 'CAPABILITY_DENIED', message: 'native calls execute in their worker' },
        };
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
      const refusal = toolRefusal(runGates(this.gates['tool.execute'], toolView(call.proposal)));
      if (refusal)
        return { ok: false, toolCallId, error: { code: refusal.code, message: refusal.message } };
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
      const closing = (resultRef: string | null, error: string | null = null): EventDraft[] =>
        run.projection.effects[effectId] && run.projection.effects[effectId]?.status !== 'admitted'
          ? []
          : [
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
      const tool = { opening, closing, toolCallId, effectId };
      switch (call.proposal.name) {
        case 'read':
        case 'edit':
        case 'write':
        case 'search':
        case 'read_document':
        case 'list_files':
        case 'read_file':
        case 'write_file':
        case 'delete_file':
        case 'move_file':
          return this.externalTool(run, input, call.proposal, tool);
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

    const trackedExecute = (toolCallId: string) => {
      const pending = run.toolOutcomes.get(executionId) ?? new Set<Promise<ToolOutcome>>();
      run.toolOutcomes.set(executionId, pending);
      const outcome = executeTool(toolCallId);
      pending.add(outcome);
      void outcome.then(
        () => pending.delete(outcome),
        () => pending.delete(outcome),
      );
      return outcome;
    };
    return {
      ...(harness
        ? {
            requestExtensionUi: (
              request: ExtensionUiRequest,
              cancellation?: DecisionCancellation,
            ) => this.requestExtensionUi(run, input, request, cancellation),
            notifyExtensionUi: async (raw: ExtensionUiNotice) => {
              const notice = ExtensionUiNotice.parse(raw);
              if (
                run.stop.aborted ||
                run.cancelRequested.has(executionId) ||
                TERMINAL_RUN_STATUSES.has(run.projection.status) ||
                TERMINAL_EXECUTION_STATUSES.has(
                  run.projection.executions[executionId]?.status ?? 'failed',
                ) ||
                this.storageError
              )
                throw new Error('extension UI target has ended');
              if (++run.uiNoticeCount > 1000)
                throw new Error('extension notification limit reached');
              const bodyRef = this.ids.next('artifact_version');
              this.commit(
                run,
                [
                  {
                    type: 'extension.ui_notified',
                    executionId,
                    payload: {
                      executionId,
                      kind: notice.kind,
                      key: hashOf(notice.key),
                      level: notice.level,
                      bodyRef,
                      bodyHash: hashOf(notice),
                    },
                  },
                ],
                () => this.store.putArtifactText(run.runId, bodyRef, canonicalJson(notice)),
              );
            },
            recordProviderPayload: async (raw: ProviderPayloadRecord) => {
              requireActive();
              const record = ProviderPayloadRecord.parse(raw);
              const call = run.projection.modelCalls[record.modelCallId];
              if (
                !call ||
                call.executionId !== executionId ||
                call.finished ||
                lastCall?.modelCallId !== record.modelCallId ||
                recordedPayloads.has(record.modelCallId)
              )
                throw new Error('unknown or already recorded request');
              this.commit(run, [{ type: 'model.payload_recorded', executionId, payload: record }]);
              recordedPayloads.add(record.modelCallId);
            },
            pendingDirectives: () =>
              run.projection.directiveOrder.flatMap((id) => {
                const d = run.projection.directives[id];
                return d?.targetExecutionId === executionId && d.status === 'queued'
                  ? [{ directiveId: id, text: d.text }]
                  : [];
              }),
            reportHarness: async (raw: HarnessReport) => {
              requireActive();
              const report = HarnessReport.parse(raw);
              if (harnessState !== 'unloaded' || report.snapshotHash !== harness.snapshotHash)
                throw new Error('unexpected harness report');
              if (!report.ok) {
                this.commit(run, [
                  {
                    type: 'harness.load_failed',
                    executionId,
                    payload: { snapshotHash: report.snapshotHash, code: report.code },
                  },
                ]);
                harnessState = 'failed';
                return;
              }
              const names = new Set<string>();
              for (const descriptor of report.tools) {
                if (names.has(descriptor.name)) throw new Error('duplicate descriptor');
                names.add(descriptor.name);
                if (
                  descriptor.source !== 'corral' &&
                  (!harness.resources.some(
                    (r) =>
                      r.kind === 'extension' &&
                      descriptor.source === `extension:${r.name}@${r.version}`,
                  ) ||
                    harness.policy === 'strict')
                )
                  throw new Error('unbound native tool');
              }
              for (const command of report.commands ?? []) {
                if (
                  harness.policy === 'strict' ||
                  !harness.resources.some(
                    (resource) =>
                      resource.kind === 'extension' &&
                      command.source === `extension:${resource.name}@${resource.version}`,
                  )
                )
                  throw new Error('unbound extension command');
              }
              this.commit(run, [
                {
                  type: 'harness.loaded',
                  executionId,
                  payload: {
                    snapshotHash: report.snapshotHash,
                    tools: report.tools,
                    diagnostics: report.diagnostics,
                    ...(report.commands ? { commands: report.commands } : {}),
                  },
                },
              ]);
              for (const descriptor of report.tools) descriptors.set(descriptor.name, descriptor);
              harnessState = 'loaded';
            },
            beginNativeTool: async (toolCallId: string, argsHash: string) => {
              await this.boundary(run, executionId);
              requireActive();
              const call = authorized.get(toolCallId);
              if (
                !call ||
                call.ran ||
                !descriptors.get(call.proposal.name)?.source.startsWith('extension:') ||
                hashOf(call.proposal.args) !== argsHash
              )
                throw new Error('native call is not authorized');
              const refusal = toolRefusal(
                runGates(this.gates['tool.execute'], toolView(call.proposal)),
              );
              if (refusal) throw new Error('native call refused');
              const effectId = this.ids.next('effect');
              this.commit(run, [
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
                {
                  type: 'tool.started',
                  executionId,
                  payload: { executionId, toolCallId, effectId, management: 'unmanaged_native' },
                },
              ]);
              call.ran = true;
              nativeEffects.set(toolCallId, effectId);
            },
            finishNativeTool: async (toolCallId: string, outcome: 'succeeded' | 'failed') => {
              const execution = run.projection.executions[executionId];
              if (
                !execution ||
                TERMINAL_EXECUTION_STATUSES.has(execution.status) ||
                TERMINAL_RUN_STATUSES.has(run.projection.status) ||
                run.cancelRequested.has(executionId) ||
                run.closingExecutions.has(executionId) ||
                execution.attemptNo !== input.attemptNo ||
                run.projection.tasks[input.taskId]?.activeExecutionId !== executionId ||
                this.storageError
              )
                throw new Error('native owner is closed');
              const effectId = nativeEffects.get(toolCallId);
              if (!effectId || run.projection.effects[effectId]?.status !== 'admitted')
                throw new Error('native call is closed');
              this.commit(run, [
                {
                  type: 'tool.finished',
                  executionId,
                  payload: {
                    executionId,
                    toolCallId,
                    resultRef: null,
                    error: outcome === 'failed' ? 'native_tool_failed' : null,
                  },
                },
                { type: 'effect.settled', executionId, payload: { effectId, outcome } },
              ]);
              nativeEffects.delete(toolCallId);
            },
          }
        : {}),
      prepareModelRequest: async (rawRecord?: ModelRequestRecord): Promise<RequestPermit> => {
        if (harness && harnessState !== 'loaded') throw new Error('harness not loaded');
        if (harness && !rawRecord) throw new Error('SDK request record is required');
        const record = rawRecord ? ModelRequestRecord.parse(rawRecord) : undefined;
        if (record && !harness) throw new Error('unexpected SDK request record');
        for (const id of record?.directiveIds ?? []) {
          const directive = run.projection.directives[id];
          if (
            !directive ||
            directive.targetExecutionId !== executionId ||
            !['queued', 'attached_to_request', 'delivered'].includes(directive.status)
          )
            throw new Error('unknown directive in request');
        }
        do {
          await this.boundary(run, executionId);
        } while (run.projection.status !== 'running');
        requireActive();
        const view: ModelGateView = { projection: run.projection, limits: run.limits, input };
        const request = runGates(this.gates['model.request'], view);
        if (request.kind === 'refuse') this.refuseModelRequest(run, request);
        if (request.kind === 'require_approval') {
          this.commit(run, [
            {
              type: 'limit.reached',
              payload: {
                limitKind: request.limit.kind,
                used: request.limit.used,
                reserved: request.limit.reserved ?? 0,
                max: request.limit.max,
              },
            },
          ]);
          const requested = this.requestApproval(run, 'user_action', [run.criteriaVersionId]);
          run.boundaries.add(executionId);
          try {
            if ((await requested.decision) !== 'approve')
              throw new Error(`${request.limit.kind} stopped`);
          } finally {
            run.boundaries.delete(executionId);
          }
          do {
            await this.boundary(run, executionId);
          } while (run.projection.status !== 'running');
          requireActive();
        }
        // Wait for a model slot; a waiting execution is not in a request and holds none.
        await this.acquireSlot(run, executionId);
        try {
          do {
            await this.boundary(run, executionId);
          } while (run.projection.status !== 'running');
          requireActive();
        } catch (error) {
          this.releaseSlot(run);
          throw error;
        }
        const limits = run.limits;
        const admit = runGates(this.gates['model.admit'], {
          projection: run.projection,
          limits,
          input,
        });
        if (admit.kind !== 'allow') {
          this.releaseSlot(run);
          this.refuseModelRequest(
            run,
            admit.kind === 'refuse'
              ? admit
              : {
                  kind: 'refuse',
                  code: 'CAPABILITY_DENIED',
                  message: 'admission cannot wait for approval after a slot is held',
                },
          );
        }
        // The reservation itself is the Coordinator's: even without a budget gate, a request the
        // budget cannot cover is not admitted.
        const admitted = admitModelRequest(run.projection.budget, limits);
        if (!admitted.ok) {
          this.releaseSlot(run);
          this.commit(run, [
            {
              type: 'limit.reached',
              payload: {
                limitKind: admitted.limitKind,
                used: admitted.used,
                reserved: admitted.reserved,
                max: admitted.max,
              },
            },
          ]);
          throw new Error(`LIMIT_REACHED: ${admitted.limitKind}`);
        }
        const modelCallId = this.ids.next('model_call');
        const contextSnapshotId = this.ids.next('context_snapshot');
        const effectId = this.ids.next('effect');
        run.slots.held.set(modelCallId, executionId);
        // The snapshot takes every directive queued for this execution right now.
        const queued = run.projection.directiveOrder
          .map((id) => run.projection.directives[id])
          .filter(
            (d) =>
              d?.targetExecutionId === executionId &&
              d.status === 'queued' &&
              (!record || record.directiveIds.includes(d.directiveId)),
          )
          .map((d) => ({ directiveId: d?.directiveId ?? '', text: d?.text ?? '' }));
        const directiveIds = queued.map((d) => d.directiveId);
        this.commit(run, [
          ...(record && harness
            ? [
                {
                  type: 'model.request_recorded',
                  executionId,
                  payload: { ...record, modelCallId, snapshotHash: harness.snapshotHash },
                } satisfies EventDraft,
              ]
            : []),
          {
            type: 'budget.reserved',
            executionId,
            payload: {
              reservationId: modelCallId,
              modelCallId,
              scope: executionId,
              amount: { outputTokens: admitted.maxOutputTokens, modelCalls: 1 },
            },
          },
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
              configRevision: run.projection.executions[executionId]?.configRevision ?? 0,
              directiveIds,
              inputArtifactVersionIds: [
                ...new Set([
                  ...(run.inputsByExecution.get(executionId) ?? input.inputs).flatMap((i) =>
                    i.artifactVersionId ? [i.artifactVersionId] : [],
                  ),
                  ...(run.projection.artifactReads[executionId] ?? []),
                ]),
              ],
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
              reservationId: modelCallId,
            },
          },
        ]);
        lastCall = { modelCallId, contextSnapshotId, effectId };
        run.requestDeadlines.set(
          modelCallId,
          this.timers.after(run.limits.modelTimeoutMs, () => {
            if (
              run.projection.effects[effectId]?.status !== 'admitted' ||
              TERMINAL_RUN_STATUSES.has(run.projection.status)
            )
              return;
            this.submit({
              schemaVersion: '0.1',
              runId: run.runId,
              commandId: `timeout_${modelCallId}`,
              type: 'cancel',
              payload: {
                scope: { kind: 'execution', executionId },
                reason: 'model_request_timeout',
              },
            });
          }),
        );
        return {
          modelCallId,
          contextSnapshotId,
          profile: input.modelProfile,
          maxOutputTokens: admitted.maxOutputTokens,
          directives: queued,
        };
      },

      modelRequestDispatched: async (modelCallId: string) => {
        const call = run.projection.modelCalls[modelCallId];
        if (
          !call ||
          call.executionId !== executionId ||
          call.finished ||
          lastCall?.modelCallId !== modelCallId
        )
          throw new Error('unknown or closed model request');
        if (
          run.cancelRequested.has(executionId) ||
          TERMINAL_RUN_STATUSES.has(run.projection.status)
        ) {
          this.commit(run, [
            {
              type: 'observation.late',
              executionId,
              payload: {
                originalEventType: 'model.dispatch',
                originalRef: modelCallId,
                whyIgnored: 'scope cancelled',
              },
            },
          ]);
          throw new Error('scope cancelled');
        }
        const drafts: EventDraft[] = call.directiveIds
          .filter((id) => run.projection.directives[id]?.status === 'attached_to_request')
          .map((directiveId) => ({
            type: 'directive.dispatched',
            executionId,
            payload: { directiveId, modelCallId, executionEpoch: input.attemptNo },
          }));
        if (!run.projection.effects[lastCall.effectId]?.dispatched)
          drafts.unshift({
            type: 'effect.dispatch_observed',
            executionId,
            payload: { effectId: lastCall.effectId, providerRequestId: null },
          });
        if (drafts.length) this.commit(run, drafts);
      },

      observe: async (observation: AgentObservation) => {
        const call = run.projection.modelCalls[observation.modelCallId];
        if (!call || call.executionId !== executionId) throw new Error('unknown model call');
        run.requestDeadlines.get(observation.modelCallId)?.();
        run.requestDeadlines.delete(observation.modelCallId);
        if (run.slots.held.delete(observation.modelCallId)) this.releaseSlot(run);
        const effectId =
          Object.values(run.projection.effects).find(
            (effect) =>
              effect.kind === 'model_request' &&
              effect.scope === executionId &&
              effect.reservationId === observation.modelCallId,
          )?.effectId ?? null;
        const budget = settlementFor(
          run.projection.budget,
          observation.modelCallId,
          observation.usage.outputTokens,
        );
        const late =
          call.finished ||
          run.cancelRequested.has(executionId) ||
          TERMINAL_EXECUTION_STATUSES.has(
            run.projection.executions[executionId]?.status ?? 'failed',
          ) ||
          TERMINAL_RUN_STATUSES.has(run.projection.status) ||
          run.projection.tasks[input.taskId]?.activeExecutionId !== executionId;
        const responseRef = late ? null : `response_${observation.modelCallId}`;
        const normalizedUsage = {
          inputTokens: observation.usage.inputTokens,
          outputTokens: observation.usage.outputTokens,
          cachedInputTokens: observation.usage.cachedInputTokens ?? null,
          reasoningTokens: observation.usage.reasoningTokens ?? null,
        };
        const usage = {
          executionId,
          modelCallId: observation.modelCallId,
          rawUsage: observation.rawUsage ?? null,
          normalizedUsage,
          certainty: Object.values(normalizedUsage).some((count) => count !== null)
            ? ('reported' as const)
            : ('unknown' as const),
        };
        const drafts: EventDraft[] = budget
          ? [{ type: 'budget.settled', executionId, payload: budget }]
          : [];
        if (late) {
          const addsUsage =
            call.usage === null ||
            (call.rawUsage == null && usage.rawUsage !== null) ||
            (['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens'] as const).some(
              (key) => call.usage?.[key] == null && normalizedUsage[key] !== null,
            );
          if (addsUsage)
            drafts.push({ type: 'model.usage_reconciled', executionId, payload: usage });
          drafts.push({
            type: 'observation.late',
            executionId,
            payload: {
              originalEventType: 'model.finished',
              originalRef: observation.modelCallId,
              whyIgnored: 'the request or scope has ended',
            },
          });
        } else
          drafts.push({
            type: 'model.finished',
            actor: agent,
            executionId,
            payload: {
              ...usage,
              responseRef,
            },
          });
        if (effectId && run.projection.effects[effectId]?.status === 'admitted')
          drafts.push({
            type: 'effect.settled',
            executionId,
            payload: { effectId, outcome: late ? 'unknown' : 'succeeded' },
          });
        this.commit(run, drafts, () => {
          if (responseRef) this.store.putArtifactText(run.runId, responseRef, observation.text);
        });
        this.maybePaused(run);
      },

      invokeTool: async (proposal: ToolProposal): Promise<ToolOutcome> => {
        const authorization = await authorizeTool(proposal);
        return authorization.ok ? trackedExecute(authorization.toolCallId) : authorization;
      },
      authorizeTool: (proposal) => authorizeTool(proposal),
      executeTool: (toolCallId) => trackedExecute(toolCallId),

      streamText: (delta) => {
        // Only the open request of this execution streams; anything else is dropped.
        const call = run.projection.modelCalls[delta.modelCallId];
        if (lastCall?.modelCallId !== delta.modelCallId || !call || call.finished) return;
        if (run.projection.executions[executionId]?.status !== 'active') return;
        this.publishFrame({ runId: run.runId, ...delta });
      },
    };
  }

  /** What tool gates see: the run as committed, this execution and the proposed call. */
  private toolView(run: LiveRun, input: AgentStartInput, proposal: ToolProposal): ToolGateView {
    return {
      projection: run.projection,
      limits: run.limits,
      input,
      proposal,
      policy: this.policy,
      callables: run.plan.callables[input.nodeId] ?? { delegate: [], question: [] },
      externalTools: Boolean(this.tools),
      fileTools: this.files?.available(run.runId) ?? false,
      harnessRead: Boolean(this.harnesses?.readSkill),
      responderOf: (questionId) => run.questions.get(questionId)?.responderExecutionId,
      readable: () => this.readable(run, input),
    };
  }

  /** A refused model request: the limit it reached, if any, is a fact; the agent gets an error. */
  private refuseModelRequest(run: LiveRun, refusal: Refusal): never {
    if (refusal.limit) {
      this.commit(run, [
        {
          type: 'limit.reached',
          payload: {
            limitKind: refusal.limit.kind,
            used: refusal.limit.used,
            reserved: refusal.limit.reserved ?? 0,
            max: refusal.limit.max,
          },
        },
      ]);
      throw new Error(`LIMIT_REACHED: ${refusal.limit.kind}`);
    }
    throw new Error(`${refusal.code}: ${refusal.message}`);
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
      // The same node's output in the previous Loop round is the version this one revises,
      // so draft@1 → draft@2 is one artifact (C-030). Parallel helpers stay separate.
      const previous = existing.length === 0 ? this.previousRoundOutput(run, input) : null;
      const artifactId =
        existing[0]?.artifactId ?? previous?.artifactId ?? this.ids.next('artifact');
      const versionBase = existing.at(-1)?.version ?? previous?.version ?? 0;
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
              version: versionBase + 1,
              artifactVersionId,
              parentVersionId:
                existing.at(-1)?.artifactVersionId ?? previous?.artifactVersionId ?? null,
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

  /** The latest version the same node wrote in the previous round of its Loop. */
  private previousRoundOutput(run: LiveRun, input: AgentStartInput) {
    const iterationId = run.projection.executions[input.executionId]?.iterationId;
    const previous = iterationId ? this.previousRound(run, iterationId) : null;
    if (!previous) return null;
    const authors = new Set(
      Object.values(run.projection.executions)
        .filter((e) => e.nodeId === input.nodeId && e.iterationId === previous)
        .map((e) => e.executionId),
    );
    return (
      Object.values(run.projection.artifacts)
        .filter((a) => authors.has(a.authorExecutionId))
        .at(-1) ?? null
    );
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
        p.tasks[taskId]?.activeExecutionId ??
        Object.values(p.executions)
          .filter((e) => e.taskId === taskId)
          .at(-1)?.executionId ??
        taskId,
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
    for (const taskId of taskIds) {
      for (;;) {
        const pending = run.taskOutcomes.get(taskId);
        await pending;
        if (run.stop.aborted || run.cancelRequested.has(executionId)) break;
        const task = run.projection.tasks[taskId];
        if (task?.status === 'completed' || task?.status === 'failed') break;
        if (task?.status === 'in_progress' && run.taskOutcomes.get(taskId) !== pending) continue;
        await new Promise<void>((resolve) => run.boundaryWaiters.add(resolve));
      }
    }
    const results = taskIds.map((taskId) => {
      const task = run.projection.tasks[taskId];
      return {
        taskId,
        status: task?.status ?? 'failed',
        artifactVersionIds: task?.status === 'completed' ? task.submittedArtifactVersionIds : [],
      };
    });
    if (run.cancelRequested.has(executionId) || run.stop.aborted) {
      this.commit(run, tool.closing(null, 'scope cancelled'));
      return {
        ok: false,
        toolCallId: tool.toolCallId,
        error: { code: 'TARGET_TERMINAL', message: 'scope cancelled' },
      };
    }
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
    const timeoutMs = run.limits.questionTimeoutMs;
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

    const logicalDeadline = new LogicalDeadline(this.clock, this.timers, timeoutMs, () =>
      this.timeOut(run, questionId),
    );
    const answer = new Promise<Record<string, unknown>>((resolve) => {
      run.questions.set(questionId, {
        askerExecutionId: executionId,
        responderExecutionId: responder.input.executionId,
        wake: resolve,
        cancelTimer: () => logicalDeadline.cancel(),
        deadline: logicalDeadline,
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

  private async externalTool(
    run: LiveRun,
    input: AgentStartInput,
    proposal: ToolProposal,
    tool: ToolFrame,
  ): Promise<ToolOutcome> {
    const executionId = input.executionId;
    const scopeListeners = run.cancelListeners.get(executionId) ?? new Set<() => void>();
    run.cancelListeners.set(executionId, scopeListeners);
    const listeners = new Set<() => void>();
    let timedOut = false;
    const abort = () => {
      for (const listener of listeners) listener();
    };
    scopeListeners.add(abort);
    const cancellation: ToolCancellation = {
      get aborted() {
        return (
          timedOut || run.cancelRequested.has(executionId) || run.closingExecutions.has(executionId)
        );
      },
      onCancel(fn) {
        listeners.add(fn);
        if (this.aborted) fn();
        return () => {
          listeners.delete(fn);
        };
      },
    };
    const cancelTimer = this.timers.after(30_000, () => {
      timedOut = true;
      abort();
      this.submit({
        schemaVersion: '0.1',
        runId: run.runId,
        commandId: `timeout_${tool.toolCallId}`,
        type: 'cancel',
        payload: { scope: { kind: 'execution', executionId }, reason: 'tool_timeout' },
      });
    });
    this.commit(run, tool.opening);
    try {
      const fileTool =
        (FILE_TOOLS as readonly string[]).includes(proposal.name) ||
        proposal.name === 'edit' ||
        proposal.name === 'write';
      let result: Record<string, unknown>;
      if (proposal.name === 'read') {
        const path = String(proposal.args.path);
        if (path.startsWith('skills/')) {
          if (!input.harness || !this.harnesses?.readSkill)
            throw new ToolRefusal('CAPABILITY_DENIED', 'skill broker unavailable');
          result = this.harnesses.readSkill(input.harness, path);
        } else {
          if (!this.files) throw new ToolRefusal('CAPABILITY_DENIED', 'worktree unavailable');
          result = await this.files.execute(
            {
              name: 'read_file',
              args: { path },
              runId: run.runId,
              executionId,
              toolCallId: tool.toolCallId,
            },
            cancellation,
          );
        }
        const lines = String(result.text ?? '').split('\n');
        const offset = Number(proposal.args.offset ?? 1);
        if (offset > lines.length)
          throw new ToolRefusal('SCHEMA_INVALID', 'read offset is beyond the end of the file');
        if (utf8ToBytes(lines[offset - 1] ?? '').length > 50 * 1024)
          throw new ToolRefusal('LIMIT_REACHED', 'the requested line exceeds the read size limit');
      } else if (fileTool) {
        const files = this.files;
        if (!files) throw new ToolRefusal('CAPABILITY_DENIED', 'no worktree for this run');
        result = await files.execute(
          {
            name: proposal.name as BrokerFileToolName,
            args: proposal.args,
            runId: run.runId,
            executionId,
            toolCallId: tool.toolCallId,
          },
          cancellation,
        );
      } else {
        const tools = this.tools;
        if (!tools) throw new Error('external tools unavailable');
        result = await tools.execute(
          {
            name: proposal.name as 'search' | 'read_document',
            args: proposal.args,
            mode: input.mode,
            runId: run.runId,
            executionId,
          },
          cancellation,
        );
      }
      const execution = run.projection.executions[executionId];
      if (
        cancellation.aborted ||
        TERMINAL_RUN_STATUSES.has(run.projection.status) ||
        !execution ||
        TERMINAL_EXECUTION_STATUSES.has(execution.status) ||
        execution.attemptNo !== input.attemptNo ||
        run.projection.tasks[input.taskId]?.activeExecutionId !== executionId ||
        run.projection.effects[tool.effectId]?.status !== 'admitted'
      ) {
        this.commit(run, [
          ...tool.closing(null, 'scope cancelled'),
          {
            type: 'observation.late',
            executionId,
            payload: {
              originalEventType: 'tool.finished',
              originalRef: tool.toolCallId,
              whyIgnored: 'scope cancelled',
            },
          },
        ]);
        return {
          ok: false,
          toolCallId: tool.toolCallId,
          error: { code: 'TARGET_TERMINAL', message: 'scope cancelled' },
        };
      }
      const resultRef = `result_${tool.toolCallId}`;
      const text = JSON.stringify(result);
      this.commit(run, tool.closing(resultRef), () =>
        this.store.putArtifactText(run.runId, resultRef, text),
      );
      const inputs = run.inputsByExecution.get(executionId) ?? input.inputs;
      run.inputsByExecution.set(executionId, [
        ...inputs,
        { name: proposal.name, kind: 'explicit_version', artifactVersionId: resultRef, text },
      ]);
      return { ok: true, toolCallId: tool.toolCallId, result };
    } catch (error) {
      // A file backend's refusal (conflict, path policy) is told to the agent as it is.
      const refusal = error instanceof ToolRefusal ? error : null;
      const message = refusal?.message ?? 'external tool failed';
      this.commit(run, tool.closing(null, message));
      return {
        ok: false,
        toolCallId: tool.toolCallId,
        error: { code: refusal?.code ?? 'CAPABILITY_DENIED', message },
      };
    } finally {
      cancelTimer();
      scopeListeners.delete(abort);
      listeners.clear();
    }
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
    if (
      typeof value === 'string' &&
      (value.length > 256 || ['query', 'text', 'body', 'brief', 'instruction'].includes(key))
    ) {
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
