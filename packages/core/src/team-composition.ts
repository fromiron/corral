import {
  type AgentRole,
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  DEFAULT_LIMITS,
  type InputBinding,
  type OutputContract,
  type RoleOrigin,
  type RoleSkillRef,
  type SharedOutrider,
  stepSeats,
  TEAM_COMPOSITION_LIMITS,
  type TeamAssistantRequest,
  type TeamCatalog,
  type TeamComposition,
} from '@corral/contracts';
import { BUILTIN_AGENTS } from './builtin-crew.ts';
import {
  builtinSkillName,
  ROLE_PRESET_IDS,
  type RolePresetId,
  roleFromPreset,
} from './team-templates.ts';

// A team the model composed from the editor's catalog becomes a definition
// (docs/specs/features/team-assistant.md, "팀 구성 제안"). The catalog and the assembly share one
// source: the agents and skills the editor offers by hand. Every tool, connection and limit comes
// from a chosen agent or the editor's defaults, never from the composition.

/** An agent the editor's "add agent" offers: a built-in preset or one of the person's own. */
export interface ComposableAgent {
  role: Omit<AgentRole, 'id' | 'origin'>;
  origin?: RoleOrigin;
  /** Built-in agents have one; a saved agent of the library has none. */
  description?: string;
  /** A built-in agent. Without the flag, a preset origin says so. */
  builtin?: boolean;
}

/** A skill the editor's "add skill" offers. */
export interface ComposableSkill {
  ref: RoleSkillRef;
  name: string;
  description: string;
}

/** What the catalog's short ids stand for, kept on the editor's side of the request. */
export interface ResolvedCatalog {
  agentById: ReadonlyMap<string, ComposableAgent>;
  skillById: ReadonlyMap<string, ComposableSkill>;
}

const FILE_CHANGES = new Set<string>(['write_file', 'delete_file', 'move_file']);
const COMMANDS = new Set<string>(['run_command', 'preview_action']);
const isAdvisor = (role: Pick<AgentRole, 'allowedCollaborationTools'>) =>
  role.allowedCollaborationTools.includes('advise');
/** Definitions are JSON data: a JSON copy shares nothing with its original. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sameSkill = (a: RoleSkillRef, b: RoleSkillRef) =>
  a.resourceHash === b.resourceHash && a.entry === b.entry;

/**
 * The ten bundled agents as "add agent" offers them, in the spec's order: each preset's role under
 * the name the screen gives it, its bundled description, and built in.
 */
export function builtinComposableAgents(nameOf: (id: RolePresetId) => string): ComposableAgent[] {
  return ROLE_PRESET_IDS.map((id) => {
    const { id: _id, ...role } = roleFromPreset(id, id, nameOf(id));
    const description = BUILTIN_AGENTS.find((agent) => agent.id === id)?.description;
    return {
      role,
      origin: { kind: 'preset', presetId: id },
      ...(description ? { description } : {}),
      builtin: true,
    };
  });
}

/** The longest skill id (`SkillRef`). */
const ID_LENGTH = 64;
/** A skill's description goes as its first sentence, cut to this length. */
const SKILL_SENTENCE = 160;
let sentences: Intl.Segmenter | undefined;
function firstSentence(text: string): string {
  sentences ??= new Intl.Segmenter('und', { granularity: 'sentence' });
  const first = sentences.segment(text).containing(0)?.segment ?? text;
  return first.trim().slice(0, SKILL_SENTENCE);
}

/**
 * A skill's id is its name; a name already listed gets `-2`, `-3`, … and every id is cut to fit 64
 * characters with its suffix.
 */
function skillIds(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const fit = (suffix: string) => `${name.slice(0, ID_LENGTH - suffix.length)}${suffix}`;
    let id = fit('');
    for (let i = 2; taken.has(id); i++) id = fit(`-${i}`);
    taken.add(id);
    return id;
  });
}

/**
 * The catalog for a new team request: at most 64 agents and 256 skills in the order given. Agents
 * go under ids that mean something only in this request, skills under their names. It carries
 * names, descriptions, output contracts and whether an agent changes files or runs commands; never
 * a prompt, tool name, hash or path. An advisor role is left out: no seat may take one.
 */
export function teamCatalog(
  agents: readonly ComposableAgent[],
  skills: readonly ComposableSkill[],
): ResolvedCatalog & { catalog: TeamCatalog } {
  const listedSkills = skills.slice(0, TEAM_COMPOSITION_LIMITS.skills);
  const listedAgents = agents
    .filter((agent) => !isAdvisor(agent.role))
    .slice(0, TEAM_COMPOSITION_LIMITS.agents);
  const skillName = (ref: RoleSkillRef) =>
    skills.find((skill) => sameSkill(skill.ref, ref))?.name ?? builtinSkillName(ref);
  const agentById = new Map<string, ComposableAgent>();
  const skillById = new Map<string, ComposableSkill>();
  const ids = skillIds(listedSkills.map((skill) => skill.name));
  const catalog: TeamCatalog = {
    agents: listedAgents.map((agent, index) => {
      const id = `a${index + 1}`;
      agentById.set(id, agent);
      const tools = agent.role.allowedWorkTools;
      const names = (agent.role.skills ?? []).flatMap((ref) => {
        const name = skillName(ref);
        return name ? [name] : [];
      });
      return {
        id,
        name: agent.role.name,
        ...(agent.description ? { description: agent.description } : {}),
        changesFiles: tools.some((tool) => FILE_CHANGES.has(tool)),
        runsCommands: tools.some((tool) => COMMANDS.has(tool)),
        output: agent.role.outputContract,
        skills: [...new Set(names)],
      };
    }),
    skills: listedSkills.map((skill, index) => {
      const id = ids[index] as string;
      skillById.set(id, skill);
      return {
        id,
        name: skill.name,
        description: firstSentence(skill.description),
      };
    }),
  };
  return { catalog, agentById, skillById };
}

/**
 * Why a well-formed composition still cannot be used; the whole answer is dropped. A skill the
 * catalog does not list never sinks an answer: the server drops it (`unknown_skill` is only the
 * assembly's own refusal of a plan nobody normalised).
 */
export type TeamCompositionProblem =
  | 'unknown_agent'
  | 'unknown_skill'
  | 'judge_without_review'
  | 'loop_with_opinion_only';

function catalogProblem(
  composition: TeamComposition,
  outputOf: (agentId: string) => OutputContract | undefined,
  hasSkill?: (skillId: string) => boolean,
): TeamCompositionProblem | null {
  const seats = new Map(composition.seats.map((seat) => [seat.id, seat]));
  for (const seat of composition.seats) if (!outputOf(seat.agent)) return 'unknown_agent';
  if (hasSkill)
    for (const seat of composition.seats)
      if (!(seat.skills ?? []).every(hasSkill)) return 'unknown_skill';
  for (const step of composition.flow) {
    if (!('loop' in step)) continue;
    const judge = seats.get(step.loop.judge);
    if (!judge || outputOf(judge.agent) !== 'review') return 'judge_without_review';
  }
  return null;
}

/**
 * The spec's unusable compositions that the schema cannot see: an agent the catalog does not list,
 * a judge that returns no review, and a loop the person ruled out by asking for opinions only.
 */
export function compositionProblem(
  composition: TeamComposition,
  catalog: TeamCatalog,
  decisions?: TeamAssistantRequest['decisions'],
): TeamCompositionProblem | null {
  const agents = new Map(catalog.agents.map((agent) => [agent.id, agent.output]));
  const problem = catalogProblem(composition, (id) => agents.get(id));
  if (problem) return problem;
  if (decisions?.reviewPolicy === 'opinion_only' && composition.flow.some((step) => 'loop' in step))
    return 'loop_with_opinion_only';
  return null;
}

export class TeamCompositionError extends Error {
  readonly problem: TeamCompositionProblem;
  constructor(problem: TeamCompositionProblem) {
    super(`unusable team composition: ${problem}`);
    this.name = 'TeamCompositionError';
    this.problem = problem;
  }
}

/** Labels of the steps that are not seats, in the screen language. */
export interface TeamCompositionLabels {
  loop: string;
  decision: string;
  join: string;
  /** The Team that holds a group side by side as the first step; without it, the Join's label. */
  group?: string;
  output: string;
  outriderPrinciples?: string;
}

// The same principles a drafted plan's Outrider gets (team-draft.ts).
const DEFAULT_OUTRIDER_PRINCIPLES =
  'Check the evidence against the requested result and suggest concrete corrections.';

// ── assembly ─────────────────────────────────────────────────────────────────

const brief: InputBinding = { kind: 'run_input', name: 'brief' };
const criteria: InputBinding = { kind: 'run_input', name: 'criteria' };

/** Where the previous step lets the next one start: the ports that lead on. */
type Exits = { source: string; sourcePort: string }[];

/**
 * The composition as a new definition under `corralId`. Steps run in order; a group side by side
 * fans out from the step before and meets at a Join; as the first step it sits in an inline Team,
 * the one entry, whose body fans out and whose Join is its exit. A loop is a Loop whose work runs
 * in order, then the judge, then a review decision, and it goes on to the next step whether the
 * judge passed the work or the rounds ran out. Node ids come from the flow (`seat_1`, `loop_1`,
 * `decision_1`, `team_1`, `join_1`, `output`), never from the model's seat ids.
 */
export function draftFromComposition(
  composition: TeamComposition,
  corralId: string,
  resolved: ResolvedCatalog,
  labels: TeamCompositionLabels,
): CorralDefinition {
  const problem = catalogProblem(
    composition,
    (id) => resolved.agentById.get(id)?.role.outputContract,
    (id) => resolved.skillById.has(id),
  );
  if (problem) throw new TeamCompositionError(problem);
  const seats = new Map(composition.seats.map((seat) => [seat.id, seat]));
  // Seats are numbered in the order they work: each step's seats, a loop's judge after its work.
  const nodeOf = new Map(
    composition.flow.flatMap(stepSeats).map((seatId, index) => [seatId, `seat_${index + 1}`]),
  );
  const seatOf = (seatId: string) => {
    const seat = seats.get(seatId);
    const agent = resolved.agentById.get(seat?.agent ?? '');
    const nodeId = nodeOf.get(seatId);
    if (!seat || !agent || !nodeId) throw new Error(`the flow names no usable seat ${seatId}`);
    return { seat, agent, nodeId };
  };
  // An input is named after its producer's output, as the editor names one it suggests.
  const read = (seatId: string): InputBinding => ({
    kind: 'task_output',
    name: seatOf(seatId).agent.role.outputContract,
    sourceNodeId: seatOf(seatId).nodeId,
  });
  // Round one has no previous round, so these are optional.
  const lastRound = (seatId: string): InputBinding => ({
    kind: 'previous_iteration_output',
    name: seatOf(seatId).agent.role.outputContract,
    sourceNodeId: seatOf(seatId).nodeId,
    optional: true,
  });
  /** A name already taken on the same reader gets `_2`, `_3`, … (editor `withSuggestedBinding`). */
  const named = (inputs: InputBinding[]): InputBinding[] => {
    const names = new Set<string>();
    return inputs.map((binding) => {
      let name = binding.name;
      for (let i = 2; names.has(name); i++) name = `${binding.name}_${i}`;
      names.add(name);
      return name === binding.name ? binding : { ...binding, name };
    });
  };

  const nodes: CorralNode[] = [];
  const edges: ControlEdge[] = [];
  const roles: AgentRole[] = [];
  let loops = 0;
  let joins = 0;
  const edge = (
    source: string,
    sourcePort: string,
    target: string,
    targetPort: ControlEdge['targetPort'] = 'in',
  ) => edges.push({ id: `e${edges.length + 1}`, source, sourcePort, target, targetPort });
  const connect = (exits: Exits, target: string, targetPort: ControlEdge['targetPort'] = 'in') => {
    for (const exit of exits) edge(exit.source, exit.sourcePort, target, targetPort);
  };
  const join = (policy: 'all' | 'any', parentId?: string) => {
    const id = `join_${++joins}`;
    nodes.push({ id, type: 'join', label: labels.join, policy, ...(parentId ? { parentId } : {}) });
    return id;
  };

  /** The seat's role and node; `place` is its 1-based position in a group side by side. */
  const seatNode = (
    seatId: string,
    inputs: InputBinding[],
    { parentId, place }: { parentId?: string; place?: number } = {},
  ) => {
    const { seat, agent, nodeId } = seatOf(seatId);
    // The copy "add agent" makes: the whole role, then this copy's own origin only.
    const role: AgentRole = copy({ ...agent.role, id: nodeId, name: seat.name });
    if (agent.origin) role.origin = copy(agent.origin);
    else delete role.origin;
    if (seat.skills?.length) {
      const skills = role.skills ?? [];
      for (const skillId of seat.skills) {
        const ref = resolved.skillById.get(skillId)?.ref;
        if (ref && !skills.some((known) => sameSkill(known, ref))) skills.push({ ...ref });
      }
      role.skills = skills;
    }
    const builtin = agent.builtin ?? agent.origin?.kind === 'preset';
    if (place !== undefined && place % 2 === 0 && builtin) role.modelProfile = 'model-b';
    roles.push(role);
    nodes.push({
      id: nodeId,
      type: 'agent',
      label: seat.name,
      stepInstruction: seat.duty,
      roleId: nodeId,
      invocation: 'scheduled',
      inputBindings: named(inputs),
      outputName: role.outputContract,
      ...(parentId ? { parentId } : {}),
    });
    return nodeId;
  };

  let exits: Exits = [];
  let entry = '';
  const earlier: string[] = [];
  const last = composition.flow.length - 1;
  composition.flow.forEach((step) => {
    const before = [brief, ...earlier.map(read)];

    if ('seat' in step) {
      // Every seat receives the criteria: an early one also needs to know what done means.
      const id = seatNode(step.seat, [...before, criteria]);
      if (exits.length) connect(exits, id);
      else entry = id;
      exits = [{ source: id, sourcePort: 'out' }];
    } else if ('parallel' in step) {
      // A Loop leads on through two ports, but a fan-out leaves from one: an any-Join takes
      // whichever way out arrives and the group fans out from there.
      if (exits.length > 1) {
        const relay = join('any');
        connect(exits, relay);
        exits = [{ source: relay, sourcePort: 'out' }];
      }
      // The entry is one node: a first group sits in a Team that fans out from its body.
      const team = exits.length ? undefined : 'team_1';
      if (team) {
        nodes.push({
          id: team,
          type: 'team',
          label: labels.group ?? labels.join,
          source: { kind: 'inline' },
        });
        entry = team;
        exits = [{ source: team, sourcePort: 'body' }];
      }
      // Seats side by side do not read each other.
      const ids = step.parallel.map((seatId, i) =>
        seatNode(seatId, [...before, criteria], {
          place: i + 1,
          ...(team ? { parentId: team } : {}),
        }),
      );
      for (const id of ids) connect(exits, id);
      const gather = join('all', team);
      for (const id of ids) edge(id, 'out', gather);
      if (team) edge(gather, 'out', team, 'exit');
      exits = [team ? { source: team, sourcePort: 'next' } : { source: gather, sourcePort: 'out' }];
    } else {
      const { work, judge, rounds } = step.loop;
      const loop = `loop_${++loops}`;
      const decision = `decision_${loops}`;
      nodes.push({ id: loop, type: 'loop', label: labels.loop, maxIterations: rounds ?? 2 });
      if (exits.length) connect(exits, loop, 'enter');
      else entry = loop;
      // Each working seat reads the round's earlier work, its own last round and the last review.
      const ids = work.map((seatId, i) =>
        seatNode(
          seatId,
          [...before, ...work.slice(0, i).map(read), lastRound(seatId), lastRound(judge), criteria],
          { parentId: loop },
        ),
      );
      // The judge reviews the round's last work: it comes first and is named `draft`, the input a
      // reviewer takes as its target, whatever its output; an earlier draft becomes `draft_2`.
      const reviewed = work.at(-1) as string;
      const judgeId = seatNode(
        judge,
        [{ ...read(reviewed), name: 'draft' }, ...before, ...work.slice(0, -1).map(read), criteria],
        { parentId: loop },
      );
      nodes.push({
        id: decision,
        type: 'decision',
        label: labels.decision,
        parentId: loop,
        mode: 'review',
        rule: 'review_verdict',
        inputBindings: [read(judge)],
      });
      edge(loop, 'body', ids[0] as string);
      for (const [i, id] of ids.entries()) edge(id, 'out', ids[i + 1] ?? judgeId);
      edge(judgeId, 'out', decision);
      edge(decision, 'revise', loop, 'repeat');
      edge(decision, 'pass', loop, 'exit');
      // At the round cap nobody is asked: the last candidate goes on as a passed one would.
      exits = [
        { source: loop, sourcePort: 'next' },
        { source: loop, sourcePort: 'exhausted' },
      ];
    }
    earlier.push(...stepSeats(step));
  });

  // The team receives the last step's result: a loop's is its last working seat's.
  const final = composition.flow[last];
  const results = !final ? [] : 'loop' in final ? final.loop.work.slice(-1) : stepSeats(final);
  nodes.push({
    id: 'output',
    type: 'output',
    label: labels.output,
    inputBindings: named(results.map(read)),
    requireApproval: false,
  });
  connect(exits, 'output');

  return {
    schemaVersion: '0.1',
    id: corralId,
    name: composition.name,
    entryNodeId: entry,
    input: { brief: composition.brief, criteria: [...composition.criteria] },
    roles,
    nodes,
    controlEdges: edges,
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
    ...outrider(composition.outrider, labels),
  };
}

/**
 * The shared Outrider a drafted plan gets for the same request (team-draft.ts `draftFromPlan`):
 * consultation and artifact review on request, or the Outrider a required review needs. The
 * required review itself is the editor's command, applied once the person confirms the target.
 */
function outrider(
  wanted: TeamComposition['outrider'],
  labels: TeamCompositionLabels,
): { sharedOutrider?: SharedOutrider } {
  if (!wanted) return {};
  return {
    sharedOutrider: {
      modelProfile: 'model-a',
      principles: labels.outriderPrinciples ?? DEFAULT_OUTRIDER_PRINCIPLES,
      targets: { kind: 'all' },
      ...(wanted === 'artifact_review' ? { artifactReview: true as const } : {}),
    },
  };
}
