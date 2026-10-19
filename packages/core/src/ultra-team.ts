import {
  type CommandError,
  type CorralDefinition,
  ReasoningLevel,
  type RunLimits,
  UltraSelection,
  type UltraTeamSnapshot,
} from '@corral/contracts';
import type { BudgetState } from './budget.ts';
import type { ModelResolver } from './coordinator.ts';

export const ULTRA_STAGES = ['plan', 'write', 'synthesize', 'review'] as const;

/** Each unfinished mandatory role needs room to write and submit its result. No second ledger. */
export function ultraBudgetAllowance(
  state: BudgetState,
  limits: RunLimits,
  stage: (typeof ULTRA_STAGES)[number],
  optional: boolean,
  draining: boolean,
) {
  const heldCalls =
    (ULTRA_STAGES.length - 1 - ULTRA_STAGES.indexOf(stage) + (optional ? 1 : 0)) * 2;
  const charged = state.spent + state.reserved + state.unknownOutstanding;
  const cap = limits.maxOutputTokensPerCall;
  const stopOptional =
    draining ||
    state.modelCalls + heldCalls + 1 >= limits.maxModelCalls * 0.8 ||
    charged + (heldCalls + 1) * cap >= limits.maxOutputTokens * 0.8;
  return {
    draining: stopOptional,
    maxOutputTokens:
      (optional && stopOptional) || state.modelCalls >= limits.maxModelCalls - heldCalls
        ? 0
        : Math.max(0, Math.min(cap, limits.maxOutputTokens - charged - heldCalls * cap)),
  };
}

export type UltraResolution =
  | { ok: true; snapshot: UltraTeamSnapshot }
  | { ok: false; error: CommandError };

export function resolveUltraSelection(
  input: UltraSelection,
  primary: string,
  mode: 'mock' | 'live',
  models: ModelResolver,
): UltraResolution {
  const refuse = (message: string): UltraResolution => ({
    ok: false,
    error: { code: 'CAPABILITY_DENIED', message },
  });
  const parsed = UltraSelection.safeParse(input);
  if (!parsed.success) return refuse('Ultra needs a versioned pool of two to five model profiles');
  const selection = parsed.data;
  if (
    new Set(selection.modelProfiles).size !== selection.modelProfiles.length ||
    !selection.modelProfiles.includes(primary) ||
    !selection.modelProfiles.includes(selection.verifierProfile) ||
    selection.verifierProfile === primary
  )
    return refuse('Ultra needs the primary model and a different verifier in its selected pool');
  const reasoning: UltraTeamSnapshot['reasoning'] = {};
  const identities = new Set<string>();
  for (const profile of selection.modelProfiles) {
    const resolution = models.resolve(profile, mode);
    if (!resolution.ok) return refuse(`${profile}: ${resolution.reason}`);
    const model = resolution.snapshot;
    const identity = model.auth === 'mock' ? profile : model.modelId;
    if (!identity || identities.has(identity))
      return refuse(
        'Ultra requires distinct configured model IDs; profile aliases are the same model',
      );
    identities.add(identity);
    const level =
      model.auth === 'mock'
        ? 'max'
        : ReasoningLevel.options.findLast((item) => model.reasoning?.levels.includes(item));
    if (!level || (model.auth !== 'mock' && !model.reasoning?.identity))
      return refuse(`${profile}: maximum supported reasoning has not been verified for this model`);
    reasoning[profile] = level;
  }
  return { ok: true, snapshot: { ...selection, reasoning } };
}

/** Extend the unchanged legacy recipe using ordinary roles, graph edges and callable nodes. */
export function applyUltraTeam(base: CorralDefinition, ultra: UltraTeamSnapshot): CorralDefinition {
  const primary = base.roles.find((role) => role.id === 'writer')!.modelProfile;
  const roles = base.roles.map((role) => {
    const profile = role.id === 'reviewer' ? ultra.verifierProfile : primary;
    return {
      ...role,
      prompt: `${role.prompt} Model review is not an executed project check. Report which checks have actual execution evidence, or state that they were not run. Never infer test success from a model verdict.`,
      modelProfile: profile,
      reasoning: { mode: 'fixed' as const, level: ultra.reasoning[profile]! },
    };
  });
  roles.push({
    ...roles.find((role) => role.id === 'writer')!,
    id: 'synthesizer',
    name: 'Synthesizer',
    prompt:
      'Combine the writer result and supplied evidence into the final answer. Preserve exact artifact references and distinguish unverified claims. Do not change project files; the next model reviews this exact output. Report project checks only when their execution evidence is supplied; otherwise state they were not run.',
    allowedWorkTools: ['write_artifact'],
    allowedCollaborationTools: ['read_artifact', 'submit_result'],
  });
  const helpers = ultra.modelProfiles.filter((profile) => profile !== primary);
  for (const [index, profile] of helpers.entries())
    roles.push({
      id: `specialist_${index}`,
      name: `Specialist ${index + 1}`,
      modelProfile: profile,
      prompt:
        'Independently analyze the delegated task and supplied evidence. Return concise findings and exact source references. State missing evidence. You cannot change files or delegate further.',
      reasoning: { mode: 'fixed', level: ultra.reasoning[profile]! },
      allowedWorkTools: ['write_artifact'],
      allowedCollaborationTools: ['read_artifact', 'submit_result'],
      outputContract: 'notes',
    });
  for (const role of roles)
    if (role.id === 'planner' || role.id === 'writer') {
      role.allowedCollaborationTools.push('spawn_subagents', 'await_tasks');
      role.prompt +=
        ' Use the selected specialists for independent parallel analysis when useful. At most two children may run at once and four delegations total. Supply only the task and necessary evidence; no raw conversations or private reasoning. Continue honestly if an optional specialist fails. Synthesis and cross-model verification remain mandatory.';
    }
  const nodes = base.nodes.map((node) => {
    if (node.type === 'loop' && node.reviewRecipe)
      return {
        ...node,
        reviewRecipe: {
          ...node.reviewRecipe,
          recipeId: 'ultra_collaboration',
          candidateNodeId: 'synthesize',
          preparationNodeId: 'write',
        },
      };
    if ((node.type === 'agent' && node.id === 'review') || node.type === 'output')
      return {
        ...node,
        inputBindings: node.inputBindings.map((binding) =>
          binding.kind === 'task_output' && binding.sourceNodeId === 'write'
            ? { ...binding, sourceNodeId: 'synthesize' }
            : binding,
        ),
      };
    return node;
  });
  nodes.push({
    id: 'synthesize',
    type: 'agent',
    label: 'Synthesize',
    loopId: 'review_loop',
    roleId: 'synthesizer',
    invocation: 'scheduled',
    outputName: 'draft',
    inputBindings: [
      { kind: 'task_output', name: 'draft', sourceNodeId: 'write' },
      { kind: 'run_input', name: 'brief' },
      { kind: 'run_input', name: 'criteria' },
      { kind: 'task_output', name: 'plan', sourceNodeId: 'plan' },
    ],
  });
  for (const [index] of helpers.entries())
    nodes.push({
      id: `specialist_${index}`,
      type: 'agent',
      label: `Specialist ${index + 1}`,
      roleId: `specialist_${index}`,
      invocation: 'callable',
      inputBindings: [],
      outputName: 'notes',
    });
  return {
    ...base,
    name: 'Ultra · multi-model collaboration',
    roles,
    nodes,
    limits: { ...base.limits, maxSpawns: 4 },
    controlEdges: [
      ...base.controlEdges.map((edge) =>
        edge.source === 'write' && edge.target === 'review'
          ? { ...edge, target: 'synthesize' }
          : edge,
      ),
      {
        id: 'ultra_synthesis_review',
        source: 'synthesize',
        sourcePort: 'out',
        target: 'review',
        targetPort: 'in',
      },
    ],
    capabilityLinks: helpers.flatMap((_, index) =>
      ['plan', 'write'].map((sourceNodeId) => ({
        id: `ultra_${sourceNodeId}_${index}`,
        kind: 'delegate' as const,
        sourceNodeId,
        targetNodeId: `specialist_${index}`,
      })),
    ),
  };
}
