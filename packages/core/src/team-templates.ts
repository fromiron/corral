import {
  type AgentRole,
  type CollaborationTool,
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  DEFAULT_LIMITS,
  type InputBinding,
  type OutputContract,
  type RoleSkillRef,
  type WorkTool,
} from '@corral/contracts';
import { BUILTIN_AGENTS, BUILTIN_SKILLS } from './builtin-crew.ts';
import { ROLE_RULES } from './role-prompt.ts';

// The library's team templates (docs/specs/features/library.md). A template's roles come from
// role presets, and the presets are the built-in agents (docs/specs/features/builtin-crew.md): an
// agent fixes a role's tools, output contract, model slot, base instruction and skills. Its name
// and duty come from the Studio's messages, so the builders take the wording as input.

/** The built-in agents as role presets, in the order the spec lists them. */
export const ROLE_PRESET_IDS = [
  'architect',
  'builder',
  'investigator',
  'reviewer',
  'adversary',
  'verifier',
  'judge',
  'explainer',
  'researcher',
  'writer',
] as const;
export type RolePresetId = (typeof ROLE_PRESET_IDS)[number];

export interface RoleWording {
  name: string;
  duty: string;
}

export interface RolePreset {
  id: RolePresetId;
  modelProfile: 'model-a' | 'model-b';
  allowedWorkTools: readonly WorkTool[];
  allowedCollaborationTools: readonly CollaborationTool[];
  outputContract: OutputContract;
  /** The agent file's body: the base instruction before the common work rules. */
  prompt: string;
  skills: readonly RoleSkillRef[];
}

/** The tools that change the working copy or run commands; a read-only team has none of them. */
export const CHANGE_TOOLS = [
  'write_file',
  'delete_file',
  'move_file',
  'run_command',
  'preview_action',
] as const satisfies readonly WorkTool[];

function presetOf(id: RolePresetId): RolePreset {
  const agent = BUILTIN_AGENTS.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`there is no built-in agent ${id}`);
  return {
    id,
    modelProfile: agent.modelSlot === 'b' ? 'model-b' : 'model-a',
    allowedWorkTools: agent.workTools,
    allowedCollaborationTools: agent.collaborationTools,
    outputContract: agent.outputContract,
    prompt: agent.prompt,
    skills: agent.skills.map(({ resourceHash, entry }) => ({ resourceHash, entry })),
  };
}

/** The ten presets, read from the generated module of the built-in agents. */
export const ROLE_PRESETS: Readonly<Record<RolePresetId, RolePreset>> = Object.fromEntries(
  ROLE_PRESET_IDS.map((id) => [id, presetOf(id)]),
) as Record<RolePresetId, RolePreset>;

/** A built-in skill's ref, by its name. */
function builtinSkillRef(name: string): RoleSkillRef {
  const skill = BUILTIN_SKILLS.find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`there is no built-in skill ${name}`);
  return { resourceHash: skill.resourceHash, entry: skill.entry };
}

const sameSkill = (a: RoleSkillRef, b: RoleSkillRef) =>
  a.resourceHash === b.resourceHash && a.entry === b.entry;

/** The name of the built-in skill a ref points at, or null when it is not one. */
export function builtinSkillName(ref: RoleSkillRef): string | null {
  return BUILTIN_SKILLS.find((skill) => sameSkill(skill, ref))?.name ?? null;
}

/** What a seat may add to its agent: a built-in skill by name, and another model slot. */
export interface SeatAdditions {
  skills?: readonly string[];
  modelProfile?: RolePreset['modelProfile'];
}

const READ_NOTE =
  ' When the session has a working copy, read the files with the file tools before relying on them.';
const CHANGE_NOTE =
  ' Make the changes with the file tools, and say what you changed and how you checked it.';

/**
 * The preset's reusable settings: the agent's body and the common work rules as the base
 * instruction. The localized duty belongs to the seat, not the role.
 */
export function roleFromPreset(
  presetId: RolePresetId,
  roleId: string,
  name: string,
  seat: SeatAdditions = {},
): AgentRole {
  const chosen = ROLE_PRESETS[presetId];
  const writes = chosen.allowedWorkTools.includes('write_file');
  const skills = chosen.skills.map((ref) => ({ ...ref }));
  for (const ref of (seat.skills ?? []).map(builtinSkillRef))
    if (!skills.some((known) => sameSkill(known, ref))) skills.push(ref);
  return {
    id: roleId,
    name,
    prompt: `${chosen.prompt}\n\n${ROLE_RULES}${READ_NOTE}${writes ? CHANGE_NOTE : ''}`,
    modelProfile: seat.modelProfile ?? chosen.modelProfile,
    allowedWorkTools: [...chosen.allowedWorkTools],
    allowedCollaborationTools: [...chosen.allowedCollaborationTools],
    outputContract: chosen.outputContract,
    skills,
  };
}

/** No role can change files or run commands. A team without roles is not called read-only. */
export function isReadOnlyTeam(definition: Pick<CorralDefinition, 'roles'>): boolean {
  return (
    definition.roles.length > 0 &&
    definition.roles.every(
      (role) => !role.allowedWorkTools.some((tool) => CHANGE_TOOLS.includes(tool as never)),
    )
  );
}

export const TEAM_TEMPLATE_IDS = [
  'implement-review',
  'feature',
  'bug-fix',
  'refactor',
  'performance',
  'adversarial-review',
  'tech-decision',
  'code-investigation',
] as const;
export type TeamTemplateId = (typeof TEAM_TEMPLATE_IDS)[number];

/** Each template's roles in execution order, by role id, and the agent that fills each one. */
export const TEAM_TEMPLATE_ROLES = {
  'implement-review': { implement: 'builder', review: 'reviewer' },
  feature: { design: 'architect', implement: 'builder', verify: 'verifier' },
  'bug-fix': { investigate: 'investigator', fix: 'builder', verify: 'verifier' },
  refactor: { pin: 'builder', reshape: 'builder', verify: 'verifier' },
  performance: { baseline: 'investigator', improve: 'builder', measure: 'verifier' },
  'adversarial-review': {
    scope: 'explainer',
    attack_a: 'adversary',
    attack_b: 'adversary',
    verdict: 'judge',
  },
  'tech-decision': {
    frame: 'architect',
    option_a: 'researcher',
    option_b: 'researcher',
    decide: 'judge',
  },
  'code-investigation': {
    scope: 'explainer',
    trace: 'explainer',
    history: 'explainer',
    write: 'writer',
  },
} as const satisfies Record<TeamTemplateId, Readonly<Record<string, RolePresetId>>>;

type SeatsOf<T extends TeamTemplateId> = keyof (typeof TEAM_TEMPLATE_ROLES)[T];

/**
 * What a seat adds to its agent (library.md): the skill a seat cannot do without, and the
 * second model for the second of two seats that run side by side.
 */
const TEAM_TEMPLATE_SEATS: { [T in TeamTemplateId]?: Partial<Record<SeatsOf<T>, SeatAdditions>> } =
  {
    refactor: { pin: { skills: ['behavior-pin'] }, reshape: { skills: ['behavior-pin'] } },
    performance: { improve: { skills: ['measure-first'] } },
    'adversarial-review': { attack_b: { modelProfile: 'model-b' } },
    'tech-decision': { option_b: { modelProfile: 'model-b' } },
    'code-investigation': { history: { modelProfile: 'model-b' } },
  };

/** Labels of the steps that are not roles. */
export interface TeamTemplateLabels {
  loop: string;
  decision: string;
  /** The Loop and its decision where a verification seat judges the work. */
  verifyLoop: string;
  verifyDecision: string;
  join: string;
  output: string;
}

export interface TeamTemplateWording<T extends TeamTemplateId = TeamTemplateId> {
  name: string;
  brief: string;
  criteria: readonly string[];
  roles: { [K in SeatsOf<T>]: RoleWording };
  labels: TeamTemplateLabels;
}

/** A template as a new definition under `corralId`. Tools and wiring come from the template alone. */
export function teamTemplate<T extends TeamTemplateId>(
  id: T,
  corralId: string,
  wording: TeamTemplateWording<T>,
): CorralDefinition {
  const presets: Readonly<Record<string, RolePresetId>> = TEAM_TEMPLATE_ROLES[id];
  const seats: Readonly<Record<string, SeatAdditions | undefined>> = TEAM_TEMPLATE_SEATS[id] ?? {};
  const words = wording.roles as Readonly<Record<string, RoleWording | undefined>>;
  const roleWording = (roleId: string) => {
    const named = words[roleId];
    if (!named) throw new Error(`the ${id} wording has no ${roleId}`);
    return named;
  };
  const roles = Object.entries(presets).map(([roleId, presetId]) =>
    roleFromPreset(presetId, roleId, roleWording(roleId).name, seats[roleId]),
  );
  const shape = SHAPES[id](new Shape(roleWording, wording.labels));
  return {
    schemaVersion: '0.1',
    id: corralId,
    name: wording.name,
    entryNodeId: shape.entry,
    input: { brief: wording.brief, criteria: [...wording.criteria] },
    roles,
    nodes: shape.nodes,
    controlEdges: shape.edges,
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
  };
}

// ── shapes ───────────────────────────────────────────────────────────────────

const brief: InputBinding = { kind: 'run_input', name: 'brief' };
const criteria: InputBinding = { kind: 'run_input', name: 'criteria' };
const read = (sourceNodeId: string, name: string): InputBinding => ({
  kind: 'task_output',
  name,
  sourceNodeId,
});
const earlier = (sourceNodeId: string, name: string): InputBinding => ({
  kind: 'previous_iteration_output',
  name,
  sourceNodeId,
  optional: true,
});

/** Builds one template's nodes and edges; each agent node runs the role of the same id. */
class Shape {
  readonly nodes: CorralNode[] = [];
  readonly edges: ControlEdge[] = [];
  private readonly roleWording: (roleId: string) => RoleWording;
  private readonly labels: TeamTemplateLabels;
  constructor(roleWording: (roleId: string) => RoleWording, labels: TeamTemplateLabels) {
    this.roleWording = roleWording;
    this.labels = labels;
  }

  agent(id: string, inputBindings: InputBinding[], outputName: string, parentId?: string) {
    const { name, duty } = this.roleWording(id);
    this.nodes.push({
      id,
      type: 'agent',
      label: name,
      stepInstruction: duty,
      roleId: id,
      invocation: 'scheduled',
      inputBindings,
      outputName,
      ...(parentId ? { parentId } : {}),
    });
    return this;
  }

  edge(
    source: string,
    sourcePort: string,
    target: string,
    targetPort: ControlEdge['targetPort'] = 'in',
  ) {
    this.edges.push({ id: `e${this.edges.length + 1}`, source, sourcePort, target, targetPort });
    return this;
  }

  join(id: string) {
    this.nodes.push({ id, type: 'join', label: this.labels.join, policy: 'all' });
    return this;
  }

  output(source: string) {
    this.nodes.push({
      id: 'output',
      type: 'output',
      label: this.labels.output,
      inputBindings: [read(source, 'draft')],
      requireApproval: false,
    });
    return this;
  }

  /**
   * The judged Loop, as in a drafted team: `worker` makes the candidate and revises it from its
   * previous round and the judge's last word, `judge` checks it against the criteria, and the
   * decision sends it round again or out through `next`. The judge is the review seat, or a
   * verification seat in the templates that run what was made.
   */
  judgedLoop(
    worker: string,
    workerInputs: InputBinding[],
    { judge = 'review', judgeInputs = [], verifies = false }: JudgedLoop = {},
  ) {
    this.nodes.push({
      id: 'review_loop',
      type: 'loop',
      label: verifies ? this.labels.verifyLoop : this.labels.loop,
      maxIterations: 2,
    });
    this.agent(
      worker,
      [...workerInputs, earlier(worker, 'draft'), earlier(judge, judge)],
      'draft',
      'review_loop',
    );
    this.agent(
      judge,
      [read(worker, 'draft'), criteria, brief, ...judgeInputs],
      'review',
      'review_loop',
    );
    this.nodes.push({
      id: 'review_decision',
      type: 'decision',
      label: verifies ? this.labels.verifyDecision : this.labels.decision,
      parentId: 'review_loop',
      mode: 'review',
      rule: 'review_verdict',
      inputBindings: [read(judge, judge)],
    });
    return this.edge('review_loop', 'body', worker)
      .edge(worker, 'out', judge)
      .edge(judge, 'out', 'review_decision')
      .edge('review_decision', 'revise', 'review_loop', 'repeat')
      .edge('review_decision', 'pass', 'review_loop', 'exit');
  }

  /**
   * The Loop goes on to `target` whether its judge passed the work or its rounds ran out: at the
   * cap nobody is asked, and the last round's candidate goes on with its judgement.
   */
  afterLoop(target: string) {
    return this.edge('review_loop', 'next', target).edge('review_loop', 'exhausted', target);
  }

  /** A first step whose one output fans out to two seats at once; the Join waits for both. */
  sideBySide(
    first: string,
    second: string,
    inputs: InputBinding[],
    outputName: string,
    after: { id: string; inputs: InputBinding[]; outputName: string },
  ) {
    return this.agent(first, inputs, outputName)
      .agent(second, inputs, outputName)
      .join('gather')
      .agent(after.id, after.inputs, after.outputName)
      .output(after.id)
      .edge(first, 'out', 'gather')
      .edge(second, 'out', 'gather')
      .edge('gather', 'out', after.id)
      .edge(after.id, 'out', 'output');
  }
}

interface JudgedLoop {
  /** The seat that judges each round; its review is what the decision reads. */
  judge?: string;
  judgeInputs?: InputBinding[];
  /** A verification seat judges: the Loop and decision take the verification labels. */
  verifies?: boolean;
}

interface Built {
  entry: string;
  nodes: CorralNode[];
  edges: ControlEdge[];
}

const done = (shape: Shape, entry: string): Built => ({
  entry,
  nodes: shape.nodes,
  edges: shape.edges,
});

/** A first step, then the work in a Loop judged by a verification seat, then the Output. */
function verified(
  shape: Shape,
  first: { id: string; outputName: string; handoff: string },
  worker: string,
  judge: string,
): Built {
  const handoff = read(first.id, first.handoff);
  return done(
    shape
      .agent(first.id, [brief], first.outputName)
      .judgedLoop(worker, [brief, handoff], { judge, judgeInputs: [handoff], verifies: true })
      .output(worker)
      .edge(first.id, 'out', 'review_loop', 'enter')
      .afterLoop('output'),
    first.id,
  );
}

const SHAPES: Record<TeamTemplateId, (shape: Shape) => Built> = {
  // The builder works in the review Loop, so a sent-back change is fixed and reviewed again.
  'implement-review': (shape) =>
    done(
      shape.judgedLoop('implement', [brief]).output('implement').afterLoop('output'),
      'review_loop',
    ),
  feature: (shape) =>
    verified(
      shape,
      { id: 'design', outputName: 'notes', handoff: 'design' },
      'implement',
      'verify',
    ),
  'bug-fix': (shape) =>
    verified(shape, { id: 'investigate', outputName: 'notes', handoff: 'cause' }, 'fix', 'verify'),
  refactor: (shape) =>
    verified(shape, { id: 'pin', outputName: 'draft', handoff: 'pinned' }, 'reshape', 'verify'),
  performance: (shape) =>
    verified(
      shape,
      { id: 'baseline', outputName: 'notes', handoff: 'baseline' },
      'improve',
      'measure',
    ),
  // The scope's one output fans out to both challenges; the verdict keeps what they showed.
  'adversarial-review': (shape) =>
    done(
      shape
        .agent('scope', [brief], 'notes')
        .sideBySide('attack_a', 'attack_b', [read('scope', 'scope'), criteria, brief], 'notes', {
          id: 'verdict',
          inputs: [read('attack_a', 'attack_a'), read('attack_b', 'attack_b'), criteria, brief],
          outputName: 'draft',
        })
        .edge('scope', 'out', 'attack_a')
        .edge('scope', 'out', 'attack_b'),
      'scope',
    ),
  'tech-decision': (shape) =>
    done(
      shape
        .agent('frame', [brief], 'notes')
        .sideBySide('option_a', 'option_b', [read('frame', 'question'), brief], 'notes', {
          id: 'decide',
          inputs: [
            read('frame', 'question'),
            read('option_a', 'option_a'),
            read('option_b', 'option_b'),
            criteria,
            brief,
          ],
          outputName: 'draft',
        })
        .edge('frame', 'out', 'option_a')
        .edge('frame', 'out', 'option_b'),
      'frame',
    ),
  // How the code works and why it came to be that way, side by side, then one explanation.
  'code-investigation': (shape) =>
    done(
      shape
        .agent('scope', [brief], 'notes')
        .sideBySide('trace', 'history', [read('scope', 'scope'), brief], 'notes', {
          id: 'write',
          inputs: [
            read('scope', 'scope'),
            read('trace', 'trace'),
            read('history', 'history'),
            criteria,
            brief,
          ],
          outputName: 'draft',
        })
        .edge('scope', 'out', 'trace')
        .edge('scope', 'out', 'history'),
      'scope',
    ),
};
