import {
  type AgentStartInput,
  type ErrorCode,
  FILE_TOOLS,
  GenerateImageArgs,
  HashlineEditInput,
  LspQuery,
  PiEditInput,
  PiWriteInput,
  PreviewActionArgs,
  PreviewAppArgs,
  PreviewFileArgs,
  ResourcePath,
  RunCommandArgs,
  type RunEvent,
  type RunLimits,
  TERMINAL_EXECUTION_STATUSES,
  type ToolProposal,
  UserInputRequest,
  WorkPlanUpdate,
} from '@corral/contracts';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { admitModelRequest } from '../budget.ts';
import type { InstallationPolicy } from '../config.ts';
import { createsWaitCycle, NO_PROGRESS_TURNS, noProgressReached } from '../limits.ts';
import type { RunProjection } from '../projection.ts';

// Admission gates and observers (CR-003, ADR-024, Technical-Design §5.4).
//
// A gate is a synchronous, read-only check at one admission point. Gates of a stage run in
// registration order and the first refusal stops the stage; a gate that throws refuses the call
// (fail closed). Observers run after a commit, may not block or change anything, and their
// failures never reach the run. Both are registered once, when the Coordinator is created.

export type AdmissionStage =
  /** Before a model slot is taken: whether this execution may make another request. */
  | 'model.request'
  /** After the slot: whether the run's budget admits the request. */
  | 'model.admit'
  /** Before waiting for the safe boundary: checks whose outcome a pause cannot change. */
  | 'tool.pre_boundary'
  /** At the safe boundary, when the agent proposes a call. */
  | 'tool.authorize'
  /** Again right before an authorized call runs. */
  | 'tool.execute';

export interface LimitHit {
  kind: 'model_calls' | 'output_tokens' | 'spawns' | 'questions' | 'depth' | 'no_progress';
  used: number;
  reserved?: number;
  max: number;
}

export type GateDecision =
  | { kind: 'allow' }
  | {
      kind: 'refuse';
      code: ErrorCode;
      message: string;
      limit?: LimitHit;
    }
  /** Only the person can let this request through (no progress, Spec §9). */
  | { kind: 'require_approval'; approval: 'user_action'; limit: LimitHit };

export interface ModelGateView {
  projection: RunProjection;
  limits: RunLimits;
  input: AgentStartInput;
}

export interface ToolGateView extends ModelGateView {
  simulation?: boolean;
  /** Only the owning batch may exclude its open effect when rechecking the next item. */
  currentEffectId?: string;
  reservedSpawns?: number;
  pendingChildContinuation?: boolean;
  harnessRead?: boolean;
  descriptor?: import('@corral/contracts').ToolDescriptor;
  proposal: ToolProposal;
  policy: InstallationPolicy;
  /** Callable nodes this node may delegate to or ask (capability links). */
  callables: {
    delegate: readonly string[];
    question: readonly string[];
    parentQuestion?: readonly string[];
    replyToChildren?: boolean;
  };
  /** Whether search/read_document have a backend in this runtime. */
  externalTools: boolean;
  /** Whether this run's session has a managed worktree for file tools (CR-012). */
  fileTools: boolean;
  /** The execution answering an open question, if the question is open. */
  responderOf(questionId: string): string | undefined;
  /** Exact current parent, only when the pinned delegate link opted in. */
  parentQuestionTarget?(nodeId: string): string | undefined;
  /** Versions this execution may read (its own, its inputs, its children's, …). */
  readable(): ReadonlySet<string>;
}

export interface StageViews {
  'model.request': ModelGateView;
  'model.admit': ModelGateView;
  'tool.pre_boundary': ToolGateView;
  'tool.authorize': ToolGateView;
  'tool.execute': ToolGateView;
}

export interface Gate<V> {
  id: string;
  version: number;
  check(view: V): GateDecision;
}

export type AdmissionGates = { [S in AdmissionStage]: readonly Gate<StageViews[S]>[] };

export type ObservedEvent = 'model.prepared' | 'model.finished' | 'tool.finished';

export interface ObserverView {
  projection: RunProjection;
  event: RunEvent;
}

/** Events an observer may commit, fenced by the Coordinator (CR-003). */
export type ObserverDraft = {
  type:
    | 'decision.requested'
    | 'decision.observed'
    | 'decision.failed'
    | 'limit.reached'
    | 'effect.admitted'
    | 'effect.settled';
  executionId?: string;
  payload: Record<string, unknown>;
};

/**
 * What the Coordinator lends an observer. Writes go through `record`, which refuses anything
 * but decision facts and commits nothing once the run has ended.
 */
export interface ObserverContext {
  runId: string;
  /** Commits the drafts if the run is still open; false when they were dropped. */
  record(drafts: ObserverDraft[]): boolean;
  isOpen(): boolean;
  /** Calls `fn` when the execution's cancel is requested (or already was). */
  onCancel(executionId: string, fn: () => void): () => void;
  after(ms: number, fn: () => void): () => void;
  monotonicMs(): number;
  nextId(): string;
  nextEffectId(): string;
  /** The run's status as committed right now. */
  status(): string;
}

export interface AdmissionObserver {
  id: string;
  version: number;
  on: ObservedEvent;
  handle(view: ObserverView, context: ObserverContext): void | Promise<void>;
}

export interface AdmissionConfig {
  /** Replaces the default gates of the stages it names. */
  gates?: Partial<AdmissionGates>;
  observers?: readonly AdmissionObserver[];
}

const OBSERVED: Record<string, ObservedEvent> = {
  'model.request_prepared': 'model.prepared',
  'model.finished': 'model.finished',
  'tool.finished': 'tool.finished',
};

/** A deep read-only view: reads pass through, every write throws. */
function readOnly<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value !== 'object' || value === null) return value;
  const cached = seen.get(value);
  if (cached) return cached as T;
  const refuse = () => {
    throw new TypeError('admission views are read-only');
  };
  // Committed facts are frozen, and a Proxy may not hand out a different object for a frozen
  // property of its target. The proxy therefore wraps an empty shadow of the same kind and
  // reads through to the real value, so nested values can be wrapped too.
  const real = value as object;
  const shadow: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(real));
  const proxy = new Proxy(shadow, {
    get: (_shadow, key) => readOnly(Reflect.get(real, key), seen),
    has: (_shadow, key) => Reflect.has(real, key),
    ownKeys: () => Reflect.ownKeys(real),
    getOwnPropertyDescriptor: (_shadow, key) => {
      const found = Reflect.getOwnPropertyDescriptor(real, key);
      if (!found) return undefined;
      // Report what the shadow can honour: only its own fixed keys (an array's length) stay
      // non-configurable.
      const fixed = Reflect.getOwnPropertyDescriptor(shadow, key);
      const configurable = fixed ? fixed.configurable : true;
      return 'value' in found
        ? { ...found, value: readOnly(found.value, seen), configurable }
        : { ...found, configurable };
    },
    getPrototypeOf: () => Object.getPrototypeOf(real),
    set: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
    setPrototypeOf: refuse,
    preventExtensions: refuse,
  });
  seen.set(value, proxy);
  return proxy as T;
}

/** Runs one stage. Returns the first non-allow decision, or allow. */
export function runGates<V>(gates: readonly Gate<V>[], view: V): GateDecision {
  if (gates.length === 0) return { kind: 'allow' };
  const shown = readOnly(view);
  for (const gate of gates) {
    let decision: GateDecision;
    try {
      decision = gate.check(shown);
    } catch {
      // Fail closed: a broken check never lets a call through.
      return {
        kind: 'refuse',
        code: 'POLICY_ERROR',
        message: `policy check ${gate.id}@${gate.version} failed`,
      };
    }
    if (decision.kind !== 'allow') return decision;
  }
  return { kind: 'allow' };
}

/** Hands committed events to the observers that asked for them, after the commit. */
export function notifyObservers(
  observers: readonly AdmissionObserver[],
  projection: RunProjection,
  events: readonly RunEvent[],
  context: () => ObserverContext,
): void {
  if (observers.length === 0) return;
  for (const event of events) {
    const on = OBSERVED[event.type];
    if (!on) continue;
    for (const observer of observers) {
      if (observer.on !== on) continue;
      const view = readOnly({ projection, event });
      void Promise.resolve()
        .then(() => observer.handle(view, context()))
        .catch(() => {
          // An observer's failure is its own; the run does not depend on it.
        });
    }
  }
}

// ── default gates: today's checks, unchanged ────────────────────────────────

const noProgress: Gate<ModelGateView> = {
  id: 'no_progress',
  version: 1,
  check: ({ projection }) =>
    noProgressReached(projection.progress)
      ? {
          kind: 'require_approval',
          approval: 'user_action',
          limit: { kind: 'no_progress', used: projection.progress.turns, max: NO_PROGRESS_TURNS },
        }
      : { kind: 'allow' },
};

const budget: Gate<ModelGateView> = {
  id: 'budget',
  version: 1,
  check: ({ projection, limits }) => {
    const admitted = admitModelRequest(projection.budget, limits);
    return admitted.ok
      ? { kind: 'allow' }
      : {
          kind: 'refuse',
          code: 'LIMIT_REACHED',
          message: `LIMIT_REACHED: ${admitted.limitKind}`,
          limit: {
            kind: admitted.limitKind,
            used: admitted.used,
            reserved: admitted.reserved,
            max: admitted.max,
          },
        };
  },
};

/** A reply to a question that has already closed (Technical-Design §8.3). */
const questionOpen: Gate<ToolGateView> = {
  id: 'question_open',
  version: 1,
  check: ({ proposal, projection }) => {
    const questionId = proposal.name === 'reply' ? proposal.args.questionId : null;
    return typeof questionId === 'string' &&
      projection.questions[questionId] &&
      projection.questions[questionId]?.status !== 'open'
      ? { kind: 'refuse', code: 'TARGET_TERMINAL', message: 'the question has closed' }
      : { kind: 'allow' };
  },
};

type Refusal = Extract<GateDecision, { kind: 'refuse' }>;
const refuse = (code: ErrorCode, message: string, limit?: LimitHit): Refusal =>
  limit ? { kind: 'refuse', code, message, limit } : { kind: 'refuse', code, message };
const denied = (message: string) => refuse('CAPABILITY_DENIED', message);

/**
 * Which tools a role may use and whether the call is well formed and in scope (CRL-SEC-001,
 * CRL-COL-002/003). Unknown tools, shell or code tools included, are refused: role allowlists
 * name only Corral tools.
 */
const roleAllowlist: Gate<ToolGateView> = {
  id: 'role_allowlist',
  version: 1,
  check: (view) => {
    const { input, proposal, projection: p, callables } = view;
    const { args } = proposal;
    const collaboration = input.role.allowedCollaborationTools as readonly string[];
    const allow: GateDecision = { kind: 'allow' };
    if (
      (proposal.name === 'spawn_subagents' && args.mode === 'items') ||
      (input.item && ['spawn_subagents', 'ask'].includes(proposal.name))
    ) {
      const ancestors = new Set<string>([input.executionId]);
      let parent = p.executions[input.executionId]?.parentExecutionId;
      while (parent) {
        ancestors.add(parent);
        parent = p.executions[parent]?.parentExecutionId;
      }
      if (
        Object.values(p.executions).some(
          (e) => !TERMINAL_EXECUTION_STATUSES.has(e.status) && !ancestors.has(e.executionId),
        )
      )
        return denied('item delegation requires all other executions to settle');
      if (
        Object.values(p.effects).some(
          (e) =>
            e.kind === 'tool' &&
            e.scope === input.executionId &&
            e.status === 'admitted' &&
            e.effectId !== view.currentEffectId,
        )
      )
        return denied('item delegation requires pending tools to settle');
    }
    if (
      view.simulation &&
      ![
        'write_artifact',
        'submit_result',
        'spawn_subagents',
        'await_tasks',
        'ask',
        'reply',
        'read_artifact',
        'ask_user',
        'update_plan',
      ].includes(proposal.name)
    )
      return denied('this tool needs an actual harness execution');
    if (input.harness && !view.descriptor && !view.simulation)
      return denied('tool is absent from the loaded harness');
    if (input.harness && !input.harness.allowedTools.includes(proposal.name))
      return denied('tool is not allowed by this harness');
    if (view.descriptor?.source.startsWith('extension:')) {
      return input.harness?.policy === 'trusted-native' &&
        input.harness.allowedTools.includes(proposal.name)
        ? allow
        : denied('native tool is not allowed by this harness');
    }
    if (proposal.name === 'run_command') {
      if (
        !view.fileTools ||
        input.harness?.policy !== 'trusted-native' ||
        !input.role.allowedWorkTools.includes('run_command') ||
        input.taskBrief?.taskScope === 'review_only'
      )
        return denied('role may not launch trusted worktree commands');
      return RunCommandArgs.safeParse(args).success
        ? allow
        : refuse('SCHEMA_INVALID', 'invalid worktree command');
    }
    if (['preview_file', 'preview_app', 'preview_action'].includes(proposal.name)) {
      if (
        !input.role.allowedWorkTools.some((tool) => tool === proposal.name) ||
        !view.fileTools ||
        (proposal.name === 'preview_file' && !input.role.allowedWorkTools.includes('read_file')) ||
        (proposal.name !== 'preview_file' &&
          (input.harness?.policy !== 'trusted-native' ||
            input.taskBrief?.taskScope === 'review_only'))
      )
        return denied('role may not use this workspace preview capability');
      const schema =
        proposal.name === 'preview_file'
          ? PreviewFileArgs
          : proposal.name === 'preview_app'
            ? PreviewAppArgs
            : PreviewActionArgs;
      return schema.safeParse(args).success
        ? allow
        : refuse('SCHEMA_INVALID', 'invalid owned preview request');
    }
    if (proposal.name === 'generate_image') {
      if (
        !input.role.allowedWorkTools.includes('generate_image') ||
        !input.role.imageProfile ||
        input.taskBrief?.taskScope === 'review_only'
      )
        return denied('role may not generate images');
      const parsed = GenerateImageArgs.safeParse(args);
      return parsed.success && parsed.data.profileId === input.role.imageProfile
        ? allow
        : refuse('SCHEMA_INVALID', 'image tool requires the role image profile');
    }
    if (proposal.name === 'read_hashline' || proposal.name === 'edit_hashline') {
      if (
        input.role.editingMode !== 'hashline' ||
        !view.fileTools ||
        !input.role.allowedWorkTools.includes('read_file')
      )
        return denied('role may not use Hashline');
      if (proposal.name === 'read_hashline')
        return Object.keys(args).every((key) => ['path', 'offset', 'limit'].includes(key)) &&
          [args.offset, args.limit].every(
            (value) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= 1),
          ) &&
          ResourcePath.safeParse(args.path).success &&
          !String(args.path).startsWith('skills/')
          ? allow
          : refuse('SCHEMA_INVALID', 'invalid Hashline read');
      const parsed = HashlineEditInput.safeParse(args);
      if (!parsed.success) return refuse('SCHEMA_INVALID', 'invalid Hashline edit');
      if (
        !input.role.allowedWorkTools.includes('write_file') ||
        parsed.data.path.startsWith('skills/') ||
        (/^\s*REM\b/m.test(parsed.data.ops) &&
          !input.role.allowedWorkTools.includes('delete_file')) ||
        (/^\s*MV\b/m.test(parsed.data.ops) && !input.role.allowedWorkTools.includes('move_file'))
      )
        return denied('role may not perform this Hashline change');
      return allow;
    }
    if (proposal.name === 'run_check') {
      if (!input.harness?.projectTools || !view.fileTools)
        return denied('no selected project checks');
      if (Object.keys(args).length !== 1 || typeof args.commandId !== 'string')
        return refuse('SCHEMA_INVALID', 'run_check accepts only a registered commandId');
      return input.harness.projectTools.checkIds.includes(args.commandId)
        ? allow
        : denied('check is not selected by this role');
    }
    if (proposal.name === 'lsp_query') {
      if (
        !input.harness?.projectTools ||
        !view.fileTools ||
        !input.role.allowedWorkTools.includes('read_file')
      )
        return denied('role may not query worktree language servers');
      const query = LspQuery.safeParse(args);
      if (!query.success) return refuse('SCHEMA_INVALID', 'invalid language server query');
      if (query.data.path.startsWith('skills/'))
        return denied('language servers cannot read skill resources');
      return input.harness.projectTools.lspServerIds.includes(query.data.serverId)
        ? allow
        : denied('language server is not selected by this role');
    }
    if (proposal.name === 'edit' || proposal.name === 'write') {
      if (
        input.role.editingMode === 'hashline' ||
        !input.harness ||
        !view.fileTools ||
        !input.role.allowedWorkTools.includes('write_file') ||
        (proposal.name === 'edit' && !input.role.allowedWorkTools.includes('read_file'))
      )
        return denied('role may not modify the worktree');
      const parsed = (proposal.name === 'edit' ? PiEditInput : PiWriteInput).safeParse(args);
      if (!parsed.success) return refuse('SCHEMA_INVALID', 'invalid coding tool arguments');
      if (parsed.data.path.startsWith('skills/')) return denied('skill resources are read only');
      return allow;
    }
    if (proposal.name === 'read') {
      if (
        !input.harness ||
        typeof args.path !== 'string' ||
        !ResourcePath.safeParse(args.path).success ||
        Object.keys(args).some((key) => !['path', 'offset', 'limit'].includes(key)) ||
        [args.offset, args.limit].some(
          (value) => value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1),
        )
      )
        return refuse('SCHEMA_INVALID', 'invalid read arguments');
      const path = args.path;
      if (path.startsWith('skills/'))
        return view.harnessRead &&
          input.harness.resources.some(
            (resource) => resource.kind === 'skill' && resource.skillName === path.split('/')[1],
          )
          ? allow
          : denied('skill is not bound to this role');
      return view.fileTools && input.role.allowedWorkTools.includes('read_file')
        ? allow
        : denied('role may not read the worktree');
    }
    if (['search', 'read_document'].includes(proposal.name)) {
      if (
        !(input.role.allowedWorkTools as readonly string[]).includes(proposal.name) ||
        !view.externalTools
      )
        return denied(`role may not use ${proposal.name}`);
      const keys = Object.keys(args);
      if (proposal.name === 'search')
        return typeof args.query === 'string' &&
          args.query.trim().length > 0 &&
          args.query.length <= 500 &&
          keys.every((k) => ['query', 'provider', 'limit'].includes(k)) &&
          (args.provider === undefined ||
            args.provider === 'corpus' ||
            args.provider === 'brave') &&
          (args.limit === undefined ||
            (Number.isInteger(args.limit) && Number(args.limit) >= 1 && Number(args.limit) <= 10))
          ? allow
          : refuse('SCHEMA_INVALID', 'invalid search arguments');
      return keys.length === 1 &&
        ['documentId', 'sourceId'].includes(keys[0] ?? '') &&
        typeof args[keys[0] ?? ''] === 'string' &&
        String(args[keys[0] ?? '']).length > 0
        ? allow
        : refuse('SCHEMA_INVALID', 'read_document requires one documentId or sourceId');
    }
    if ((FILE_TOOLS as readonly string[]).includes(proposal.name)) {
      if (
        !(input.role.allowedWorkTools as readonly string[]).includes(proposal.name) ||
        !view.fileTools
      )
        return denied(`role may not use ${proposal.name} here`);
      return fileArgsValid(proposal.name, args)
        ? allow
        : refuse('SCHEMA_INVALID', `invalid ${proposal.name} arguments`);
    }
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
    switch (proposal.name) {
      case 'update_plan':
        return WorkPlanUpdate.safeParse(args).success
          ? allow
          : refuse('SCHEMA_INVALID', 'invalid work plan');
      case 'ask_user':
        return UserInputRequest.safeParse(args).success
          ? allow
          : refuse('SCHEMA_INVALID', 'invalid user questions');
      case 'write_artifact':
        if (!input.role.allowedWorkTools.includes('write_artifact')) {
          return denied('role may not write artifacts');
        }
        return typeof args.text === 'string'
          ? allow
          : refuse('SCHEMA_INVALID', 'text must be a string');
      case 'submit_result': {
        if (!input.role.allowedCollaborationTools.includes('submit_result')) {
          return denied('role may not submit results');
        }
        if (view.pendingChildContinuation)
          return denied(
            'answer pending child questions and finish the interrupted child wait before submitting',
          );
        const ids = args.artifactVersionIds;
        const owned =
          Array.isArray(ids) &&
          ids.length > 0 &&
          ids.every(
            (id) =>
              typeof id === 'string' && p.artifacts[id]?.authorExecutionId === input.executionId,
          );
        return owned ? allow : denied('only versions written by this execution can be submitted');
      }
      case 'spawn_subagents': {
        const tasks = args.tasks;
        if (args.mode !== undefined && args.mode !== 'items')
          return refuse('SCHEMA_INVALID', 'unknown delegation mode');
        if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 4) {
          return refuse('SCHEMA_INVALID', 'tasks must list 1 to 4 tasks');
        }
        if (args.mode === 'items' && input.item)
          return denied('nested item batches are not allowed');
        if (args.mode === 'items' || input.item) {
          if (input.item && tasks.length !== 1)
            return denied('item descendants must run one at a time');
        }
        for (const task of tasks as { targetNodeId?: unknown; brief?: unknown }[]) {
          if (typeof task?.brief !== 'string' || !task.brief.trim() || task.brief.length > 4000) {
            return refuse('SCHEMA_INVALID', 'each task needs a brief of 1 to 4000 characters');
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
        return allow;
      }
      case 'await_tasks': {
        if (
          Array.isArray(args.taskIds) &&
          !Object.values(p.questions).some(
            (q) =>
              q.status === 'open' &&
              q.delivery === 'parent' &&
              q.targetExecutionId === input.executionId,
          ) &&
          createsWaitCycle(
            p,
            input.executionId,
            args.taskIds.flatMap((id) => {
              const active = typeof id === 'string' ? p.tasks[id]?.activeExecutionId : null;
              return active ? [active] : [];
            }),
          )
        )
          return denied('waiting would create a cycle');
        const ids = args.taskIds;
        if (!Array.isArray(ids) || ids.length === 0) {
          return refuse('SCHEMA_INVALID', 'taskIds must list the tasks to wait for');
        }
        const mine = new Set(
          Object.values(p.executions)
            .filter((e) => e.parentExecutionId === input.executionId)
            .map((e) => e.taskId),
        );
        return ids.every((id) => typeof id === 'string' && mine.has(id))
          ? allow
          : denied('only tasks this execution started can be awaited');
      }
      case 'ask':
        if (typeof args.body !== 'string' || !args.body.trim() || args.body.length > 12000) {
          return refuse('SCHEMA_INVALID', 'body must be 1 to 12000 characters');
        }
        if (
          input.capabilities.askTo.some(
            (target) => target.delivery === 'parent' && target.nodeId === args.targetNodeId,
          ) &&
          !view.parentQuestionTarget?.(String(args.targetNodeId))
        )
          return refuse('TARGET_TERMINAL', 'the parent question owner is no longer current');
        if (
          typeof args.targetNodeId !== 'string' ||
          (!view.parentQuestionTarget?.(args.targetNodeId) &&
            !callables.question.includes(args.targetNodeId))
        ) {
          return denied(
            `${input.nodeId} may not ask ${String(args.targetNodeId)}: no capability link`,
          );
        }
        if (
          Array.isArray(args.artifactRefs) &&
          args.artifactRefs.some((id) => typeof id !== 'string' || !view.readable().has(id))
        )
          return denied('question references must be readable by the asker');
        return allow;
      case 'reply': {
        const question = p.questions[String(args.questionId)];
        if (typeof args.body !== 'string' || !args.body.trim() || args.body.length > 12000) {
          return refuse('SCHEMA_INVALID', 'body must be 1 to 12000 characters');
        }
        const responder =
          typeof args.questionId === 'string' ? view.responderOf(args.questionId) : undefined;
        if (!question || responder !== input.executionId) {
          return question && question.status !== 'open'
            ? refuse(
                'TARGET_TERMINAL',
                `question ${question.questionId} is already ${question.status}`,
              )
            : denied('this execution was not asked that question');
        }
        if (
          Array.isArray(args.evidenceRefs) &&
          args.evidenceRefs.some((id) => typeof id !== 'string' || !view.readable().has(id))
        )
          return denied('answer evidence must be readable by the responder');
        return allow;
      }
      case 'read_artifact': {
        const id = args.artifactVersionId;
        if (typeof id !== 'string' || !p.artifacts[id]) {
          return refuse('TARGET_NOT_FOUND', 'no such artifact version');
        }
        return view.readable().has(id)
          ? allow
          : denied('this version is not in this execution’s scope');
      }
    }
    return denied(`unknown tool ${proposal.name}`);
  },
};

/** Run-wide and installation limits on what a call may start or write (Spec §9). */
const limits: Gate<ToolGateView> = {
  id: 'limits',
  version: 1,
  check: (view) => {
    const { input, proposal, projection: p, limits, policy, parentQuestionTarget } = view;
    const { args } = proposal;
    // Children and responders share one budget of dynamic executions (Spec §7.2).
    const capacity = (count: number): GateDecision => {
      const spawned = Object.values(p.executions).filter(
        (e) => e.parentExecutionId !== null,
      ).length;
      const live = Object.values(p.executions).filter(
        (e) => !TERMINAL_EXECUTION_STATUSES.has(e.status),
      ).length;
      if (input.depth + 1 > limits.maxDelegationDepth) {
        return refuse(
          'LIMIT_REACHED',
          `delegation depth is limited to ${limits.maxDelegationDepth}`,
          { kind: 'depth', used: input.depth, max: limits.maxDelegationDepth },
        );
      }
      if (spawned + (view.reservedSpawns ?? 0) + count > limits.maxSpawns) {
        return refuse(
          'LIMIT_REACHED',
          `this run may start ${limits.maxSpawns} delegated or responding executions`,
          { kind: 'spawns', used: spawned, max: limits.maxSpawns },
        );
      }
      // Reserve resident capacity for the whole batch, or none of it (Technical-Design §8.1).
      if (
        live + (proposal.name === 'spawn_subagents' && args.mode === 'items' ? 1 : count) >
        policy.maxResidentExecutions
      ) {
        return refuse(
          'RESOURCE_CAPACITY',
          `at most ${policy.maxResidentExecutions} executions may be alive at once`,
        );
      }
      return { kind: 'allow' };
    };
    switch (proposal.name) {
      case 'write_artifact':
        return typeof args.text === 'string' &&
          utf8ToBytes(args.text).length > policy.maxArtifactBytes
          ? refuse(
              'LIMIT_REACHED',
              `artifact versions are limited to ${policy.maxArtifactBytes} bytes`,
            )
          : { kind: 'allow' };
      case 'spawn_subagents':
        return capacity(Array.isArray(args.tasks) ? args.tasks.length : 0);
      case 'ask': {
        const asked = Object.keys(p.questions).length;
        if (asked >= limits.maxQuestions) {
          return refuse('LIMIT_REACHED', `this run may ask ${limits.maxQuestions} questions`, {
            kind: 'questions',
            used: asked,
            max: limits.maxQuestions,
          });
        }
        return typeof args.targetNodeId === 'string' && parentQuestionTarget?.(args.targetNodeId)
          ? { kind: 'allow' }
          : capacity(1);
      }
    }
    return { kind: 'allow' };
  },
};

/** Today's checks as gates, in today's order. */
export const DEFAULT_GATES: AdmissionGates = {
  'model.request': [noProgress],
  'model.admit': [budget],
  'tool.pre_boundary': [questionOpen],
  'tool.authorize': [roleAllowlist, limits],
  'tool.execute': [roleAllowlist, limits],
};

export function resolveGates(config: AdmissionConfig | undefined): AdmissionGates {
  return { ...DEFAULT_GATES, ...(config?.gates ?? {}) };
}

const MAX_FILE_TEXT = 1024 * 1024;
const isPath = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 500;

/** Shapes of file tool arguments (CR-012); the backend checks the paths themselves. */
function fileArgsValid(name: string, args: Record<string, unknown>): boolean {
  const keys = Object.keys(args);
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  switch (name) {
    case 'list_files':
      return only('path') && (args.path === undefined || args.path === '' || isPath(args.path));
    case 'read_file':
    case 'delete_file':
      return only('path') && isPath(args.path);
    case 'write_file':
      return (
        only('path', 'text') &&
        isPath(args.path) &&
        typeof args.text === 'string' &&
        args.text.length <= MAX_FILE_TEXT
      );
    case 'move_file':
      return only('from', 'to') && isPath(args.from) && isPath(args.to);
    default:
      return false;
  }
}
