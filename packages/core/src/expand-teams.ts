import {
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  CorralDefinition as Definition,
  type InputBinding,
  type OutputNode,
  type TeamNode,
} from '@corral/contracts';

// Reference Teams expand at run start (docs/specs/features/team-graph.md, "팀 실행"): the
// pinned saved team is copied into its Team box under `<Team id>.<id>`, and the run then
// executes it as an inline Team. The caller has compiled the definition with the same source,
// so every reference resolves and compiles on its own.

export type ResolveTeam = (corralId: string, definitionRevision: number) => unknown;

/** The definition with every reference Team, at any depth, expanded in place. */
export function expandReferences(
  definition: CorralDefinition,
  resolve: ResolveTeam,
): CorralDefinition {
  let doc = definition;
  for (const team of definition.nodes) {
    if (team.type !== 'team' || team.source.kind !== 'reference') continue;
    const { corralId, definitionRevision } = team.source;
    const saved = resolve(corralId, definitionRevision);
    if (saved === undefined || saved === null)
      throw new Error(`team ${corralId} revision ${definitionRevision} is not found`);
    doc = expandOne(doc, team, expandReferences(Definition.parse(saved), resolve));
  }
  return doc;
}

const isBox = (node: CorralNode | undefined) => node?.type === 'loop' || node?.type === 'team';

function expandOne(
  doc: CorralDefinition,
  team: TeamNode,
  saved: CorralDefinition,
): CorralDefinition {
  const name = (id: string) => `${team.id}.${id}`;
  const outputs = saved.nodes.filter((n): n is OutputNode => n.type === 'output');
  const outputIds = new Set(outputs.map((o) => o.id));
  const inputs = team.inputBindings ?? [];

  /** A saved binding as the expanded member reads it. */
  const inner = (binding: InputBinding): InputBinding[] => {
    if (binding.kind === 'run_input' && binding.name === 'brief' && inputs.length) return inputs;
    return [
      binding.sourceNodeId ? { ...binding, sourceNodeId: name(binding.sourceNodeId) } : binding,
    ];
  };
  // A callable member runs only when called and stays outside every box, as in the saved team.
  const placed = (node: CorralNode) =>
    node.type === 'agent' && node.invocation === 'callable'
      ? {}
      : { parentId: node.parentId ? name(node.parentId) : team.id };

  const members: CorralNode[] = [];
  for (const node of saved.nodes) {
    if (node.type === 'output') {
      // An Output that asked for approval stays as an approval before the Team's exit.
      if (node.requireApproval)
        members.push({
          id: name(node.id),
          type: 'decision',
          label: node.label,
          ...placed(node),
          mode: 'approval',
          rule: 'human_approval',
          inputBindings: node.inputBindings.flatMap(inner),
        });
      continue;
    }
    const { parentId: _parent, ...unplaced } = node;
    const base = { ...unplaced, id: name(node.id), ...placed(node) };
    switch (base.type) {
      case 'agent':
        members.push({
          ...base,
          roleId: name(base.roleId),
          inputBindings: base.inputBindings.flatMap(inner),
        });
        break;
      case 'decision':
        members.push({ ...base, inputBindings: base.inputBindings.flatMap(inner) } as CorralNode);
        break;
      case 'loop':
        members.push({
          ...base,
          ...(base.reviewRecipe
            ? {
                reviewRecipe: {
                  ...base.reviewRecipe,
                  candidateNodeId: name(base.reviewRecipe.candidateNodeId),
                  evaluatorRoleId: name(base.reviewRecipe.evaluatorRoleId),
                  ...(base.reviewRecipe.preparationNodeId
                    ? { preparationNodeId: name(base.reviewRecipe.preparationNodeId) }
                    : {}),
                },
              }
            : {}),
        });
        break;
      case 'team': {
        // Nested references are already expanded; an inline Team takes no inputs.
        const { inputBindings: _none, ...box } = base;
        members.push(box);
        break;
      }
      case 'join':
        members.push(base);
        break;
    }
  }

  const edges: ControlEdge[] = [
    {
      id: name('body'),
      source: team.id,
      sourcePort: 'body',
      target: name(saved.entryNodeId),
      targetPort: isBox(saved.nodes.find((n) => n.id === saved.entryNodeId)) ? 'enter' : 'in',
    },
  ];
  for (const edge of saved.controlEdges) {
    const output = outputIds.has(edge.target)
      ? outputs.find((o) => o.id === edge.target)
      : undefined;
    edges.push({
      ...edge,
      id: name(edge.id),
      source: name(edge.source),
      ...(output && !output.requireApproval
        ? { target: team.id, targetPort: 'exit' as const }
        : { target: name(edge.target) }),
    });
  }
  for (const output of outputs)
    if (output.requireApproval)
      edges.push({
        id: name(`${output.id}.approve`),
        source: name(output.id),
        sourcePort: 'approve',
        target: team.id,
        targetPort: 'exit',
      });

  // What the saved Outputs collect is what reading the Team gives.
  const collected = outputs.flatMap((o) => o.inputBindings.flatMap(inner));
  const several = outputs.length > 1;
  const reading = (binding: InputBinding): InputBinding[] =>
    binding.kind === 'task_output' && binding.sourceNodeId === team.id
      ? collected.map((b) => ({
          ...b,
          name: collected.length === 1 ? binding.name : `${binding.name}_${b.name}`,
          ...(binding.optional || several || b.optional ? { optional: true } : {}),
        }))
      : [binding];

  const { inputBindings: _inputs, ...box } = team;
  const nodes = doc.nodes.flatMap((node): CorralNode[] => {
    if (node.id === team.id) return [{ ...box, source: { kind: 'inline' } }, ...members];
    if (!('inputBindings' in node) || !node.inputBindings) return [node];
    return [{ ...node, inputBindings: node.inputBindings.flatMap(reading) } as CorralNode];
  });

  return {
    ...doc,
    roles: [...doc.roles, ...saved.roles.map((role) => ({ ...role, id: name(role.id) }))],
    nodes,
    controlEdges: [...doc.controlEdges, ...edges],
    capabilityLinks: [
      ...doc.capabilityLinks,
      ...saved.capabilityLinks.map((link) => ({
        ...link,
        id: name(link.id),
        sourceNodeId: name(link.sourceNodeId),
        targetNodeId: name(link.targetNodeId),
      })),
    ],
  };
}
