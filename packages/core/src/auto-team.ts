import {
  type AgentRole,
  AUTO_REASON_MAX,
  AUTO_ROUTE_LEVELS,
  AUTO_TEMPLATE_VERSION,
  type AutoModelChoice,
  type AutoRoute,
  type AutoRouteLevel,
  AutoTemplate,
  type CommandError,
  type ConversationSource,
  type CorralDefinition,
  FILE_TOOLS,
  type HarnessBindingRef,
  type ModelProfileSnapshot,
  type PermissionMode,
  type ReasoningLevel,
  type RunInput,
  type RunReference,
  type StartFrom,
  type StartRunRequest,
  type TeamPlan,
  type TeamSlot,
  type WorkTool,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { canonicalJson } from './canonical-json.ts';
import type { StartRunResult } from './coordinator.ts';
import type { CorralRecord } from './repository/index.ts';
import { draftFromPlan, planFromGoal, type TeamWording } from './team-draft.ts';

// a session without a chosen team runs in auto mode. A start model picks one of the
// built-in templates (the team patterns); the template fixes roles, tools, wiring and
// limits, and every role uses the session's model and reasoning. The choice is recorded with
// the run it starts, never the model's answer itself.

const WORDING: TeamWording = {
  roles: {
    worker: {
      name: 'Assistant',
      duty: 'Do what the request asks, directly and completely. State routine assumptions; use ask_user when a missing decision would materially change the work.',
    },
    planner: {
      name: 'Planner',
      duty: 'Outline what the result must contain and how it will be checked.',
    },
    researcher: {
      name: 'Researcher',
      duty: 'Collect the facts and sources the request needs, noting where each one came from.',
    },
    writer: {
      name: 'Writer',
      duty: 'Write the result from the request and the notes, and revise it from the review.',
    },
    reviewer: {
      name: 'Reviewer',
      duty: 'Check the draft against the request and the criteria; pass it or say exactly what to revise.',
    },
  },
  criteria: {
    direct: 'Do what the request asks.',
    sources: 'Name the sources or evidence used.',
  },
  labels: { loop: 'Review loop', decision: 'Review decision', output: 'Output' },
};

const SLOTS: Record<AutoTemplate, TeamSlot[]> = {
  single: ['worker'],
  write_review: ['planner', 'writer', 'reviewer'],
  research_write_review: ['researcher', 'writer', 'reviewer'],
};
const NAMES: Record<AutoTemplate, string> = {
  single: 'Auto · single agent',
  write_review: 'Auto · write and review',
  research_write_review: 'Auto · research, write and review',
};
/** Roles that write the result; the others only read the working copy. */
const WRITERS = new Set<TeamSlot>(['worker', 'writer']);
const READ_TOOLS: WorkTool[] = ['list_files', 'read_file'];
const FILE_NOTE =
  ' The session has a working copy: read files with the file tools before relying on them.';
const WRITE_NOTE = ' Make the changes the request asks for with the file tools.';

export interface AutoDefinitionInput {
  harness?: HarnessBindingRef;
  commandTools?: boolean;
  taskScope?: RunInput['taskScope'];
  verificationScope?: RunInput['verificationScope'];
  id: string;
  template: AutoTemplate;
  brief: string;
  criteria?: string[];
  choice: AutoModelChoice;
  /** The session has a working copy, so the roles get file tools. */
  fileTools: boolean;
  /** With `route` reasoning: the level the start model picked; medium when absent. */
  routeLevel?: AutoRouteLevel;
}

export function autoDefinition(input: AutoDefinitionInput): CorralDefinition {
  const template = AutoTemplate.parse(input.template);
  const plan: TeamPlan = {
    name: NAMES[template],
    pattern: template,
    brief: input.brief,
    criteria:
      input.criteria ??
      (template === 'single'
        ? [WORDING.criteria.direct]
        : [WORDING.criteria.direct, WORDING.criteria.sources]),
    roles: SLOTS[template].map((slot) => ({ slot, ...WORDING.roles[slot] })),
    ...(template === 'single' ? {} : { reviewRounds: 2 }),
    // Nobody designed this team, so its result does not wait for an approval.
    finalApproval: false,
  };
  const { definition } = draftFromPlan(plan, input.id, WORDING.labels);
  // Roles always get a reasoning policy: `route` becomes the level picked for this request.
  const asked = input.choice.reasoning;
  const reasoning =
    asked?.mode === 'route'
      ? { mode: 'fixed' as const, level: input.routeLevel ?? ('medium' as const) }
      : asked;
  const roles = definition.roles.map((role) => {
    const writes = WRITERS.has(role.id as TeamSlot) && input.taskScope !== 'review_only';
    const tools: WorkTool[] = input.fileTools
      ? [
          'write_artifact',
          ...(writes ? FILE_TOOLS : READ_TOOLS),
          ...(input.commandTools ? ['preview_file' as const] : []),
          ...(writes && input.commandTools
            ? ['run_command' as const, 'preview_app' as const, 'preview_action' as const]
            : []),
        ]
      : ['write_artifact'];
    return {
      ...role,
      prompt: input.fileTools
        ? `${role.prompt}${FILE_NOTE}${writes ? WRITE_NOTE : ''}`
        : role.prompt,
      modelProfile: input.choice.modelProfile,
      ...(input.harness ? { harness: { ...input.harness } } : {}),
      ...(reasoning ? { reasoning } : {}),
      allowedWorkTools: tools,
      allowedCollaborationTools: [
        ...role.allowedCollaborationTools,
        'ask_user' as const,
        'update_plan' as const,
      ],
    };
  });
  const nodes = definition.nodes.map((node) =>
    node.type === 'agent' && node.roleId === 'reviewer'
      ? {
          ...node,
          inputBindings: [...node.inputBindings, { kind: 'run_input' as const, name: 'brief' }],
        }
      : node,
  );
  return {
    ...definition,
    input: {
      ...definition.input,
      ...(input.taskScope ? { taskScope: input.taskScope } : {}),
      ...(input.verificationScope ? { verificationScope: input.verificationScope } : {}),
    },
    roles,
    nodes,
    ...(roles.some((role) => role.id === 'planner') ? { planOwnerRoleId: 'planner' } : {}),
  };
}

/** The conversation lead's duty; file and command notes follow it as for auto roles. */
const LEAD_DUTY =
  "You are the assistant in this conversation. Answer the person's latest message directly and completely, using the earlier messages as context. Use tools only when the request needs them. Delegate to subagents only when the person explicitly asks for subagents, parallel agents or a team; then give each a self-contained task, read their results and answer yourself. State routine assumptions; use ask_user when a missing decision would materially change the work.";
const HELPER_PROMPT =
  'You are a subagent. Do the delegated task given below completely and reply with your findings. You do not see the conversation; rely only on the task text and your tools.';

/** delegates the lead may call; `guidance` describes how a saved team worked. */
export interface ConversationRoster {
  roles: AgentRole[];
  guidance?: string;
}

/**
 * session chat is one lead agent that answers with its final reply. It keeps the auto
 * single role's tools, model, harness and reasoning, minus the output tools. Without a roster
 * it may call a helper on explicit request; with one, it leads that team by itself.
 */
export function conversationDefinition(
  input: Omit<AutoDefinitionInput, 'template'> & {
    roster?: ConversationRoster;
  },
): CorralDefinition {
  const { roster, ...rest } = input;
  const base = autoDefinition({ ...rest, template: 'single' });
  const duty = roster ? leadTeamDuty(roster) : LEAD_DUTY;
  const roles = base.roles.map((role) => ({
    ...role,
    name: 'Assistant',
    prompt: role.prompt.replace(WORDING.roles.worker.duty, duty),
    answer: 'final_reply' as const,
    outputContract: 'text' as const,
    allowedWorkTools: role.allowedWorkTools.filter((tool) => tool !== 'write_artifact'),
    allowedCollaborationTools: [
      ...role.allowedCollaborationTools.filter((tool) => tool !== 'submit_result'),
      'spawn_subagents' as const,
      'await_tasks' as const,
    ],
  }));
  const lead = roles[0];
  const leadNode = base.nodes.find((node) => node.type === 'agent');
  if (!lead || !leadNode) return { ...base, name: 'Conversation', roles };
  // Without a team, one helper with the lead's model and tools and a fresh context.
  const delegates = roster?.roles ?? [
    {
      ...lead,
      id: 'helper',
      name: 'Helper',
      prompt: lead.prompt.replace(duty, HELPER_PROMPT),
      allowedCollaborationTools: [],
    },
  ];
  return {
    ...base,
    name: 'Conversation',
    roles: [...roles, ...delegates],
    nodes: [
      ...base.nodes,
      ...delegates.map((role) => ({
        id: role.id,
        type: 'agent' as const,
        label: role.name,
        roleId: role.id,
        invocation: 'callable' as const,
        inputBindings: [],
        outputName: 'notes',
      })),
    ],
    capabilityLinks: [
      ...base.capabilityLinks,
      ...delegates.map((role) => ({
        id: `lead_${role.id}`,
        kind: 'delegate' as const,
        sourceNodeId: leadNode.id,
        targetNodeId: role.id,
      })),
    ],
  };
}

function leadTeamDuty(roster: ConversationRoster): string {
  const members = roster.roles.map((role) => `${role.name} (${role.id})`).join(', ');
  return [
    "You lead a team in this conversation. Answer the person's latest message, using the earlier messages as context.",
    `Your team: ${members}. When the work benefits, give them self-contained tasks with spawn_subagents, wait with await_tasks, read their results and write the answer yourself. Answer simple messages directly.`,
    ...(roster.guidance
      ? [`The team was designed to work like this; use it as guidance: ${roster.guidance}`]
      : []),
    'State routine assumptions; use ask_user when a missing decision would materially change the work.',
  ].join(' ');
}

/** A delegate's copy of a role: it answers with its reply and publishes nothing itself. */
function delegateRole(role: AgentRole, id: string, prompt = role.prompt): AgentRole {
  return {
    ...role,
    id,
    prompt,
    answer: 'final_reply',
    outputContract: 'text',
    allowedWorkTools: role.allowedWorkTools.filter((tool) => tool !== 'write_artifact'),
    allowedCollaborationTools: role.allowedCollaborationTools.filter(
      (tool) => !['submit_result', 'spawn_subagents', 'await_tasks', 'reply'].includes(tool),
    ),
  };
}

/** auto: the auto team's roles as delegates, with the session's model and tools. */
export function autoRoster(input: Omit<AutoDefinitionInput, 'template'>): ConversationRoster {
  const team = autoDefinition({ ...input, template: 'research_write_review' });
  const planner = autoDefinition({ ...input, template: 'write_review' }).roles.find(
    (role) => role.id === 'planner',
  );
  const order = ['planner', 'researcher', 'writer', 'reviewer'];
  const roles = [...(planner ? [planner] : []), ...team.roles]
    .filter((role, index, all) => all.findIndex((other) => other.id === role.id) === index)
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return { roles: roles.map((role) => delegateRole(role, `team_${role.id}`)) };
}

/** Corral: a saved Corral's roles as delegates; its graph becomes guidance. */
export function corralRoster(corral: CorralDefinition): ConversationRoster {
  const label = (id: string) => corral.nodes.find((node) => node.id === id)?.label ?? id;
  const flow = corral.controlEdges
    .map((edge) => `${label(edge.source)} → ${label(edge.target)}`)
    .join('; ');
  return {
    roles: corral.roles.map((role) => delegateRole(role, `team_${role.id}`)),
    ...(flow ? { guidance: `${corral.name}: ${flow}.` } : {}),
  };
}

export const AUTO_ROUTE_MAX_RESPONSE_BYTES = 4096;
export const AUTO_ROUTE_TIMEOUT_MS = 30_000;

/** The choice request's instructions; with levels, the model also picks the reasoning. */
export function autoRouterPrompt(levels?: readonly AutoRouteLevel[]): string {
  const shape = levels
    ? '{"template": "<id>", "reasoning": "<level>", "reason": "<one short sentence>"}'
    : '{"template": "<id>", "reason": "<one short sentence>"}';
  return [
    `You choose how a request to a team of AI agents is handled. Answer with one JSON object and nothing else: ${shape}.`,
    'Templates:',
    '- single: one agent answers or does the work directly. Questions, explanations, small edits and short tasks.',
    '- write_review: a planner outlines, a writer drafts, a reviewer checks and asks for revisions. Documents or changes that need a careful check.',
    '- research_write_review: a researcher collects facts and sources, then a writer drafts and a reviewer checks. Comparisons, investigations and anything that needs sources.',
    'Prefer single unless the request clearly needs a review or research.',
    ...(levels
      ? [
          `Reasoning is how hard every agent thinks, one of: ${levels.join(', ')}. Use low for simple questions and quick edits, medium for ordinary work, high only for hard analysis, design or tricky code.`,
        ]
      : []),
    "Write the reason in the request's language as a short phrase a person can scan at a glance.",
    `Return compact JSON, at most ${AUTO_ROUTE_MAX_RESPONSE_BYTES} UTF-8 bytes.`,
  ].join('\n');
}

export const AUTO_ROUTER_PROMPT = autoRouterPrompt();

const RouteAnswerText = z.strictObject({
  template: AutoTemplate,
  reason: z.string().trim().min(1).max(AUTO_REASON_MAX),
  reasoning: z.unknown().optional(),
});

/**
 * The start model's answer: one JSON object naming an allowed template, or null. With
 * `levels`, `reasoning` is the picked level when it is one of them, otherwise null.
 */
export function parseAutoRoute(
  text: string,
  levels?: readonly AutoRouteLevel[],
): { template: AutoTemplate; reason: string; reasoning?: AutoRouteLevel | null } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = RouteAnswerText.safeParse(value);
  if (!parsed.success) return null;
  const { template, reason, reasoning } = parsed.data;
  if (!levels) return { template, reason };
  const level = levels.find((l) => l === reasoning) ?? null;
  return { template, reason, reasoning: level };
}

/** The choice without a model (the demo, simulated runs): the local suggestion. */
export function localAutoRoute(brief: string): { template: AutoTemplate; reason: string } {
  const plan = planFromGoal(brief, WORDING);
  return { template: plan?.pattern ?? 'single', reason: '' };
}

export type RouteAnswer =
  | { ok: true; text: string; usage: { inputTokens: number; outputTokens: number } | null }
  | {
      ok: false;
      reason: 'timeout' | 'model_error' | 'output_limit';
      usage?: { inputTokens: number; outputTokens: number } | null;
    };

export interface AutoStart {
  harness?: HarnessBindingRef;
  permissionMode?: PermissionMode;
  taskScope?: RunInput['taskScope'];
  verificationScope?: RunInput['verificationScope'];
  commandId: string;
  sessionId?: string;
  brief: string;
  criteria?: string[];
  mode: 'mock' | 'live';
  choice: AutoModelChoice;
  startFrom?: StartFrom;
  /** the session's turns through this ended run. */
  conversation?: ConversationSource;
  /**
   * the conversation lead, alone (`none`), leading the auto roster (`auto`) or a saved
   * Corral's roles. No chooser request runs. Absent keeps the auto choice.
   */
  team?: 'none' | 'auto' | { corralId: string };
  references?: RunReference[];
}

export type AutoStartResult = StartRunResult & { autoRoute: AutoRoute | null };

/** The part of an AbortSignal the starter reads; core has no DOM or Node types. */
export interface AutoSignal {
  readonly aborted: boolean;
}

const cancelled = () => new Error('the auto request was cancelled before a run started');

export interface AutoStarterDeps<S extends AutoSignal = AutoSignal> {
  prepareModels?(
    request: AutoStart,
    /** every profile a roster uses; the request's own profiles when absent. */
    profiles?: readonly string[],
  ):
    | { ok: true; models: Record<string, ModelProfileSnapshot> }
    | { ok: false; error: CommandError };
  /** The Coordinator itself, or a transport to it (the in-browser runtime). */
  startRun(
    request: StartRunRequest,
    signal?: S,
    models?: Record<string, ModelProfileSnapshot>,
  ): StartRunResult | Promise<StartRunResult>;
  /** The earlier start after checking its original request identity; null if never recorded. */
  previousStart?(
    commandId: string,
    requestHash: string,
    request: AutoStart,
  ): AutoStartResult | null;
  /**
   * whether the session has a working copy for the conversation lead's file tools; the
   * start context's value when absent. No chooser runs, so the answer is read at start.
   */
  fileTools?(request: AutoStart): boolean | Promise<boolean>;
  /** a saved Corral whose roles the lead may call; null when it does not exist. */
  corral?(
    corralId: string,
  ):
    | Pick<CorralRecord, 'definition' | 'definitionRevision'>
    | null
    | Promise<Pick<CorralRecord, 'definition' | 'definitionRevision'> | null>;
  /**
   * the work style a session turn uses in a trusted folder when none was chosen, so
   * the lead can run commands and previews; null leaves the turn without one.
   */
  sessionHarness?(
    request: AutoStart,
  ): HarnessBindingRef | null | undefined | Promise<HarnessBindingRef | null | undefined>;
  /** A refusal before any choice is asked for (busy, model not connected); null to go on. */
  precheck?(request: AutoStart): StartRunResult | null;
  /** The reasoning levels the model supports; null or absent when unknown (simulated). */
  levels?(
    choice: AutoModelChoice,
    mode: 'mock' | 'live',
  ): readonly ReasoningLevel[] | null | undefined;
  /**
   * The start model. Null (or no function) means the local rule chooses and no model is
   * called, as for simulated runs.
   */
  route?(input: {
    commandId: string;
    sessionId?: string;
    models?: Record<string, ModelProfileSnapshot>;
    brief: string;
    choice: AutoModelChoice;
    mode: 'mock' | 'live';
    signal: S | undefined;
    /** With `route` reasoning: the levels the model may pick from. */
    levels?: readonly AutoRouteLevel[];
  }): Promise<RouteAnswer> | null;
}

export function createAutoStarter<S extends AutoSignal = AutoSignal>(deps: AutoStarterDeps<S>) {
  // One choice per command ID: a resend while choosing waits for that choice.
  const pending = new Map<string, { requestHash: string; result: Promise<AutoStartResult> }>();
  const conflict = (request: AutoStart, runId = 'none'): AutoStartResult => ({
    runId: null,
    autoRoute: null,
    receipt: {
      commandId: request.commandId,
      runId,
      status: 'rejected',
      acceptedSeq: null,
      target: `run:${runId}`,
      requestedBoundary: 'immediate',
      relatedEventIds: [],
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'the command was already used with a different payload',
      },
    },
  });

  const choose = async (
    request: AutoStart,
    signal: S | undefined,
    models?: Record<string, ModelProfileSnapshot>,
  ) => {
    // `route`: the model picks one of low, medium and high that this model supports.
    const routing = request.choice.reasoning?.mode === 'route';
    const supported = routing ? deps.levels?.(request.choice, request.mode) : null;
    const levels = routing
      ? AUTO_ROUTE_LEVELS.filter((level) => !supported || supported.includes(level))
      : undefined;
    const medium = (source: 'local' | 'fallback') =>
      routing ? { reasoningChoice: { level: 'medium' as const, source } } : {};
    const asked = deps.route?.({
      commandId: request.commandId,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(models ? { models } : {}),
      brief: request.brief,
      choice: request.choice,
      mode: request.mode,
      signal,
      ...(levels ? { levels } : {}),
    });
    if (!asked)
      return {
        ...localAutoRoute(request.brief),
        source: 'local' as const,
        usage: null,
        ...medium('local'),
      };
    const answer = await asked;
    if (signal?.aborted) throw cancelled();
    const usage = answer.usage ?? null;
    const picked = answer.ok ? parseAutoRoute(answer.text, levels) : null;
    if (picked) {
      const { reasoning: level, ...rest } = picked;
      return {
        ...rest,
        source: 'model' as const,
        usage,
        ...(level ? { reasoningChoice: { level, source: 'model' as const } } : medium('fallback')),
      };
    }
    return {
      template: 'single' as const,
      reason: '',
      source: 'fallback' as const,
      fallback: answer.ok ? ('invalid_answer' as const) : answer.reason,
      usage,
      ...medium('fallback'),
    };
  };

  const run = async (
    request: AutoStart,
    context: { fileTools: boolean; signal?: S },
    requestHash: string,
  ): Promise<AutoStartResult> => {
    const signal = context.signal;
    if (signal?.aborted) throw cancelled();
    const refused = deps.precheck?.(request);
    if (refused) return { ...refused, autoRoute: null };
    const prepared = deps.prepareModels?.(request);
    if (prepared && !prepared.ok)
      return {
        runId: null,
        autoRoute: null,
        receipt: { ...conflict(request).receipt, error: prepared.error },
      };
    const models = prepared?.models;
    if (request.team !== undefined) {
      const fileTools = (await deps.fileTools?.(request)) ?? context.fileTools;
      if (signal?.aborted) throw cancelled();
      // in a linked, trusted folder a live session works with commands and previews
      // by default. An explicit work style wins; otherwise the session's default is layered under
      // the person's and project's defaults, which may restrict it. Simulated agents get none:
      // a work style would only be simulated and would take their file tools away.
      const harness =
        request.harness ??
        (fileTools && request.mode === 'live'
          ? ((await deps.sessionHarness?.(request)) ?? undefined)
          : undefined);
      if (signal?.aborted) throw cancelled();
      const common = {
        id: `conversation_${(request.sessionId ?? request.commandId).replace(/^session_/, '')}`,
        brief: request.brief,
        ...(request.taskScope ? { taskScope: request.taskScope } : {}),
        ...(request.verificationScope ? { verificationScope: request.verificationScope } : {}),
        ...(request.criteria ? { criteria: request.criteria } : {}),
        choice: request.choice,
        ...(harness ? { harness, commandTools: true } : {}),
        fileTools,
      };
      let roster: ConversationRoster | undefined;
      let sourceTeam: CorralDefinition['sourceTeam'];
      if (request.team === 'auto') roster = autoRoster(common);
      else if (typeof request.team === 'object') {
        const corral = (await deps.corral?.(request.team.corralId)) ?? null;
        if (signal?.aborted) throw cancelled();
        // A deleted team is never silently replaced by another way of working.
        if (!corral)
          return {
            runId: null,
            autoRoute: null,
            receipt: {
              ...conflict(request).receipt,
              error: { code: 'TARGET_NOT_FOUND', message: 'the chosen Corral no longer exists' },
            },
          };
        roster = corralRoster(corral.definition);
        sourceTeam = {
          corralId: request.team.corralId,
          name: corral.definition.name,
          revision: corral.definitionRevision,
        };
        // A Corral role without its own work style works in the session's.
        if (harness)
          roster = {
            ...roster,
            roles: roster.roles.map((role) => (role.harness ? role : { ...role, harness })),
          };
      }
      const definition = conversationDefinition({ ...common, ...(roster ? { roster } : {}) });
      if (sourceTeam) definition.sourceTeam = sourceTeam;
      // A saved team's roles may use other models; each must be prepared before the start.
      const profiles = [...new Set(definition.roles.map((role) => role.modelProfile))];
      let teamModels = models;
      if (models && profiles.some((profile) => !models[profile])) {
        const again = deps.prepareModels?.(request, profiles);
        if (again && !again.ok)
          return {
            runId: null,
            autoRoute: null,
            receipt: { ...conflict(request).receipt, error: again.error },
          };
        teamModels = again?.models;
      }
      const result = await deps.startRun(
        {
          schemaVersion: '0.1',
          commandId: request.commandId,
          definition,
          mode: request.mode,
          autoRequestHash: requestHash,
          ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(request.startFrom ? { startFrom: request.startFrom } : {}),
          ...(request.conversation ? { conversation: request.conversation } : {}),
          ...(request.references?.length ? { references: request.references } : {}),
        },
        signal,
        teamModels,
      );
      return { ...result, autoRoute: null };
    }
    const chosen = await choose(request, signal, models);
    if (signal?.aborted) throw cancelled();
    const autoRoute: AutoRoute = {
      ...chosen,
      ...(request.harness ? { harness: { ...request.harness } } : {}),
      templateVersion: AUTO_TEMPLATE_VERSION,
      modelProfile: request.choice.modelProfile,
      ...(request.choice.reasoning ? { reasoning: request.choice.reasoning } : {}),
      inputHash: bytesToHex(sha256(utf8ToBytes(request.brief))),
      requestHash,
    };
    const definition = autoDefinition({
      id: `auto_${(request.sessionId ?? request.commandId).replace(/^session_/, '')}`,
      template: autoRoute.template,
      brief: request.brief,
      ...(request.taskScope ? { taskScope: request.taskScope } : {}),
      ...(request.verificationScope ? { verificationScope: request.verificationScope } : {}),
      ...(request.criteria ? { criteria: request.criteria } : {}),
      choice: request.choice,
      ...(request.harness ? { harness: request.harness } : {}),
      fileTools: context.fileTools,
      ...(request.harness ? { commandTools: true } : {}),
      ...(autoRoute.reasoningChoice ? { routeLevel: autoRoute.reasoningChoice.level } : {}),
    });
    const result = await deps.startRun(
      {
        schemaVersion: '0.1',
        commandId: request.commandId,
        definition,
        mode: request.mode,
        ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.startFrom ? { startFrom: request.startFrom } : {}),
        ...(request.conversation ? { conversation: request.conversation } : {}),
        ...(request.references?.length ? { references: request.references } : {}),
        autoRoute,
      },
      signal,
      models,
    );
    return { ...result, autoRoute: result.runId ? autoRoute : null };
  };

  return {
    start(
      request: AutoStart,
      context: { fileTools: boolean; signal?: S },
    ): Promise<AutoStartResult> {
      const requestHash = bytesToHex(sha256(utf8ToBytes(canonicalJson(request))));
      const previous = deps.previousStart?.(request.commandId, requestHash, request);
      if (previous)
        return Promise.resolve(
          previous.autoRoute?.requestHash && previous.autoRoute.requestHash !== requestHash
            ? conflict(request, previous.runId ?? 'none')
            : previous,
        );
      const running = pending.get(request.commandId);
      if (running)
        return running.requestHash === requestHash
          ? running.result
          : Promise.resolve(conflict(request));
      const work = run(request, context, requestHash).finally(() =>
        pending.delete(request.commandId),
      );
      pending.set(request.commandId, { requestHash, result: work });
      return work;
    },
  };
}
