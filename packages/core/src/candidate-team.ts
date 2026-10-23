import { type CorralDefinition, FILE_TOOLS, type UltraTeamSnapshot } from '@corral/contracts';

const CANDIDATE_NODES = new Set([
  'review_loop',
  'write',
  'synthesize',
  'review',
  'review_decision',
]);
const CANDIDATE_ROLES = new Set(['writer', 'synthesizer', 'reviewer']);
const CANDIDATE_TOOLS = new Set<string>(['write_artifact', ...FILE_TOOLS]);

const JUDGE_PROMPT =
  'You judge anonymous candidates for the task in your inputs. Candidates are labelled A–E; you are not told who or which model wrote them, and must not guess. Read the `tournament` input: it says whether you choose among candidates (kind "selection") or compare a proposed refinement with the accepted version (kind "refinement"), and gives the exact JSON shape to write. Judge only from the supplied diffs, reports and check results against the criteria. A failed or missing check is never outweighed by your opinion. Write that JSON alone as your artifact, without prose or code fences, then submit it.';

export function candidateNumber(id: string): number | null {
  const match =
    /^(?:review_loop|write|synthesize|review|review_decision|writer|synthesizer|reviewer)_([1-5])$/.exec(
      id,
    );
  return match ? Number(match[1]) : null;
}

/** Fixed branches share only the plan; the Coordinator admits their bounded execution. */
export function applyCandidateTeam(
  base: CorralDefinition,
  ultra: UltraTeamSnapshot,
): CorralDefinition {
  if (!ultra.comparison) return base;
  const roles = base.roles
    .filter((role) => !CANDIDATE_ROLES.has(role.id))
    .map((role) => ({
      ...role,
      allowedWorkTools: role.allowedWorkTools.filter((tool) => CANDIDATE_TOOLS.has(tool)),
    }));
  const nodes = base.nodes
    .filter((node) => !CANDIDATE_NODES.has(node.id))
    .map((node) =>
      node.type === 'output'
        ? {
            ...node,
            inputBindings: node.inputBindings.map((binding) =>
              binding.sourceNodeId === 'synthesize'
                ? { ...binding, sourceNodeId: 'synthesize_1' }
                : binding,
            ),
          }
        : node,
    );
  const controlEdges: CorralDefinition['controlEdges'] = [];
  for (const [index, profile] of ultra.comparison.modelProfiles.entries()) {
    const number = index + 1;
    const scoped = (id: string) => `${id}_${number}`;
    const reviewer =
      ultra.verifierProfile === profile
        ? ultra.modelProfiles.find((item) => item !== profile)!
        : ultra.verifierProfile;
    for (const role of base.roles.filter((item) => CANDIDATE_ROLES.has(item.id))) {
      const modelProfile = role.id === 'reviewer' ? reviewer : profile;
      roles.push({
        ...role,
        id: scoped(role.id),
        name: `${role.name} · ${number}`,
        modelProfile,
        reasoning: { mode: 'fixed', level: ultra.reasoning[modelProfile]! },
        allowedWorkTools: role.allowedWorkTools.filter((tool) => CANDIDATE_TOOLS.has(tool)),
        allowedCollaborationTools: role.allowedCollaborationTools.filter(
          (tool) => tool !== 'spawn_subagents' && tool !== 'await_tasks',
        ),
      });
    }
    for (const node of base.nodes.filter((item) => CANDIDATE_NODES.has(item.id))) {
      const identity = { id: scoped(node.id), label: `${node.label} · ${number}` };
      if (node.type === 'loop') {
        nodes.push({
          ...node,
          ...identity,
          ...(node.reviewRecipe
            ? {
                reviewRecipe: {
                  ...node.reviewRecipe,
                  recipeId: scoped(node.reviewRecipe.recipeId),
                  candidateNodeId: scoped(node.reviewRecipe.candidateNodeId),
                  ...(node.reviewRecipe.preparationNodeId
                    ? { preparationNodeId: scoped(node.reviewRecipe.preparationNodeId) }
                    : {}),
                  evaluatorRoleId: scoped(node.reviewRecipe.evaluatorRoleId),
                },
              }
            : {}),
        });
      } else if (node.type === 'agent' || node.type === 'decision') {
        nodes.push({
          ...node,
          ...identity,
          ...(node.loopId ? { loopId: scoped(node.loopId) } : {}),
          ...(node.type === 'agent' ? { roleId: scoped(node.roleId) } : {}),
          inputBindings: node.inputBindings.map((binding) =>
            binding.sourceNodeId && CANDIDATE_NODES.has(binding.sourceNodeId)
              ? { ...binding, sourceNodeId: scoped(binding.sourceNodeId) }
              : binding,
          ),
        });
      }
    }
    controlEdges.push(
      ...base.controlEdges
        .filter((edge) => CANDIDATE_NODES.has(edge.source) && CANDIDATE_NODES.has(edge.target))
        .map((edge) => ({
          ...edge,
          id: scoped(edge.id),
          source: scoped(edge.source),
          target: scoped(edge.target),
        })),
      {
        id: `candidate_enter_${number}`,
        source: number === 1 ? 'plan' : `review_loop_${number - 1}`,
        sourcePort: number === 1 ? 'out' : 'next',
        target: scoped('review_loop'),
        targetPort: 'enter',
      },
    );
  }
  const last = `review_loop_${ultra.comparison.modelProfiles.length}`;
  if (ultra.version === 2) {
    // CR-048: the verifier judges anonymous passing candidates and each refinement round.
    const reviewer = base.roles.find((role) => role.id === 'reviewer')!;
    roles.push({
      ...reviewer,
      id: 'judge',
      name: 'Judge',
      modelProfile: ultra.verifierProfile,
      reasoning: { mode: 'fixed', level: ultra.reasoning[ultra.verifierProfile]! },
      prompt: JUDGE_PROMPT,
      outputContract: 'notes',
      allowedWorkTools: ['write_artifact'],
      allowedCollaborationTools: ['submit_result'],
    });
    nodes.push({
      id: 'judge',
      type: 'agent',
      label: 'Judge',
      roleId: 'judge',
      invocation: 'scheduled',
      outputName: 'judgment',
      inputBindings: [
        { kind: 'run_input', name: 'brief' },
        { kind: 'run_input', name: 'criteria' },
      ],
    });
    controlEdges.push(
      {
        id: 'candidate_judge',
        source: last,
        sourcePort: 'next',
        target: 'judge',
        targetPort: 'in',
      },
      {
        id: 'judge_output',
        source: 'judge',
        sourcePort: 'out',
        target: 'output',
        targetPort: 'in',
      },
    );
  } else
    controlEdges.push({
      id: 'candidate_output',
      source: last,
      sourcePort: 'next',
      target: 'output',
      targetPort: 'in',
    });
  return {
    ...base,
    name: 'Ultra · candidate comparison',
    roles,
    nodes,
    controlEdges,
    capabilityLinks: [],
  };
}
