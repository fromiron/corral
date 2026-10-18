import {
  AUTO_REASON_MAX,
  AUTO_TEMPLATE_VERSION,
  type AutoModelChoice,
  type AutoRoute,
  AutoTemplate,
  type CorralDefinition,
  FILE_TOOLS,
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
      duty: 'Do what the request asks, directly and completely. State any assumption in the result instead of asking back.',
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
  id: string;
  template: AutoTemplate;
  brief: string;
  criteria?: string[];
  choice: AutoModelChoice;
  /** The session has a working copy, so the roles get file tools. */
  fileTools: boolean;
  /**
   * Output tokens the choice request used: with a number, one model call and these tokens
   * come off this run's limits. Null or absent when no model was called.
   */
  routeOutputTokens?: number | null;
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
  const roles = definition.roles.map((role) => {
    const writes = WRITERS.has(role.id as TeamSlot);
    const tools: WorkTool[] = input.fileTools
      ? ['write_artifact', ...(writes ? FILE_TOOLS : READ_TOOLS)]
      : ['write_artifact'];
    return {
      ...role,
      prompt: input.fileTools
        ? `${role.prompt}${FILE_NOTE}${writes ? WRITE_NOTE : ''}`
        : role.prompt,
      modelProfile: input.choice.modelProfile,
      ...(input.choice.reasoning ? { reasoning: input.choice.reasoning } : {}),
      allowedWorkTools: tools,
    };
  });
  const used = input.routeOutputTokens;
  const limits =
    used === null || used === undefined
      ? definition.limits
      : {
          ...definition.limits,
          maxModelCalls: Math.max(1, definition.limits.maxModelCalls - 1),
          maxOutputTokens: Math.max(1, definition.limits.maxOutputTokens - used),
        };
  return { ...definition, roles, limits };
}

export const AUTO_ROUTE_MAX_OUTPUT_TOKENS = 256;
export const AUTO_ROUTE_TIMEOUT_MS = 30_000;

export const AUTO_ROUTER_PROMPT = `You choose how a request to a team of AI agents is handled. Answer with one JSON object and nothing else: {"template": "<id>", "reason": "<one short sentence>"}.
Templates:
- single: one agent answers or does the work directly. Questions, explanations, small edits and short tasks.
- write_review: a planner outlines, a writer drafts, a reviewer checks and asks for revisions. Documents or changes that need a careful check.
- research_write_review: a researcher collects facts and sources, then a writer drafts and a reviewer checks. Comparisons, investigations and anything that needs sources.
Prefer single unless the request clearly needs a review or research. Write the reason in the request's language, in at most ${AUTO_REASON_MAX} characters.`;

const RouteAnswerText = z.strictObject({
  template: AutoTemplate,
  reason: z.string().trim().min(1).max(AUTO_REASON_MAX),
});

/** The start model's answer: one JSON object naming an allowed template, or null. */
export function parseAutoRoute(text: string): { template: AutoTemplate; reason: string } | null {
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
  return parsed.success ? parsed.data : null;
}

/** The choice without a model (the demo, simulated runs): the CR-006 local suggestion. */
export function localAutoRoute(brief: string): { template: AutoTemplate; reason: string } {
  const plan = planFromGoal(brief, WORDING);
  return { template: plan?.pattern ?? 'single', reason: '' };
}

export type RouteAnswer =
  | { ok: true; text: string; usage: { inputTokens: number; outputTokens: number } | null }
  | { ok: false; reason: 'timeout' | 'model_error' };

export interface AutoStart {
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
  startRun(request: StartRunRequest): StartRunResult | Promise<StartRunResult>;
  /** The earlier start of a command and the choice it recorded; null if never started. */
  previousStart?(commandId: string): AutoStartResult | null;
  /** A refusal before any choice is asked for (busy, model not connected); null to go on. */
  precheck?(request: AutoStart): StartRunResult | null;
  /**
   * The start model. Null (or no function) means the local rule chooses and no model is
   * called, as for simulated runs.
   */
  route?(input: {
    brief: string;
    choice: AutoModelChoice;
    mode: 'mock' | 'live';
    signal: S | undefined;
  }): Promise<RouteAnswer> | null;
}

export function createAutoStarter<S extends AutoSignal = AutoSignal>(deps: AutoStarterDeps<S>) {
  // One choice per command ID: a resend while choosing waits for that choice.
  const pending = new Map<string, Promise<AutoStartResult>>();

  const choose = async (request: AutoStart, signal: S | undefined) => {
    const asked = deps.route?.({
      brief: request.brief,
      choice: request.choice,
      mode: request.mode,
      signal,
    });
    if (!asked) return { ...localAutoRoute(request.brief), source: 'local' as const, usage: null };
    const answer = await asked;
    if (signal?.aborted) throw cancelled();
    const usage = answer.ok ? answer.usage : null;
    const picked = answer.ok ? parseAutoRoute(answer.text) : null;
    if (picked) return { ...picked, source: 'model' as const, usage, called: true };
    return {
      template: 'single' as const,
      reason: '',
      source: 'fallback' as const,
      fallback: answer.ok ? ('invalid_answer' as const) : answer.reason,
      usage,
      called: true,
    };
  };

  const run = async (
    request: AutoStart,
    context: { fileTools: boolean; signal?: S },
  ): Promise<AutoStartResult> => {
    const signal = context.signal;
    if (signal?.aborted) throw cancelled();
    const refused = deps.precheck?.(request);
    if (refused) return { ...refused, autoRoute: null };
    const { called, ...chosen } = { called: false, ...(await choose(request, signal)) };
    const autoRoute: AutoRoute = {
      ...chosen,
      templateVersion: AUTO_TEMPLATE_VERSION,
      modelProfile: request.choice.modelProfile,
      ...(request.choice.reasoning ? { reasoning: request.choice.reasoning } : {}),
      inputHash: bytesToHex(sha256(utf8ToBytes(request.brief))),
    };
    const definition = autoDefinition({
      id: `auto_${(request.sessionId ?? request.commandId).replace(/^session_/, '')}`,
      template: autoRoute.template,
      brief: request.brief,
      ...(request.criteria ? { criteria: request.criteria } : {}),
      choice: request.choice,
      fileTools: context.fileTools,
      routeOutputTokens: called ? (autoRoute.usage?.outputTokens ?? 0) : null,
    });
    const result = await deps.startRun({
      schemaVersion: '0.1',
      commandId: request.commandId,
      definition,
      mode: request.mode,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.startFrom ? { startFrom: request.startFrom } : {}),
      ...(request.references?.length ? { references: request.references } : {}),
      autoRoute,
    });
    return { ...result, autoRoute: result.runId ? autoRoute : null };
  };

  return {
    start(
      request: AutoStart,
      context: { fileTools: boolean; signal?: S },
    ): Promise<AutoStartResult> {
      const previous = deps.previousStart?.(request.commandId);
      if (previous) return Promise.resolve(previous);
      const running = pending.get(request.commandId);
      if (running) return running;
      const work = run(request, context).finally(() => pending.delete(request.commandId));
      pending.set(request.commandId, work);
      return work;
    },
  };
}
