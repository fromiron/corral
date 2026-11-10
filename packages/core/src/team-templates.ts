import {
  type AgentRole,
  type CollaborationTool,
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  DEFAULT_LIMITS,
  FILE_TOOLS,
  type InputBinding,
  type OutputContract,
  type WorkTool,
} from '@corral/contracts';
import { rolePrompt } from './role-prompt.ts';

// The library's team templates (docs/specs/features/library.md). A template's roles come from
// role presets: a preset fixes a role's tools, output contract and model slot; its name and duty
// come from the Studio's messages, so the builders take the wording as input.

export const ROLE_PRESET_IDS = [
  'implement',
  'plan',
  'review',
  'investigate',
  'correctness_review',
  'security_review',
  'research',
  'write',
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
}

/** The tools that change the working copy or run commands; a read-only team has none of them. */
export const CHANGE_TOOLS = [
  'write_file',
  'delete_file',
  'move_file',
  'run_command',
  'preview_action',
] as const satisfies readonly WorkTool[];

// As in auto mode: the role that changes files gets the file, command and preview tools; the
// others read the working copy and preview files.
const CHANGES: readonly WorkTool[] = [
  'write_artifact',
  ...FILE_TOOLS,
  'preview_file',
  'run_command',
  'preview_app',
  'preview_action',
];
const READS: readonly WorkTool[] = ['write_artifact', 'list_files', 'read_file', 'preview_file'];
const COLLABORATION: readonly CollaborationTool[] = ['read_artifact', 'submit_result', 'ask_user'];

const preset = (
  id: RolePresetId,
  outputContract: OutputContract,
  modelProfile: RolePreset['modelProfile'] = 'model-a',
): RolePreset => ({
  id,
  modelProfile,
  allowedWorkTools: id === 'implement' ? CHANGES : READS,
  allowedCollaborationTools: COLLABORATION,
  outputContract,
});

/** The eight presets; a later step lets the team editor bring one in as a role. */
export const ROLE_PRESETS: Readonly<Record<RolePresetId, RolePreset>> = {
  implement: preset('implement', 'draft'),
  plan: preset('plan', 'notes'),
  review: preset('review', 'review', 'model-b'),
  investigate: preset('investigate', 'notes'),
  correctness_review: preset('correctness_review', 'review', 'model-b'),
  security_review: preset('security_review', 'review', 'model-b'),
  research: preset('research', 'notes'),
  write: preset('write', 'draft'),
};

const READ_NOTE =
  ' When the session has a working copy, read the files with the file tools before relying on them.';
const CHANGE_NOTE =
  ' Make the changes with the file tools, and say what you changed and how you checked it.';

/** A role from a preset, under `roleId`, with the name and duty in the screen language. */
export function roleFromPreset(
  presetId: RolePresetId,
  roleId: string,
  wording: RoleWording,
): AgentRole {
  const chosen = ROLE_PRESETS[presetId];
  const changes = chosen.allowedWorkTools.some((tool) => CHANGE_TOOLS.includes(tool as never));
  return {
    id: roleId,
    name: wording.name,
    prompt: `${rolePrompt(wording.duty)}${READ_NOTE}${changes ? CHANGE_NOTE : ''}`,
    modelProfile: chosen.modelProfile,
    allowedWorkTools: [...chosen.allowedWorkTools],
    allowedCollaborationTools: [...chosen.allowedCollaborationTools],
    outputContract: chosen.outputContract,
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
  'plan-implement-review',
  'bug-fix',
  'parallel-review',
  'tech-decision',
] as const;
export type TeamTemplateId = (typeof TEAM_TEMPLATE_IDS)[number];

/** Each template's roles in execution order, by role id, and the preset each one comes from. */
export const TEAM_TEMPLATE_ROLES = {
  'implement-review': { implement: 'implement', review: 'review' },
  'plan-implement-review': { plan: 'plan', implement: 'implement', review: 'review' },
  'bug-fix': { investigate: 'investigate', fix: 'implement', review: 'review' },
  'parallel-review': {
    scope: 'plan',
    correctness: 'correctness_review',
    security: 'security_review',
    synthesis: 'write',
  },
  'tech-decision': {
    frame: 'plan',
    research_a: 'research',
    research_b: 'research',
    compare: 'write',
  },
} as const satisfies Record<TeamTemplateId, Readonly<Record<string, RolePresetId>>>;

/** Labels of the steps that are not roles. */
export interface TeamTemplateLabels {
  loop: string;
  decision: string;
  join: string;
  output: string;
}

export interface TeamTemplateWording<T extends TeamTemplateId = TeamTemplateId> {
  name: string;
  brief: string;
  criteria: readonly string[];
  roles: { [K in keyof (typeof TEAM_TEMPLATE_ROLES)[T]]: RoleWording };
  labels: TeamTemplateLabels;
}

/** A template as a new definition under `corralId`. Tools and wiring come from the template alone. */
export function teamTemplate<T extends TeamTemplateId>(
  id: T,
  corralId: string,
  wording: TeamTemplateWording<T>,
): CorralDefinition {
  const presets: Readonly<Record<string, RolePresetId>> = TEAM_TEMPLATE_ROLES[id];
  const words = wording.roles as Readonly<Record<string, RoleWording | undefined>>;
  const roles = Object.entries(presets).map(([roleId, presetId]) => {
    const named = words[roleId];
    if (!named) throw new Error(`the ${id} wording has no ${roleId}`);
    return roleFromPreset(presetId, roleId, named);
  });
  const name = (roleId: string) => words[roleId]?.name ?? roleId;
  const shape = SHAPES[id](new Shape(name, wording.labels));
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
  private readonly roleName: (roleId: string) => string;
  private readonly labels: TeamTemplateLabels;
  constructor(roleName: (roleId: string) => string, labels: TeamTemplateLabels) {
    this.roleName = roleName;
    this.labels = labels;
  }

  agent(id: string, inputBindings: InputBinding[], outputName: string, parentId?: string) {
    this.nodes.push({
      id,
      type: 'agent',
      label: this.roleName(id),
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
   * The review Loop, as in a drafted team: `worker` makes the candidate and revises it from the
   * previous round's review, `review` checks it against the criteria, and the review decision
   * sends it round again or out through `next`.
   */
  reviewLoop(worker: string, workerInputs: InputBinding[], reviewInputs: InputBinding[] = []) {
    this.nodes.push({
      id: 'review_loop',
      type: 'loop',
      label: this.labels.loop,
      maxIterations: 2,
    });
    this.agent(
      worker,
      [...workerInputs, earlier(worker, 'draft'), earlier('review', 'review')],
      'draft',
      'review_loop',
    );
    this.agent(
      'review',
      [read(worker, 'draft'), criteria, brief, ...reviewInputs],
      'review',
      'review_loop',
    );
    this.nodes.push({
      id: 'review_decision',
      type: 'decision',
      label: this.labels.decision,
      parentId: 'review_loop',
      mode: 'review',
      rule: 'review_verdict',
      inputBindings: [read('review', 'review')],
    });
    return this.edge('review_loop', 'body', worker)
      .edge(worker, 'out', 'review')
      .edge('review', 'out', 'review_decision')
      .edge('review_decision', 'revise', 'review_loop', 'repeat')
      .edge('review_decision', 'pass', 'review_loop', 'exit');
  }
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

const SHAPES: Record<TeamTemplateId, (shape: Shape) => Built> = {
  // The implementer works in the review Loop, so a sent-back change is fixed and reviewed again.
  'implement-review': (shape) =>
    done(
      shape
        .reviewLoop('implement', [brief])
        .output('implement')
        .edge('review_loop', 'next', 'output'),
      'review_loop',
    ),
  'plan-implement-review': (shape) =>
    done(
      shape
        .agent('plan', [brief], 'notes')
        .reviewLoop('implement', [brief, read('plan', 'plan')])
        .output('implement')
        .edge('plan', 'out', 'review_loop', 'enter')
        .edge('review_loop', 'next', 'output'),
      'plan',
    ),
  'bug-fix': (shape) =>
    done(
      shape
        .agent('investigate', [brief], 'notes')
        .reviewLoop('fix', [brief, read('investigate', 'cause')], [read('investigate', 'cause')])
        .output('fix')
        .edge('investigate', 'out', 'review_loop', 'enter')
        .edge('review_loop', 'next', 'output'),
      'investigate',
    ),
  // The scope's one output fans out to both reviews; the Join waits for both.
  'parallel-review': (shape) =>
    done(
      shape
        .agent('scope', [brief], 'notes')
        .agent('correctness', [read('scope', 'scope'), criteria, brief], 'review')
        .agent('security', [read('scope', 'scope'), criteria, brief], 'review')
        .join('gather')
        .agent(
          'synthesis',
          [read('correctness', 'correctness'), read('security', 'security'), criteria, brief],
          'draft',
        )
        .output('synthesis')
        .edge('scope', 'out', 'correctness')
        .edge('scope', 'out', 'security')
        .edge('correctness', 'out', 'gather')
        .edge('security', 'out', 'gather')
        .edge('gather', 'out', 'synthesis')
        .edge('synthesis', 'out', 'output'),
      'scope',
    ),
  'tech-decision': (shape) =>
    done(
      shape
        .agent('frame', [brief], 'notes')
        .agent('research_a', [read('frame', 'question'), brief], 'notes')
        .agent('research_b', [read('frame', 'question'), brief], 'notes')
        .join('gather')
        .agent(
          'compare',
          [
            read('frame', 'question'),
            read('research_a', 'option_a'),
            read('research_b', 'option_b'),
            criteria,
            brief,
          ],
          'draft',
        )
        .output('compare')
        .edge('frame', 'out', 'research_a')
        .edge('frame', 'out', 'research_b')
        .edge('research_a', 'out', 'gather')
        .edge('research_b', 'out', 'gather')
        .edge('gather', 'out', 'compare')
        .edge('compare', 'out', 'output'),
      'frame',
    ),
};
