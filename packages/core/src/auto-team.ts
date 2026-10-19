import {
  AUTO_REASON_MAX,
  AUTO_ROUTE_LEVELS,
  AUTO_TEMPLATE_VERSION,
  type AutoModelChoice,
  type AutoRoute,
  type AutoRouteLevel,
  AutoTemplate,
  type CorralDefinition,
  FILE_TOOLS,
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
import { draftFromPlan, planFromGoal, type TeamWording } from './team-draft.ts';

// CR-024: a session without a chosen team runs in auto mode. A start model picks one of the
// built-in templates (the CR-006 patterns); the template fixes roles, tools, wiring and
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
  // Roles always get a CR-021 policy: `route` becomes the level picked for this request.
  const asked = input.choice.reasoning;
  const reasoning =
    asked?.mode === 'route'
      ? { mode: 'fixed' as const, level: input.routeLevel ?? ('medium' as const) }
      : asked;
  const roles = definition.roles.map((role) => {
    const writes = WRITERS.has(role.id as TeamSlot) && input.taskScope !== 'review_only';
    const tools: WorkTool[] = input.fileTools
      ? ['write_artifact', ...(writes ? FILE_TOOLS : READ_TOOLS)]
      : ['write_artifact'];
    return {
      ...role,
      prompt: input.fileTools
        ? `${role.prompt}${FILE_NOTE}${writes ? WRITE_NOTE : ''}`
        : role.prompt,
      modelProfile: input.choice.modelProfile,
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

export const AUTO_ROUTE_MAX_OUTPUT_TOKENS = 256;
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
    "Write the reason in the request's language, in at most 40 characters.",
    'Keep the complete JSON response below 256 UTF-8 bytes.',
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

/** The choice without a model (the demo, simulated runs): the CR-006 local suggestion. */
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
  taskScope?: RunInput['taskScope'];
  verificationScope?: RunInput['verificationScope'];
  commandId: string;
  sessionId?: string;
  brief: string;
  criteria?: string[];
  mode: 'mock' | 'live';
  choice: AutoModelChoice;
  startFrom?: StartFrom;
  references?: RunReference[];
}

export type AutoStartResult = StartRunResult & { autoRoute: AutoRoute | null };

/** The part of an AbortSignal the starter reads; core has no DOM or Node types. */
export interface AutoSignal {
  readonly aborted: boolean;
}

const cancelled = () => new Error('the auto request was cancelled before a run started');

export interface AutoStarterDeps<S extends AutoSignal = AutoSignal> {
  /** The Coordinator itself, or a transport to it (the in-browser runtime). */
  startRun(request: StartRunRequest, signal?: S): StartRunResult | Promise<StartRunResult>;
  /** The earlier start after checking its original request identity; null if never recorded. */
  previousStart?(
    commandId: string,
    requestHash: string,
    request: AutoStart,
  ): AutoStartResult | null;
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

  const choose = async (request: AutoStart, signal: S | undefined) => {
    // `route`: the model picks one of low, medium and high that this model supports.
    const routing = request.choice.reasoning?.mode === 'route';
    const supported = routing ? deps.levels?.(request.choice, request.mode) : null;
    const levels = routing
      ? AUTO_ROUTE_LEVELS.filter((level) => !supported || supported.includes(level))
      : undefined;
    const medium = (source: 'local' | 'fallback') =>
      routing ? { reasoningChoice: { level: 'medium' as const, source } } : {};
    const asked = deps.route?.({
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
    const chosen = await choose(request, signal);
    if (signal?.aborted) throw cancelled();
    const autoRoute: AutoRoute = {
      ...chosen,
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
      fileTools: context.fileTools,
      ...(autoRoute.reasoningChoice ? { routeLevel: autoRoute.reasoningChoice.level } : {}),
    });
    const result = await deps.startRun(
      {
        schemaVersion: '0.1',
        commandId: request.commandId,
        definition,
        mode: request.mode,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.startFrom ? { startFrom: request.startFrom } : {}),
        ...(request.references?.length ? { references: request.references } : {}),
        autoRoute,
      },
      signal,
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
