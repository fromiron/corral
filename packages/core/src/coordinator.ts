import {
  type AgentAdapter,
  type AgentHost,
  type AgentObservation,
  type AgentSettlement,
  type AgentStartInput,
  type Clock,
  type CommandError,
  type CorralDefinition,
  type EventPayload,
  type IdFactory,
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
import { definitionHash } from './definition-hash.ts';
import { planLinearRun } from './linear-plan.ts';
import { applyEvent, emptyProjection, type RunProjection } from './projection.ts';

// P0 in-memory Coordinator (ADR-003). Only this class decides domain state: commands are
// validated, turned into events, committed atomically to the run log, and only then are
// effects (agent work) scheduled. Agents report back through the host, which re-enters here.
// C-011/C-012 move the log to SQLite and split pure decide/reduce; the contract stays.

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const USER = { kind: 'user', id: 'local_user' } as const;
const RUNTIME = { kind: 'runtime', id: 'coordinator' } as const;

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

interface CommandRecord {
  payloadHash: string;
  receipt: Receipt;
  directiveId?: string;
}

interface Subscriber {
  nextSeq: number;
  onEvent: (event: RunEvent) => void;
  onError: ((error: unknown) => void) | undefined;
}

interface RunRecord {
  runId: string;
  definition: CorralDefinition;
  agentNodeIds: string[];
  outputNodeId: string;
  step: number;
  events: RunEvent[];
  projection: RunProjection;
  artifactTexts: Map<string, string>;
  commands: Map<string, CommandRecord>;
  subscribers: Set<Subscriber>;
  modelCalls: number;
}

export interface CoordinatorDeps {
  clock: Clock;
  ids: IdFactory;
  agents: AgentAdapter;
}

export class InMemoryCoordinator {
  private readonly clock: Clock;
  private readonly ids: IdFactory;
  private readonly agents: AgentAdapter;
  private readonly runs = new Map<string, RunRecord>();
  private readonly startCommands = new Map<string, CommandRecord & { runId: string | null }>();

  constructor(deps: CoordinatorDeps) {
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.agents = deps.agents;
  }

  // ── commands ──────────────────────────────────────────────────────────────

  startRun(raw: StartRunRequest): StartRunResult {
    const parsed = StartRunRequest.safeParse(raw);
    if (!parsed.success) {
      return { runId: null, receipt: rejected(raw.commandId, 'none', schemaError(parsed.error)) };
    }
    const request = parsed.data;
    const payloadHash = hashOf(request);
    const previous = this.startCommands.get(request.commandId);
    if (previous) {
      if (previous.payloadHash !== payloadHash) {
        return { runId: null, receipt: conflict(request.commandId, previous.receipt.runId) };
      }
      return { runId: previous.runId, receipt: previous.receipt };
    }

    const plan = planLinearRun(request.definition);
    if (!plan.ok) {
      const message = plan.issues
        .map((i) => `${i.nodeId ?? i.edgeId ?? 'graph'}: ${i.message}`)
        .join('; ');
      const receipt = rejected(request.commandId, 'none', { code: 'GRAPH_INVALID', message });
      this.startCommands.set(request.commandId, { payloadHash, receipt, runId: null });
      return { runId: null, receipt };
    }

    const runId = this.ids.next('run');
    const run: RunRecord = {
      runId,
      definition: request.definition,
      agentNodeIds: plan.agentNodeIds,
      outputNodeId: plan.outputNodeId,
      step: 0,
      events: [],
      projection: emptyProjection(runId),
      artifactTexts: new Map(),
      commands: new Map(),
      subscribers: new Set(),
      modelCalls: 0,
    };
    this.runs.set(runId, run);
    const [started] = this.commit(run, [
      {
        type: 'run.started',
        actor: USER,
        commandId: request.commandId,
        payload: {
          corralId: request.definition.id,
          definitionHash: definitionHash(request.definition),
          inputHash: hashOf(request.definition.input),
          mode: request.mode,
          modelProfiles: [...new Set(request.definition.roles.map((r) => r.modelProfile))].map(
            (profile) => ({ profile, provider: null, modelId: null, auth: 'mock' as const }),
          ),
          limits: request.definition.limits,
        },
      },
      runState('created', 'validating', 'run_requested'),
      runState('validating', 'running', 'validation_passed'),
    ]);
    const receipt: Receipt = {
      commandId: request.commandId,
      runId,
      status: 'applied',
      acceptedSeq: started?.runSeq ?? null,
      target: `run:${runId}`,
      requestedBoundary: 'immediate',
      relatedEventIds: started ? [started.eventId] : [],
    };
    this.startCommands.set(request.commandId, { payloadHash, receipt, runId });
    this.schedule(run, () => this.advance(run));
    return { runId, receipt };
  }

  submit(raw: RunCommand): Receipt {
    const parsed = RunCommand.safeParse(raw);
    if (!parsed.success) return rejected(raw.commandId, raw.runId, schemaError(parsed.error));
    const command = parsed.data;
    const run = this.runs.get(command.runId);
    if (!run) {
      return rejected(command.commandId, command.runId, {
        code: 'TARGET_NOT_FOUND',
        message: `run ${command.runId} does not exist`,
      });
    }
    const payloadHash = hashOf(command);
    const previous = run.commands.get(command.commandId);
    if (previous) {
      if (previous.payloadHash !== payloadHash) return conflict(command.commandId, run.runId);
      return this.currentReceipt(run, previous);
    }
    const record: CommandRecord =
      command.type === 'steer'
        ? this.steer(run, command, payloadHash)
        : {
            payloadHash,
            receipt: rejected(command.commandId, run.runId, {
              code: 'COMMAND_NOT_SUPPORTED',
              message: `${command.type} is not available in this runtime yet`,
            }),
          };
    run.commands.set(command.commandId, record);
    return this.currentReceipt(run, record);
  }

  private steer(run: RunRecord, command: SteerCommand, payloadHash: string): CommandRecord {
    const executionId = command.payload.targetExecutionId;
    const execution = run.projection.executions[executionId];
    const refuse = (error: CommandError): CommandRecord => ({
      payloadHash,
      receipt: rejected(command.commandId, run.runId, error, `execution:${executionId}`),
    });
    if (!execution) {
      return refuse({
        code: 'TARGET_NOT_FOUND',
        message: `execution ${executionId} does not exist`,
      });
    }
    if (
      TERMINAL_EXECUTION_STATUSES.has(execution.status) ||
      TERMINAL_RUN_STATUSES.has(run.projection.status)
    ) {
      return refuse({ code: 'TARGET_TERMINAL', message: `execution ${executionId} has finished` });
    }
    const directiveId = this.ids.next('directive');
    const [accepted] = this.commit(run, [
      {
        type: 'directive.accepted',
        actor: USER,
        commandId: command.commandId,
        executionId,
        payload: { directiveId, targetExecutionId: executionId, text: command.payload.text },
      },
    ]);
    return {
      payloadHash,
      directiveId,
      receipt: {
        commandId: command.commandId,
        runId: run.runId,
        status: 'queued',
        acceptedSeq: accepted?.runSeq ?? null,
        target: `execution:${executionId}`,
        requestedBoundary: 'next_request',
        relatedEventIds: accepted ? [accepted.eventId] : [],
      },
    };
  }

  /** A steer receipt follows its directive: queued until a request carries it. */
  private currentReceipt(run: RunRecord, record: CommandRecord): Receipt {
    if (!record.directiveId) return record.receipt;
    const directive = run.projection.directives[record.directiveId];
    const status = (() => {
      switch (directive?.status) {
        case 'delivered':
          return 'applied' as const;
        case 'expired':
          return 'expired' as const;
        case 'not_delivered':
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

  getReceipt(runId: string, commandId: string): Receipt | null {
    const run = this.runs.get(runId);
    const record = run?.commands.get(commandId);
    if (run && record) return this.currentReceipt(run, record);
    const start = this.startCommands.get(commandId);
    return start?.runId === runId ? start.receipt : null;
  }

  getSnapshot(runId: string): { projection: RunProjection; seq: number } {
    const run = this.requireRun(runId);
    return { projection: run.projection, seq: run.projection.lastSeq };
  }

  getArtifactText(runId: string, artifactVersionId: string): string | null {
    return this.runs.get(runId)?.artifactTexts.get(artifactVersionId) ?? null;
  }

  /** Delivers every event after `afterSeq` exactly once, in order, then follows live commits. */
  subscribe(
    runId: string,
    afterSeq: number,
    onEvent: (event: RunEvent) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const run = this.requireRun(runId);
    const subscriber: Subscriber = { nextSeq: afterSeq + 1, onEvent, onError };
    run.subscribers.add(subscriber);
    void Promise.resolve().then(() => this.pump(run, subscriber));
    return () => {
      run.subscribers.delete(subscriber);
    };
  }

  // ── commit and fan-out ────────────────────────────────────────────────────

  private commit(run: RunRecord, drafts: EventDraft[]): RunEvent[] {
    let projection = run.projection;
    const committed: RunEvent[] = [];
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
      committed.push(deepFreeze(event));
    }
    // All drafts are valid; publish them together (the in-memory transaction boundary).
    run.events.push(...committed);
    run.projection = projection;
    for (const subscriber of run.subscribers) {
      void Promise.resolve().then(() => this.pump(run, subscriber));
    }
    return committed;
  }

  private pump(run: RunRecord, subscriber: Subscriber) {
    while (run.subscribers.has(subscriber) && subscriber.nextSeq <= run.events.length) {
      const event = run.events[subscriber.nextSeq - 1] as RunEvent;
      subscriber.nextSeq += 1;
      try {
        subscriber.onEvent(event);
      } catch (error) {
        // A failing consumer is detached and told why; it must re-read from a snapshot.
        run.subscribers.delete(subscriber);
        subscriber.onError?.(error);
      }
    }
  }

  private schedule(run: RunRecord, effect: () => Promise<void>) {
    void Promise.resolve()
      .then(effect)
      .catch((error: unknown) => this.failRun(run, `internal_error: ${String(error)}`));
  }

  private failRun(run: RunRecord, reason: string) {
    const status = run.projection.status;
    if (TERMINAL_RUN_STATUSES.has(status)) return;
    this.commit(run, [runState(status, 'failed', reason)]);
  }

  // ── P0 linear runner ──────────────────────────────────────────────────────

  private async advance(run: RunRecord): Promise<void> {
    if (run.projection.status !== 'running') return;
    const nodeId = run.agentNodeIds[run.step];
    if (nodeId === undefined) {
      this.finalizeOutput(run);
      return;
    }
    await this.runAgent(run, nodeId);
  }

  private async runAgent(run: RunRecord, nodeId: string): Promise<void> {
    const node = run.definition.nodes.find((n) => n.id === nodeId);
    const role = node?.type === 'agent' && run.definition.roles.find((r) => r.id === node.roleId);
    if (node?.type !== 'agent' || !role) throw new Error(`plan references missing agent ${nodeId}`);

    const taskId = this.ids.next('task');
    const executionId = this.ids.next('execution');
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
          attemptNo: 1,
          depth: 0,
          iterationId: null,
          modelProfile: role.modelProfile,
        },
      },
      {
        type: 'task.attempt_assigned',
        taskId,
        executionId,
        payload: { taskId, executionId, attemptNo: 1 },
      },
      {
        type: 'execution.state_changed',
        executionId,
        payload: { executionId, from: 'queued', to: 'active', activity: 'model', waitingOn: null },
      },
    ]);

    const input: AgentStartInput = {
      runId: run.runId,
      executionId,
      taskId,
      nodeId,
      attemptNo: 1,
      role,
      modelProfile: role.modelProfile,
      inputs: this.resolveInputs(run, node.inputBindings),
    };
    let settlement: AgentSettlement;
    try {
      const handle = await this.agents.start(input, this.hostFor(run, input));
      settlement = await handle.waitForSettlement();
    } catch (error) {
      settlement = { outcome: 'failed', error: String(error) };
    }
    this.settle(run, input, settlement);
  }

  private resolveInputs(
    run: RunRecord,
    bindings: { kind: string; name: string; sourceNodeId?: string | undefined }[],
  ): ResolvedInput[] {
    const { brief, criteria } = run.definition.input;
    return bindings.map((binding): ResolvedInput => {
      if (binding.kind === 'run_input') {
        const text = binding.name === 'criteria' ? criteria.join('\n') : brief;
        return { name: binding.name, kind: 'run_input', artifactVersionId: null, text };
      }
      const versionId = this.submittedOutputOf(run, binding.sourceNodeId ?? '')[0];
      if (!versionId) throw new Error(`input "${binding.name}" has no submitted version`);
      return {
        name: binding.name,
        kind: 'task_output',
        artifactVersionId: versionId,
        text: run.artifactTexts.get(versionId) ?? '',
      };
    });
  }

  private submittedOutputOf(run: RunRecord, nodeId: string): string[] {
    const executions = run.projection.nodeExecutions[nodeId] ?? [];
    for (const executionId of [...executions].reverse()) {
      const taskId = run.projection.executions[executionId]?.taskId ?? '';
      const task = run.projection.tasks[taskId];
      if (task?.status === 'completed') return task.submittedArtifactVersionIds;
    }
    return [];
  }

  private settle(run: RunRecord, input: AgentStartInput, settlement: AgentSettlement) {
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
    ];
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

    if (outcome === 'succeeded') {
      run.step += 1;
      this.schedule(run, () => this.advance(run));
    } else {
      this.failRun(run, `execution_${outcome}`);
    }
  }

  private finalizeOutput(run: RunRecord) {
    const output = run.definition.nodes.find((n) => n.id === run.outputNodeId);
    if (output?.type !== 'output') throw new Error('plan references a missing output node');
    const versions = output.inputBindings.flatMap((b) =>
      b.kind === 'task_output' ? this.submittedOutputOf(run, b.sourceNodeId ?? '') : [],
    );
    if (versions.length === 0) {
      this.failRun(run, 'output_has_no_submitted_version');
      return;
    }
    this.commit(run, [
      {
        type: 'output.finalized',
        payload: { nodeId: output.id, artifactVersionIds: versions, approvalId: null },
      },
      runState('running', 'succeeded', 'output_finalized'),
    ]);
  }

  // ── agent host: the only way an agent affects the run ─────────────────────

  private hostFor(run: RunRecord, input: AgentStartInput): AgentHost {
    const { executionId } = input;
    const agent: Actor = { kind: 'agent', id: executionId };
    let lastCall: { modelCallId: string; contextSnapshotId: string } | null = null;

    const requireActive = () => {
      const status = run.projection.executions[executionId]?.status;
      if (status !== 'active' || run.projection.status !== 'running') {
        throw new Error(`execution ${executionId} is not active`);
      }
    };

    return {
      prepareModelRequest: async (): Promise<RequestPermit> => {
        requireActive();
        const limits = run.definition.limits;
        if (run.modelCalls >= limits.maxModelCalls) {
          throw new Error(`LIMIT_REACHED: ${limits.maxModelCalls} model calls`);
        }
        const modelCallId = this.ids.next('model_call');
        const contextSnapshotId = this.ids.next('context_snapshot');
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
          // P0 mock transport starts the request synchronously with the permit.
          ...directiveIds.map(
            (directiveId): EventDraft => ({
              type: 'directive.dispatched',
              executionId,
              payload: { directiveId, modelCallId, executionEpoch: input.attemptNo },
            }),
          ),
        ]);
        run.modelCalls += 1;
        lastCall = { modelCallId, contextSnapshotId };
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
          if (bytes.length > MAX_ARTIFACT_BYTES) {
            return block({
              code: 'LIMIT_REACHED',
              message: 'artifact versions are limited to 1 MiB',
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
    run: RunRecord,
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
    run.artifactTexts.set(artifactVersionId, text);
    this.commit(run, [
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
          name: outputNameOf(run.definition, input.nodeId),
          contract: input.role.outputContract,
          contentHash: bytesToHex(sha256(bytes)),
          byteLength: bytes.length,
          authorExecutionId: input.executionId,
          modelCallId: lastCall?.modelCallId ?? null,
          contextSnapshotId: lastCall?.contextSnapshotId ?? null,
        },
      },
    ]);
    return artifactVersionId;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run ${runId} does not exist`);
    return run;
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
