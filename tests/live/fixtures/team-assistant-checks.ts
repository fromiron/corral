import type {
  ModelAttempt,
  OutputContract,
  TeamAssistantReply,
  TeamAssistantRequest,
  TeamCatalog,
  TeamComposition,
  WorkTool,
} from '@corral/contracts';
import { stepSeats } from '@corral/contracts';
import {
  type ComposableAgent,
  type ComposableSkill,
  compileDefinition,
  draftFromComposition,
  planRun,
  type ResolvedCatalog,
  teamCatalog,
} from '@corral/core';

// The check cases of the team assistant's measurement (fixtures/team-compose-goals.check.json):
// reading the file, the catalog each case sends, the proposal it shows and the expectations a
// plan misses. Nothing here calls a model.

/** An agent of the person's library, as the check file describes it. */
export interface CheckAgent {
  name: string;
  /**
   * For the person who rates only, never sent: the library agent has no description of its own
   * and its instructions are its name, so the catalog describes it by its name.
   */
  description?: string;
  changesFiles: boolean;
  runsCommands: boolean;
  output: OutputContract;
}

export interface CheckExpect {
  /** `plan`: a question is a miss; `plan_or_question`: the named question is accepted too. */
  reply: 'plan' | 'plan_or_question';
  question?: 'material' | 'review_policy' | 'review_target';
  changes?: boolean;
  submitters?: string[];
  oneResult?: boolean;
  loop?: 'warranted' | 'allowed' | 'none';
  judges?: string[];
  rounds?: number;
  maxSeats?: number;
  uses?: string[];
  keeps?: string[];
  drops?: string[];
  outrider?: string[];
}

export interface CheckCase {
  id: string;
  kind: string;
  lang: 'ko' | 'en';
  /** `bundled`, or the name of a list under the file's `agents` added to the bundled crew. */
  catalog: string;
  repeat?: boolean;
  /** User messages, sent in order. */
  messages: string[];
  /** The shown composition; each seat names its agent by the agent's name. */
  proposal?: TeamComposition;
  expect: CheckExpect;
  rater?: string;
}

export interface CheckFile {
  split: string;
  agents: Record<string, CheckAgent[]>;
  cases: CheckCase[];
}

const fail = (message: string): never => {
  throw new Error(message);
};
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** A check file, read loudly: a case the harness cannot send stops the run before any request. */
export function checkFileOf(value: unknown): CheckFile {
  const file = value as Partial<CheckFile> | null;
  if (!file || !Array.isArray(file.cases) || file.cases.length === 0)
    fail('The check file has no cases.');
  const agents = (file?.agents ?? {}) as Record<string, CheckAgent[]>;
  for (const [name, list] of Object.entries(agents))
    if (
      !Array.isArray(list) ||
      !list.every(
        (agent) =>
          typeof agent.name === 'string' &&
          typeof agent.changesFiles === 'boolean' &&
          typeof agent.runsCommands === 'boolean' &&
          typeof agent.output === 'string',
      )
    )
      fail(`Agent list ${name} needs a name, changesFiles, runsCommands and output per agent.`);
  const cases = (file?.cases ?? []) as CheckCase[];
  const ids = new Set<string>();
  for (const [index, entry] of cases.entries()) {
    if (typeof entry.id !== 'string' || ids.has(entry.id)) fail(`Case ${index} needs a unique id.`);
    ids.add(entry.id);
    if (entry.lang !== 'ko' && entry.lang !== 'en') fail(`Case ${entry.id} needs lang ko or en.`);
    if (!isStrings(entry.messages) || entry.messages.length === 0)
      fail(`Case ${entry.id} needs at least one user message.`);
    if (entry.catalog !== 'bundled' && !agents[entry.catalog])
      fail(`Case ${entry.id} names an unknown catalog.`);
    if (entry.expect?.reply !== 'plan' && entry.expect?.reply !== 'plan_or_question')
      fail(`Case ${entry.id} needs expect.reply.`);
  }
  return { split: typeof file?.split === 'string' ? file.split : '', agents, cases };
}

const READ_TOOLS: WorkTool[] = ['write_artifact', 'list_files', 'read_file'];

/**
 * A library agent as Studio sends one (apps/studio/src/workbench/teamChoices.ts): its role under
 * its name, an origin of kind `library`, and no description. The catalog then sends the first
 * sentence of its instructions, which is its name: the rater's description stays out.
 */
export function libraryAgent(agent: CheckAgent, index: number): ComposableAgent {
  return {
    role: {
      name: agent.name,
      prompt: agent.name,
      modelProfile: 'model-a',
      allowedWorkTools: [
        ...READ_TOOLS,
        ...(agent.changesFiles ? (['write_file'] as const) : []),
        ...(agent.runsCommands ? (['run_command'] as const) : []),
      ],
      allowedCollaborationTools: ['read_artifact', 'submit_result'],
      outputContract: agent.output,
      skills: [],
    },
    origin: { kind: 'library', agentId: `library_${index + 1}`, revision: 1 },
  };
}

/** The catalog a case sends, with what its ids stand for: the bundled crew, then its library. */
export function caseCatalog(
  file: Pick<CheckFile, 'agents'>,
  entry: Pick<CheckCase, 'catalog'>,
  bundled: readonly ComposableAgent[],
  skills: readonly ComposableSkill[],
): ResolvedCatalog & { catalog: TeamCatalog } {
  const library = entry.catalog === 'bundled' ? [] : (file.agents[entry.catalog] ?? []);
  return teamCatalog([...bundled, ...library.map(libraryAgent)], skills);
}

/** The catalog id of the agent with this name; a name that is missing or not unique throws. */
export function agentIdByName(catalog: TeamCatalog, name: string): string {
  const found = catalog.agents.filter((agent) => agent.name === name);
  if (found.length !== 1)
    fail(`The agent name ${JSON.stringify(name)} matches ${found.length} catalog agents.`);
  return (found[0] as TeamCatalog['agents'][number]).id;
}

/** The proposal as the request sends it: each seat's agent name resolved to that catalog's id. */
export function proposalFor(proposal: TeamComposition, catalog: TeamCatalog): TeamComposition {
  return {
    ...proposal,
    seats: proposal.seats.map((seat) => ({ ...seat, agent: agentIdByName(catalog, seat.agent) })),
  };
}

/** The new team request of one send: the case's user messages in order, its catalog and proposal. */
export function checkRequest(
  entry: Pick<CheckCase, 'messages'>,
  catalog: TeamCatalog,
  proposal: TeamComposition | undefined,
  operationId: string,
): TeamAssistantRequest {
  return {
    mode: 'create',
    operationId,
    messages: entry.messages.map((content) => ({ role: 'user' as const, content })),
    catalog,
    ...(proposal ? { proposal } : {}),
  };
}

/** The composition for reading: each seat's agent under its name. */
export function namedComposition(plan: TeamComposition, catalog: TeamCatalog): TeamComposition {
  const names = new Map(catalog.agents.map((agent) => [agent.id, agent.name]));
  return {
    ...plan,
    seats: plan.seats.map((seat) => ({ ...seat, agent: names.get(seat.agent) ?? seat.agent })),
  };
}

const ASSEMBLY = { loop: 'Loop', decision: 'Decision', join: 'Join', output: 'Output' };

/** Whether the plan assembles against the catalog it was sent with, compiles and runs as a plan. */
export function compiledWith(
  plan: TeamComposition,
  resolved: ResolvedCatalog,
): { compiles: boolean; warnings: string[] } {
  try {
    const definition = draftFromComposition(plan, 'measured', resolved, ASSEMBLY);
    const compiled = compileDefinition(definition, { knownModelProfiles: ['model-a', 'model-b'] });
    const warnings = compiled.diagnostics
      .filter((d) => d.severity === 'warning')
      .map((d) => d.code);
    return {
      compiles:
        compiled.ok &&
        compiled.diagnostics.every((d) => d.severity !== 'error') &&
        planRun(definition).ok,
      warnings,
    };
  } catch {
    return { compiles: false, warnings: [] };
  }
}

const HANGUL = /[가-힣]/;

/** Korean case: Hangul in the team name and every duty; English case: none. */
export function writtenIn(lang: 'ko' | 'en', plan: TeamComposition): boolean {
  const texts = [plan.name, ...plan.seats.map((seat) => seat.duty)];
  return lang === 'ko'
    ? texts.every((text) => HANGUL.test(text))
    : texts.every((text) => !HANGUL.test(text));
}

/** The seats that produce the team's result: a loop's last work seat, else the last step's. */
export function lastProducers(plan: TeamComposition): string[] {
  const last = plan.flow.at(-1);
  if (!last) return [];
  return 'loop' in last ? last.loop.work.slice(-1) : stepSeats(last);
}

/** The flow's shape without its seats: `seat`, `parallel×n`, `loop×n` (n work seats). */
export function flowShape(plan: TeamComposition): string[] {
  return plan.flow.map((step) =>
    'seat' in step
      ? 'seat'
      : 'parallel' in step
        ? `parallel×${step.parallel.length}`
        : `loop×${step.loop.work.length}`,
  );
}

/** The names of the agents that hold a seat, each once, sorted. */
export function seatedAgents(plan: TeamComposition, catalog: TeamCatalog): string[] {
  const names = new Map(catalog.agents.map((agent) => [agent.id, agent.name]));
  return [...new Set(plan.seats.map((seat) => names.get(seat.agent) ?? seat.agent))].sort();
}

/** Where one attempt of an operation spent its time, from what the attempt history holds. */
export interface AttemptTime {
  status: ModelAttempt['status'];
  /** Waiting for a request slot before the request went out. */
  queueMs: number | null;
  /** From the request going out to the provider's first event. */
  firstEventMs: number | null;
  /** From the first event to the end of the attempt. */
  streamMs: number | null;
  /** Between the previous attempt's end and this one's start: the wait before a retry. */
  retryGapMs?: number;
  /** A failed attempt's failure code. */
  failure?: string;
}

/** Each attempt's times in the order the attempts started; a time the history lacks is null. */
export function attemptTimes(history: readonly ModelAttempt[]): AttemptTime[] {
  const at = (time: string | null) => (time === null ? null : Date.parse(time));
  const ordered = [...history].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return ordered.map((attempt, index) => {
    const started = Date.parse(attempt.startedAt);
    const first = at(attempt.firstEventAt);
    const ended = at(attempt.endedAt);
    const queue = attempt.queueWaitMs ?? null;
    const before = index > 0 ? at((ordered[index - 1] as ModelAttempt).endedAt) : null;
    return {
      status: attempt.status,
      queueMs: queue,
      firstEventMs: first === null ? null : first - started - (queue ?? 0),
      streamMs: first === null || ended === null ? null : ended - first,
      ...(before !== null ? { retryGapMs: started - before } : {}),
      ...(attempt.failure ? { failure: attempt.failure.code } : {}),
    };
  });
}

/** One scheduled send of a check case, as the run writes it. */
export interface CheckRecord {
  profileId: string;
  case: string;
  kind: string;
  lang: 'ko' | 'en';
  send: 'first' | 'repeat';
  /** Null for a send that was not made. */
  operationId: string | null;
  outcome: 'plan' | 'question' | 'invalid' | 'error' | 'skipped';
  questionId?: string;
  /** The refusal's whole reason, place included. */
  reason?: string;
  /** The error code of a send with no answer. */
  code?: string;
  ms?: number;
  attempts?: number;
  /** Where each attempt spent its time. */
  timing?: AttemptTime[];
  outputTokens?: number;
  /** The plan with each seat's agent named. */
  composition?: TeamComposition;
  /** The plan reply's reason sentence. */
  planReason?: string;
  flow?: string[];
  agents?: string[];
  compiles?: boolean;
  warnings?: string[];
  /** The expectations the reply misses; absent for a send without a reply. */
  failed?: string[];
  /** For a person to fill in. */
  fit: null;
}

/** The headline of one model's check run: first sends, then each repeat beside its first send. */
export function checkSummaryOf(profileId: string, records: readonly CheckRecord[]) {
  const first = records.filter((r) => r.send === 'first');
  const count = (outcome: CheckRecord['outcome']) =>
    first.filter((r) => r.outcome === outcome).length;
  const plans = first.filter((r) => r.outcome === 'plan');
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return {
    profileId,
    summary: true,
    first: {
      sends: first.length,
      plans: plans.length,
      questions: count('question'),
      refusals: count('invalid'),
      noAnswers: count('error'),
      skipped: count('skipped'),
      plansMissingNothing: plans.filter((r) => r.failed?.length === 0).length,
      plansMissingNothingIds: plans.filter((r) => r.failed?.length === 0).map((r) => r.case),
    },
    repeats: records
      .filter((r) => r.send === 'repeat')
      .map((again) => {
        const once = first.find((r) => r.case === again.case);
        const bothPlans = once?.outcome === 'plan' && again.outcome === 'plan';
        const bothSent = !!once && once.outcome !== 'skipped' && again.outcome !== 'skipped';
        return {
          case: again.case,
          outcomes: [once?.outcome ?? 'skipped', again.outcome],
          sameOutcome: bothSent ? once.outcome === again.outcome : null,
          sameFlow: bothPlans ? same(once.flow, again.flow) : null,
          sameAgents: bothPlans ? same(once.agents, again.agents) : null,
        };
      }),
  };
}

/**
 * The expectations a reply misses, by name; an absent expectation is not checked. A question is
 * read for `reply` and `question` only; a plan for every other expectation and its language.
 */
export function missedExpectations(
  reply: TeamAssistantReply,
  expect: CheckExpect,
  catalog: TeamCatalog,
  lang: 'ko' | 'en',
): string[] {
  if (reply.kind === 'question') {
    if (expect.reply !== 'plan_or_question') return ['reply'];
    return expect.question && reply.id !== expect.question ? ['question'] : [];
  }
  if (reply.kind !== 'plan') return ['reply'];
  const { plan } = reply;
  const agents = new Map(catalog.agents.map((agent) => [agent.id, agent]));
  const seats = new Map(plan.seats.map((seat) => [seat.id, seat]));
  const agentOf = (seatId: string) => agents.get(seats.get(seatId)?.agent ?? '');
  const seated = new Set(seatedAgents(plan, catalog));
  const loops = plan.flow.flatMap((step) => ('loop' in step ? [step.loop] : []));
  const last = plan.flow.at(-1);
  const failed: string[] = [];
  const check = (name: string, met: boolean) => {
    if (!met) failed.push(name);
  };
  if (expect.changes !== undefined)
    check(
      'changes',
      plan.seats.some((seat) => agents.get(seat.agent)?.changesFiles) === expect.changes,
    );
  if (expect.submitters) {
    const allowed = expect.submitters;
    const producers = lastProducers(plan);
    check(
      'submitters',
      producers.length > 0 &&
        producers.every((seatId) => allowed.includes(agentOf(seatId)?.name ?? '')),
    );
  }
  if (expect.oneResult) check('oneResult', !!last && ('seat' in last || 'loop' in last));
  if (expect.loop === 'warranted') check('loop', loops.length > 0);
  if (expect.loop === 'none') check('loop', loops.length === 0);
  if (expect.judges) {
    const allowed = expect.judges;
    check(
      'judges',
      loops.every((loop) => allowed.includes(agentOf(loop.judge)?.name ?? '')),
    );
  }
  if (expect.rounds !== undefined) {
    const rounds = expect.rounds;
    check(
      'rounds',
      loops.every((loop) => (loop.rounds ?? 2) === rounds),
    );
  }
  if (expect.maxSeats !== undefined) check('maxSeats', plan.seats.length <= expect.maxSeats);
  if (expect.uses)
    check(
      'uses',
      expect.uses.every((name) => seated.has(name)),
    );
  if (expect.keeps)
    check(
      'keeps',
      expect.keeps.every((name) => seated.has(name)),
    );
  if (expect.drops)
    check(
      'drops',
      expect.drops.every((name) => !seated.has(name)),
    );
  if (expect.outrider) check('outrider', expect.outrider.includes(plan.outrider ?? 'none'));
  check('lang', writtenIn(lang, plan));
  return failed;
}
