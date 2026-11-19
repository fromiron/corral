import {
  type AgentRole,
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  canonicalJson,
  type InputBinding,
  isWorkAgent,
  type OutputNode,
  type RoleOrigin,
  SharedOutrider,
  type TargetPort,
} from '@corral/contracts';
import {
  boxBoundaryViolation,
  type CompileOptions,
  compileDefinition,
  DECISION_RULE,
  type Diagnostic,
  inputPortsOf,
  isBox,
  isWithin,
  outputPortsOf,
  outputSources,
  reviewedOutputBinding,
  type SharedOutriderTarget,
  sourceSide,
  wouldCreateCycle,
} from '@corral/core';
import {
  addAdvisor,
  addNode,
  duplicateNode,
  type EditorDraft,
  watchAgent as linkWatch,
  newWorkAgent,
  nextId,
  removeNode,
  sameRoleField,
  updateNode,
  withDefinition,
  withSuggestedBinding,
} from '../editor/model.ts';

// Structural edits for the team editor (docs/specs/features/team-graph.md). Every gesture is a
// pure function of the draft: the canvas, the structure tree and the command menu only choose
// which one to call. Layout is automatic, so none of these take a position.

export type StepKind =
  | 'agent'
  /** An advisor: an agent outside the flow that watches others (features/advisor.md). */
  | 'observer'
  | 'review'
  | 'approval'
  | 'rule'
  | 'check'
  | 'router'
  | 'loop'
  | 'team'
  | 'join'
  | 'output';

/** A graph placement, or the shared approach to a composition's final Output. */
export type Placement =
  | { kind: 'empty' }
  | { kind: 'edge'; edgeId: string }
  | { kind: 'beforeOutput'; outputId: string }
  | { kind: 'after'; nodeId: string }
  | { kind: 'into'; boxId: string };

export type EditRejection =
  | 'unknownConnection'
  | 'unknownNode'
  | 'selfConnection'
  | 'callableInControlFlow'
  | 'invalidSourcePort'
  | 'invalidTargetPort'
  | 'invalidResultSource'
  | 'invalidResultInput'
  | 'duplicate'
  | 'boxBoundary'
  | 'cycle'
  | 'repeatNeedsDecision'
  | 'noNextStep'
  | 'mixedBoxes'
  | 'notABox'
  | 'noPredecessor'
  | 'oneAgentOnly'
  | 'roleNeedsAgent'
  | 'movePlanOwner'
  | 'replacementCompileError'
  | 'advisorOutsideBoxes'
  | 'watchNeedsAdvisor'
  | 'watchNeedsAgent'
  | 'advisorRole'
  | 'invalidSharedOutrider'
  | 'requiredReviewNeedsSource'
  | 'requiredReviewNeedsOutrider';

export type EditResult = { ok: true; draft: EditorDraft; nodeId?: string } | EditFailure;

type EditFailure =
  | { ok: false; reason: Exclude<EditRejection, 'replacementCompileError'> }
  | { ok: false; reason: 'replacementCompileError'; diagnostic: Diagnostic };

/** A selected target list is a set; picking the same workers in another order is no edit. */
function orderedOutriderSettings(settings: SharedOutrider): SharedOutrider {
  const ordered = (scope: SharedOutrider['targets']): SharedOutrider['targets'] =>
    scope.kind === 'all'
      ? scope
      : { kind: 'selected', nodeIds: [...new Set(scope.nodeIds)].sort() };
  return {
    ...settings,
    targets: ordered(settings.targets),
    ...(settings.observation
      ? { observation: { ...settings.observation, targets: ordered(settings.observation.targets) } }
      : {}),
  };
}

/** Store only the authored intent. The runtime derives the callable and its grants on its copy. */
export function setSharedOutrider(draft: EditorDraft, settings: SharedOutrider | null): EditResult {
  const current = draft.definition.sharedOutrider;
  if (settings === null) {
    if (!current) return { ok: true, draft };
    const { sharedOutrider: _removed, ...definition } = draft.definition;
    return { ok: true, draft: { ...draft, definition } };
  }
  const parsed = SharedOutrider.safeParse(settings);
  if (!parsed.success) return { ok: false, reason: 'invalidSharedOutrider' };
  const next = orderedOutriderSettings(parsed.data);
  if (current && canonicalJson(orderedOutriderSettings(current)) === canonicalJson(next))
    return { ok: true, draft };
  return {
    ok: true,
    draft: { ...draft, definition: { ...draft.definition, sharedOutrider: next } },
  };
}

/**
 * Another saved team of the project at its latest saved revision: added as a Team box that runs
 * that revision, or a place to copy a role from.
 */
export interface TeamReference {
  corralId: string;
  definitionRevision: number;
  name: string;
  /** The roles of that revision, once the host has read them. */
  roles?: readonly AgentRole[];
}

export interface PortRequest {
  source: string;
  sourcePort: string;
  target: string;
  targetPort: TargetPort;
}

const nodesOf = (definition: CorralDefinition) => new Map(definition.nodes.map((n) => [n.id, n]));
const isAdvisor = (node: CorralNode | undefined) =>
  node?.type === 'agent' && node.invocation === 'observer';

/** The port a step continues from: agent and join `out`, a decision's first branch, a box's `next`. */
export function primaryOut(node: CorralNode): string | null {
  if (node.type === 'output') return null;
  if (node.type === 'loop' || node.type === 'team') return 'next';
  return outputPortsOf(node)[0] ?? null;
}

/** The port a step is entered through. */
export function primaryIn(node: CorralNode): TargetPort | null {
  if (node.type === 'loop' || node.type === 'team') return 'enter';
  return inputPortsOf(node)[0] ?? null;
}

// ── connections ──────────────────────────────────────────────────────────────

/** The connection rule while dragging a port and after dropping it. One port may fan out. */
export function checkPorts(
  draft: EditorDraft,
  request: PortRequest,
  replaceEdgeId?: string,
): { ok: true } | { ok: false; reason: Exclude<EditRejection, 'replacementCompileError'> } {
  const { definition } = draft;
  const old =
    replaceEdgeId === undefined
      ? undefined
      : definition.controlEdges.find((edge) => edge.id === replaceEdgeId);
  if (
    replaceEdgeId !== undefined &&
    (!old || old.source !== request.source || old.sourcePort !== request.sourcePort)
  )
    return { ok: false, reason: 'unknownConnection' };
  const remaining = old
    ? definition.controlEdges.filter((edge) => edge.id !== old.id)
    : definition.controlEdges;
  const nodes = nodesOf(definition);
  const source = nodes.get(request.source);
  const target = nodes.get(request.target);
  if (!source || !target) return { ok: false, reason: 'unknownNode' };
  if (source.id === target.id && !isBox(source)) return { ok: false, reason: 'selfConnection' };
  const callable = (n: CorralNode) => n.type === 'agent' && n.invocation === 'callable';
  if (callable(source) || callable(target)) return { ok: false, reason: 'callableInControlFlow' };
  if (!outputPortsOf(source).includes(request.sourcePort))
    return { ok: false, reason: 'invalidSourcePort' };
  if (!inputPortsOf(target).includes(request.targetPort))
    return { ok: false, reason: 'invalidTargetPort' };
  if (
    remaining.some(
      (e) =>
        e.source === request.source &&
        e.sourcePort === request.sourcePort &&
        e.target === request.target &&
        e.targetPort === request.targetPort,
    )
  )
    return { ok: false, reason: 'duplicate' };
  if (boxBoundaryViolation(nodes, request)) return { ok: false, reason: 'boxBoundary' };
  if (request.targetPort === 'repeat' && source.type !== 'decision')
    return { ok: false, reason: 'repeatNeedsDecision' };
  if (wouldCreateCycle(definition.nodes, remaining, request)) return { ok: false, reason: 'cycle' };
  return { ok: true };
}

export function connectPorts(
  draft: EditorDraft,
  request: PortRequest,
  replaceEdgeId?: string,
): EditResult {
  const check = checkPorts(draft, request, replaceEdgeId);
  if (!check.ok) return check;
  if (replaceEdgeId !== undefined) {
    const old = draft.definition.controlEdges.find((e) => e.id === replaceEdgeId);
    if (old?.target === request.target && old.targetPort === request.targetPort)
      return { ok: true, draft };
    const controlEdges = draft.definition.controlEdges.map((e) =>
      e.id === replaceEdgeId ? { ...e, ...request } : e,
    );
    const definition = withSuggestedBinding({ ...draft.definition, controlEdges }, request.target);
    return { ok: true, draft: withDefinition(draft, definition) };
  }
  const { id, counters } = nextId(draft, 'edge');
  let definition: CorralDefinition = {
    ...draft.definition,
    controlEdges: [...draft.definition.controlEdges, { id, ...request }],
  };
  definition = withSuggestedBinding(definition, request.target);
  return { ok: true, draft: withDefinition({ ...draft, counters }, definition) };
}

// ── adding steps ─────────────────────────────────────────────────────────────

function createStep(
  draft: EditorDraft,
  kind: Exclude<StepKind, 'observer'>,
  parentId: string | null,
  reference?: TeamReference,
  decisionLabel?: string,
): { draft: EditorDraft; nodeId: string } {
  const placed = (
    created: { draft: EditorDraft; nodeId: string },
    patch: (node: CorralNode) => CorralNode = (node) => node,
  ) => {
    const nodes = created.draft.definition.nodes.map((node) =>
      node.id === created.nodeId ? patch(parentId ? { ...node, parentId } : node) : node,
    );
    return {
      nodeId: created.nodeId,
      draft: withDefinition(created.draft, { ...created.draft.definition, nodes }),
    };
  };
  const fresh = (prefix: string, build: (id: string, index: number) => CorralNode) => {
    const { id, counters } = nextId(draft, prefix);
    const node = build(id, counters[prefix] as number);
    return placed({
      nodeId: id,
      draft: {
        ...draft,
        counters,
        definition: { ...draft.definition, nodes: [...draft.definition.nodes, node] },
      },
    });
  };
  const numbered = (base: string, index: number) => (index === 1 ? base : `${base} ${index}`);
  switch (kind) {
    case 'agent':
    case 'output':
      return placed(addNode(draft, kind));
    case 'loop':
      return placed(addNode(draft, 'loop'), (node) =>
        node.type === 'loop' ? { ...node, maxIterations: 3 } : node,
      );
    case 'review':
    case 'approval':
    case 'rule':
      return placed(addNode(draft, 'decision'), (node) =>
        node.type === 'decision'
          ? {
              id: node.id,
              type: 'decision',
              label: numbered(
                decisionLabel ?? { review: 'Review', approval: 'Approval', rule: 'Rule' }[kind],
                draft.definition.nodes.filter((n) => n.type === 'decision' && n.mode === kind)
                  .length + 1,
              ),
              ...(node.parentId ? { parentId: node.parentId } : {}),
              mode: kind,
              rule: DECISION_RULE[kind],
              inputBindings: node.inputBindings,
            }
          : node,
      );
    case 'check':
      return fresh('check', (id, index) => ({
        id,
        type: 'decision',
        label: numbered('Check', index),
        mode: 'check',
        checkIds: ['tests'],
        inputBindings: [],
      }));
    case 'router':
      return fresh('router', (id, index) => ({
        id,
        type: 'decision',
        label: numbered('Router', index),
        mode: 'router',
        routes: [
          { id: 'route_a', label: 'A' },
          { id: 'route_b', label: 'B' },
        ],
        inputBindings: [],
      }));
    case 'team':
      return fresh('team', (id, index) =>
        reference
          ? {
              id,
              type: 'team',
              label: reference.name,
              source: {
                kind: 'reference',
                corralId: reference.corralId,
                definitionRevision: reference.definitionRevision,
              },
            }
          : { id, type: 'team', label: numbered('Team', index), source: { kind: 'inline' } },
      );
    case 'join':
      return fresh('join', (id, index) => ({
        id,
        type: 'join',
        label: numbered('Join', index),
        policy: 'all',
      }));
  }
}

function withEdges(
  draft: EditorDraft,
  remove: (edge: ControlEdge) => boolean,
  add: Omit<ControlEdge, 'id'>[],
  bind: string[],
): EditorDraft {
  let next = draft;
  const added: ControlEdge[] = [];
  for (const edge of add) {
    const { id, counters } = nextId(
      {
        ...next,
        definition: {
          ...next.definition,
          controlEdges: [...next.definition.controlEdges, ...added],
        },
      },
      'edge',
    );
    next = { ...next, counters };
    added.push({ id, ...edge });
  }
  let definition: CorralDefinition = {
    ...next.definition,
    controlEdges: [...next.definition.controlEdges.filter((e) => !remove(e)), ...added],
  };
  for (const id of bind) definition = withSuggestedBinding(definition, id);
  return withDefinition(next, definition);
}

/** Adds a step: on a connection it goes in between, after a node it takes over its next steps. */
export function placeStep(
  draft: EditorDraft,
  kind: StepKind,
  at: Placement,
  options: { reference?: TeamReference; decisionLabel?: string } = {},
): EditResult {
  if (kind === 'observer') {
    // Never put into the flow: placed on an agent it watches that agent, anywhere else nobody.
    const watched =
      at.kind === 'after'
        ? draft.definition.nodes.find((node) => node.id === at.nodeId)
        : undefined;
    if (at.kind === 'after' && !watched) return { ok: false, reason: 'unknownNode' };
    const created = addAdvisor(draft);
    const linked = isWorkAgent(watched)
      ? linkWatch(created.draft, created.nodeId, watched.id)
      : null;
    return { ok: true, nodeId: created.nodeId, draft: linked?.ok ? linked.draft : created.draft };
  }
  return placeFlowStep(draft, kind, at, (parentId) =>
    createStep(draft, kind, parentId, options.reference, options.decisionLabel),
  );
}

function placeFlowStep(
  draft: EditorDraft,
  kind: Exclude<StepKind, 'observer'>,
  at: Placement,
  create: (parentId: string | null) => { draft: EditorDraft; nodeId: string },
): EditFailure | { ok: true; draft: EditorDraft; nodeId: string } {
  const { definition } = draft;
  const nodes = nodesOf(definition);
  switch (at.kind) {
    case 'empty': {
      const created = create(null);
      return { ok: true, ...created };
    }
    case 'edge':
    case 'beforeOutput': {
      const incoming =
        at.kind === 'beforeOutput'
          ? finalApproach(definition, at.outputId)
          : definition.controlEdges.filter((e) => e.id === at.edgeId);
      const [edge] = incoming;
      if (!edge)
        return { ok: false, reason: at.kind === 'edge' ? 'unknownNode' : 'unknownConnection' };
      const decision = ['review', 'approval', 'rule', 'check', 'router'].includes(kind);
      if (edge.targetPort === 'repeat' && !decision)
        return { ok: false, reason: 'repeatNeedsDecision' };
      const created = create(sourceSide(nodes, edge));
      const step = created.draft.definition.nodes.find(
        (n) => n.id === created.nodeId,
      ) as CorralNode;
      const into = primaryIn(step) as TargetPort;
      const out = primaryOut(step);
      const output = at.kind === 'beforeOutput' ? nodes.get(at.outputId) : undefined;
      const materials =
        output?.type === 'output' && isWorkAgent(step)
          ? finalResultInputs(output, step.inputBindings, nodes)
          : null;
      return {
        ok: true,
        nodeId: created.nodeId,
        draft: withEdges(
          materials
            ? patchNode(created.draft, step.id, { inputBindings: materials })
            : created.draft,
          (e) => (at.kind === 'beforeOutput' ? e.target === at.outputId : e.id === edge.id),
          [
            ...incoming.map(({ source, sourcePort }) => ({
              source,
              sourcePort,
              target: step.id,
              targetPort: into,
            })),
            ...(out
              ? [
                  {
                    source: step.id,
                    sourcePort: out,
                    target: edge.target,
                    targetPort: edge.targetPort,
                  },
                ]
              : []),
          ],
          materials ? [] : [step.id],
        ),
      };
    }
    case 'after': {
      const before = nodes.get(at.nodeId);
      if (!before) return { ok: false, reason: 'unknownNode' };
      const port = primaryOut(before);
      if (!port || (before.type === 'agent' && before.invocation === 'callable'))
        return { ok: false, reason: 'noNextStep' };
      const created = create(before.parentId ?? null);
      const step = nodesOf(created.draft.definition).get(created.nodeId) as CorralNode;
      const into = primaryIn(step) as TargetPort;
      const out = primaryOut(step);
      const following = definition.controlEdges.filter(
        (e) => e.source === before.id && e.sourcePort === port && e.targetPort !== 'repeat',
      );
      const moved = out ? new Set(following.map((e) => e.id)) : new Set<string>();
      return {
        ok: true,
        nodeId: created.nodeId,
        draft: withEdges(
          created.draft,
          (e) => moved.has(e.id),
          [
            { source: before.id, sourcePort: port, target: step.id, targetPort: into },
            ...(out
              ? following.map((e) => ({
                  source: step.id,
                  sourcePort: out,
                  target: e.target,
                  targetPort: e.targetPort,
                }))
              : []),
          ],
          [step.id],
        ),
      };
    }
    case 'into': {
      const box = nodes.get(at.boxId);
      if (!isBox(box) || (box.type === 'team' && box.source.kind === 'reference'))
        return { ok: false, reason: 'notABox' };
      const body = definition.controlEdges.filter(
        (e) => e.source === box.id && e.sourcePort === 'body',
      );
      const lastStep = definition.controlEdges.find(
        (e) =>
          e.target === box.id &&
          e.targetPort === 'exit' &&
          nodes.get(e.source)?.parentId === box.id,
      );
      if (body.length > 0 && lastStep)
        return placeFlowStep(draft, kind, { kind: 'edge', edgeId: lastStep.id }, create);
      const created = create(box.id);
      if (body.length > 0) return { ok: true, ...created };
      const step = nodesOf(created.draft.definition).get(created.nodeId) as CorralNode;
      const out = primaryOut(step);
      return {
        ok: true,
        nodeId: created.nodeId,
        draft: withEdges(
          created.draft,
          () => false,
          [
            {
              source: box.id,
              sourcePort: 'body',
              target: step.id,
              targetPort: primaryIn(step) as TargetPort,
            },
            ...(out
              ? [{ source: step.id, sourcePort: out, target: box.id, targetPort: 'exit' as const }]
              : []),
          ],
          [step.id],
        ),
      };
    }
  }
}

// ── advisors ─────────────────────────────────────────────────────────────────

/** An advisor starts watching a scheduled or callable agent. Removing the link stops it. */
export function watchAgent(draft: EditorDraft, advisorId: string, agentId: string): EditResult {
  const linked = linkWatch(draft, advisorId, agentId);
  return linked.ok ? { ok: true, draft: linked.draft } : linked;
}

// ── boxes ────────────────────────────────────────────────────────────────────

/**
 * Puts sibling steps into a new Loop or Team. Connections into them now enter the box and its
 * body leads to the same steps; connections out of them leave through the box. Exits to an
 * outer box's exit or repeat stay as they are: a step may leave several boxes at once.
 */
export function wrapIn(
  draft: EditorDraft,
  selected: readonly string[],
  kind: 'loop' | 'team',
): EditResult {
  const { definition } = draft;
  const nodes = nodesOf(definition);
  if (selected.some((id) => !nodes.has(id))) return { ok: false, reason: 'unknownNode' };
  // An advisor in the selection stays outside (canvas.md rule 5).
  const ids = selected.filter((id) => !isAdvisor(nodes.get(id)));
  if (selected.length > 0 && ids.length === 0) return { ok: false, reason: 'advisorOutsideBoxes' };
  const members = ids.map((id) => nodes.get(id));
  if (members.length === 0) return { ok: false, reason: 'unknownNode' };
  const parentId = members[0]?.parentId ?? null;
  if (members.some((n) => (n?.parentId ?? null) !== parentId))
    return { ok: false, reason: 'mixedBoxes' };
  if (members.some((n) => n?.type === 'agent' && n.invocation === 'callable'))
    return { ok: false, reason: 'callableInControlFlow' };

  const created = createStep(draft, kind, parentId);
  const boxId = created.nodeId;
  const inside = new Set(ids);
  const within = (id: string) => {
    for (let at: string | undefined = id; at; at = nodes.get(at)?.parentId)
      if (inside.has(at)) return true;
    return false;
  };
  const ancestorPort = (edge: ControlEdge) =>
    (edge.targetPort === 'exit' || edge.targetPort === 'repeat') &&
    parentId !== null &&
    isWithin(nodes, parentId, edge.target);

  const entering = definition.controlEdges.filter(
    (e) =>
      inside.has(e.target) &&
      !within(e.source) &&
      e.targetPort !== 'exit' &&
      e.targetPort !== 'repeat',
  );
  const leaving = definition.controlEdges.filter(
    (e) => within(e.source) && !within(e.target) && !ancestorPort(e),
  );
  const firstSteps = entering.length
    ? entering
    : ids
        .filter((id) => !definition.controlEdges.some((e) => e.target === id && within(e.source)))
        .map((id) => {
          const node = nodes.get(id) as CorralNode;
          return { target: id, targetPort: primaryIn(node) as TargetPort };
        });
  const unique = <T extends { target: string; targetPort: TargetPort }>(list: T[]) => [
    ...new Map(list.map((e) => [`${e.target}\u0000${e.targetPort}`, e])).values(),
  ];
  const nextSteps = unique(leaving);

  let next = withDefinition(created.draft, {
    ...created.draft.definition,
    nodes: created.draft.definition.nodes.map((n) =>
      inside.has(n.id) ? { ...n, parentId: boxId } : n,
    ),
  });
  const reroute = new Set([...entering, ...leaving].map((e) => e.id));
  next = withEdges(
    next,
    (e) => reroute.has(e.id),
    [
      ...entering.map((e) => ({
        source: e.source,
        sourcePort: e.sourcePort,
        target: boxId,
        targetPort: 'enter' as const,
      })),
      ...unique(firstSteps).map((e) => ({
        source: boxId,
        sourcePort: 'body',
        target: e.target,
        targetPort: e.targetPort,
      })),
      ...leaving.map((e) => ({
        source: e.source,
        sourcePort: e.sourcePort,
        target: boxId,
        targetPort: 'exit' as const,
      })),
      ...nextSteps.map((e) => ({
        source: boxId,
        sourcePort: 'next',
        target: e.target,
        targetPort: e.targetPort,
      })),
      // A Loop at its limit goes on with its last result to where `next` goes, when that is one
      // place: a Join gathers the branches of one port only, so a `next` that fans out gets none.
      ...(kind === 'loop' && nextSteps.length === 1 ? nextSteps : []).map((e) => ({
        source: boxId,
        sourcePort: 'exhausted',
        target: e.target,
        targetPort: e.targetPort,
      })),
    ],
    [],
  );
  // Several connections into one port collapse to one.
  const seen = new Set<string>();
  const controlEdges = next.definition.controlEdges.filter((e) => {
    const key = [e.source, e.sourcePort, e.target, e.targetPort].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ok: true,
    nodeId: boxId,
    draft: withDefinition(next, { ...next.definition, controlEdges }),
  };
}

/** Moves a step into a box, or out to the top level with `null`. */
export function setParent(draft: EditorDraft, id: string, parentId: string | null): EditResult {
  const nodes = nodesOf(draft.definition);
  const node = nodes.get(id);
  if (!node) return { ok: false, reason: 'unknownNode' };
  if ((node.parentId ?? null) === parentId) return { ok: true, draft };
  if (parentId !== null) {
    if (isAdvisor(node)) return { ok: false, reason: 'advisorOutsideBoxes' };
    const box = nodes.get(parentId);
    if (!isBox(box) || (box.type === 'team' && box.source.kind === 'reference'))
      return { ok: false, reason: 'notABox' };
    if (isWithin(nodes, parentId, id)) return { ok: false, reason: 'boxBoundary' };
  }
  const nodesNext = draft.definition.nodes.map((n) => {
    if (n.id !== id) return n;
    const { parentId: _old, ...rest } = n;
    return (parentId ? { ...rest, parentId } : rest) as CorralNode;
  });
  return { ok: true, draft: withDefinition(draft, { ...draft.definition, nodes: nodesNext }) };
}

// ── removing ─────────────────────────────────────────────────────────────────

/**
 * Removes nodes, connections and call links. A removed box hands its members to its own box
 * and joins what entered it to its first steps and its last steps to what came after it.
 */
export function removeItems(
  draft: EditorDraft,
  ids: readonly string[],
  outriderTargets: readonly SharedOutriderTarget[] = [],
): EditorDraft {
  let next = draft;
  const gone = new Set(ids);
  const controlEdges = next.definition.controlEdges.filter((e) => !gone.has(e.id));
  const capabilityLinks = next.definition.capabilityLinks.filter((l) => !gone.has(l.id));
  next = withDefinition(next, { ...next.definition, controlEdges, capabilityLinks });
  for (const id of ids) {
    const node = next.definition.nodes.find((n) => n.id === id);
    if (!node) continue;
    if (isBox(node)) next = unwrap(next, node.id);
    next = removeNode(next, id, outriderTargets);
  }
  return next;
}

function unwrap(draft: EditorDraft, boxId: string): EditorDraft {
  const { definition } = draft;
  const box = definition.nodes.find((n) => n.id === boxId);
  const parentId = box?.parentId;
  const edges = definition.controlEdges;
  const into = edges.filter((e) => e.target === boxId && e.targetPort === 'enter');
  const body = edges.filter((e) => e.source === boxId && e.sourcePort === 'body');
  const last = edges.filter((e) => e.target === boxId && e.targetPort === 'exit');
  const after = edges.filter((e) => e.source === boxId && e.sourcePort === 'next');
  const nodes = definition.nodes.map((n) => {
    if (n.parentId !== boxId) return n;
    const { parentId: _box, ...rest } = n;
    return (parentId ? { ...rest, parentId } : rest) as CorralNode;
  });
  return withEdges(
    withDefinition(draft, { ...definition, nodes }),
    (e) => e.source === boxId || e.target === boxId,
    [
      ...into.flatMap((a) =>
        body.map((b) => ({
          source: a.source,
          sourcePort: a.sourcePort,
          target: b.target,
          targetPort: b.targetPort,
        })),
      ),
      ...last.flatMap((a) =>
        after.map((b) => ({
          source: a.source,
          sourcePort: a.sourcePort,
          target: b.target,
          targetPort: b.targetPort,
        })),
      ),
    ],
    [],
  );
}

// ── patterns ─────────────────────────────────────────────────────────────────

/** Patterns applied to the selection. None of them adds a step that waits for a person. */
export type Pattern = 'reviewLoop' | 'checkLoop' | 'parallel';

const REVIEWER_PROMPT =
  'Review the work against the brief and the criteria. Pass it when it meets them; otherwise say exactly what to revise.';

/**
 * Applies a pattern to the selected steps. With nothing selected, a new agent is added at `at`
 * first and the pattern applies to it.
 */
export function applyPattern(
  draft: EditorDraft,
  pattern: Pattern,
  ids: readonly string[],
  at: Placement = { kind: 'empty' },
  reviewLabel?: string,
): EditResult {
  let next = draft;
  let targets = [...ids];
  if (targets.length === 0) {
    const created = placeStep(draft, 'agent', at);
    if (!created.ok) return created;
    next = created.draft;
    targets = [created.nodeId as string];
  }
  return pattern === 'parallel'
    ? splitParallel(next, targets)
    : loopAround(next, targets, pattern, reviewLabel);
}

/** Wraps the steps in a Loop that ends in a verdict: pass leaves, revise or fail goes round. */
function loopAround(
  draft: EditorDraft,
  ids: string[],
  pattern: 'reviewLoop' | 'checkLoop',
  reviewLabel?: string,
): EditResult {
  const wrapped = wrapIn(draft, ids, 'loop');
  if (!wrapped.ok) return wrapped;
  const loop = wrapped.nodeId as string;
  let next = wrapped.draft;
  const nodes = nodesOf(next.definition);
  const edges = next.definition.controlEdges;
  // The last steps: what left through the exit, else the selected steps nothing follows.
  const exits = edges.filter(
    (e) => e.target === loop && e.targetPort === 'exit' && nodes.get(e.source)?.parentId === loop,
  );
  let lasts = exits.map((e) => ({ source: e.source, sourcePort: e.sourcePort }));
  if (!lasts.length)
    lasts = ids.flatMap((id) => {
      const step = nodes.get(id);
      const port = step ? primaryOut(step) : null;
      const followed = edges.some((e) => e.source === id && e.sourcePort === port);
      return port && !followed ? [{ source: id, sourcePort: port }] : [];
    });
  if (!lasts.length) return { ok: false, reason: 'noNextStep' };

  let reviewer: string | null = null;
  if (pattern === 'reviewLoop') {
    const created = createStep(next, 'agent', loop);
    reviewer = created.nodeId;
    const roleId = (nodesOf(created.draft.definition).get(reviewer) as { roleId?: string }).roleId;
    next = withDefinition(created.draft, {
      ...created.draft.definition,
      nodes: created.draft.definition.nodes.map((n) =>
        n.id === reviewer ? { ...n, label: 'Reviewer' } : n,
      ),
      roles: created.draft.definition.roles.map((role) =>
        role.id === roleId
          ? {
              ...role,
              name: 'Reviewer',
              prompt: REVIEWER_PROMPT,
              outputContract: 'review',
              allowedCollaborationTools: ['read_artifact', 'submit_result'],
            }
          : role,
      ),
    });
  }
  const verdictStep = createStep(
    next,
    pattern === 'reviewLoop' ? 'review' : 'check',
    loop,
    undefined,
    reviewLabel,
  );
  next = verdictStep.draft;
  const verdict = verdictStep.nodeId;
  const first = reviewer ?? verdict;
  const gone = new Set(exits.map((e) => e.id));
  next = withEdges(
    next,
    (e) => gone.has(e.id),
    [
      ...lasts.map((l) => ({ ...l, target: first, targetPort: 'in' as const })),
      ...(reviewer
        ? [{ source: reviewer, sourcePort: 'out', target: verdict, targetPort: 'in' as const }]
        : []),
      { source: verdict, sourcePort: 'pass', target: loop, targetPort: 'exit' as const },
      {
        source: verdict,
        sourcePort: pattern === 'reviewLoop' ? 'revise' : 'fail',
        target: loop,
        targetPort: 'repeat' as const,
      },
    ],
    [first, verdict],
  );
  if (reviewer) {
    // The work sees the last review when it goes round again.
    const firstSteps = new Set(
      next.definition.controlEdges
        .filter((e) => e.source === loop && e.sourcePort === 'body')
        .map((e) => e.target),
    );
    next = withDefinition(next, {
      ...next.definition,
      nodes: next.definition.nodes.map((n) =>
        firstSteps.has(n.id) &&
        n.type === 'agent' &&
        n.invocation === 'scheduled' &&
        !n.inputBindings.some((b) => b.name === 'review')
          ? {
              ...n,
              inputBindings: [
                ...n.inputBindings,
                {
                  kind: 'previous_iteration_output',
                  name: 'review',
                  sourceNodeId: reviewer as string,
                  optional: true,
                },
              ],
            }
          : n,
      ),
    });
  }
  return { ok: true, draft: next, nodeId: loop };
}

/** Creates or removes the review of one particular input. A producer can serve multiple outputs. */
export function setRequiredOutputReview(
  draft: EditorDraft,
  outputId: string,
  bindingName: string,
  sourceNodeId: string,
  enabled: boolean,
  inputIndex?: number,
  policyId?: string,
): EditResult {
  const initial = draft.definition;
  const output = initial.nodes.find((n) => n.id === outputId);
  if (output?.type !== 'output') return { ok: false, reason: 'unknownNode' };
  const gates = output.requiredReviews ?? [];
  const matches = output.inputBindings.filter(
    (b) => b.kind === 'task_output' && b.name === bindingName && b.sourceNodeId === sourceNodeId,
  );
  const selected =
    inputIndex === undefined
      ? matches.length === 1
        ? matches[0]
        : undefined
      : output.inputBindings[inputIndex];
  const current = gates.find((g) => {
    if (policyId)
      return (
        g.bindingId === policyId && g.bindingName === bindingName && g.sourceNodeId === sourceNodeId
      );
    if (g.bindingName !== bindingName || g.sourceNodeId !== sourceNodeId) return false;
    return inputIndex === undefined || reviewedOutputBinding(output, g) === selected;
  });
  if (enabled === Boolean(current)) return { ok: true, draft };
  const allGates = initial.nodes.flatMap((n) =>
    n.type === 'output' ? (n.requiredReviews ?? []) : [],
  );
  if (current) {
    const remaining = gates.filter((g) => g !== current);
    let next = patchNode(draft, outputId, {
      requiredReviews: remaining.length ? remaining : undefined,
      ...(current.bindingId && !remaining.some((g) => g.bindingId === current.bindingId)
        ? {
            inputBindings: output.inputBindings.map((b) => {
              if (b.bindingId !== current.bindingId) return b;
              const { bindingId: _released, ...rest } = b;
              return rest;
            }),
          }
        : {}),
    });
    if (allGates.some((g) => g !== current && g.loopNodeId === current.loopNodeId))
      return { ok: true, draft: next };
    // The pattern put the reviewer between the producer and the Loop exit. Restore those exits
    // before unwrapping so branches after the Loop keep their original destinations.
    const byId = nodesOf(next.definition);
    const reviewer = byId.get(current.reviewerNodeId);
    const decision = byId.get(current.decisionNodeId);
    if (
      byId.get(current.loopNodeId)?.type === 'loop' &&
      reviewer?.parentId === current.loopNodeId &&
      decision?.parentId === current.loopNodeId
    ) {
      const intoReview = next.definition.controlEdges.filter(
        (e) => e.target === reviewer.id && e.targetPort === 'in',
      );
      next = withEdges(
        next,
        (e) => intoReview.some((prior) => prior.id === e.id),
        intoReview.map((e) => ({
          source: e.source,
          sourcePort: e.sourcePort,
          target: current.loopNodeId,
          targetPort: 'exit',
        })),
        [],
      );
      next = removeItems(next, [reviewer.id, decision.id, current.loopNodeId]);
    }
    return { ok: true, draft: next };
  }
  const outrider = initial.sharedOutrider;
  if (!outrider) return { ok: false, reason: 'requiredReviewNeedsOutrider' };
  const producer = initial.nodes.find((n) => n.id === sourceNodeId);
  const sourceBinding = selected && matches.includes(selected) ? selected : undefined;
  if (
    !sourceBinding ||
    !(
      (producer?.type === 'agent' && producer.invocation === 'scheduled') ||
      (producer?.type === 'team' && producer.source.kind === 'reference')
    )
  ) {
    return { ok: false, reason: 'requiredReviewNeedsSource' };
  }
  let next = draft;
  let gate = allGates.find((g) => g.sourceNodeId === sourceNodeId);
  if (!gate) {
    const result = applyPattern(draft, 'reviewLoop', [sourceNodeId]);
    if (!result.ok || !result.nodeId) return result;
    const loopNodeId = result.nodeId;
    next = result.draft;
    const reviewer = next.definition.nodes.find(
      (n) => isWorkAgent(n) && n.parentId === loopNodeId && n.id !== sourceNodeId,
    );
    const decision = next.definition.nodes.find(
      (n) => n.type === 'decision' && n.mode === 'review' && n.parentId === loopNodeId,
    );
    if (!isWorkAgent(reviewer) || !decision)
      return { ok: false, reason: 'requiredReviewNeedsSource' };
    gate = {
      bindingName,
      sourceNodeId,
      loopNodeId,
      reviewerNodeId: reviewer.id,
      decisionNodeId: decision.id,
    };
    next = withDefinition(next, {
      ...next.definition,
      controlEdges: next.definition.controlEdges.filter(
        (e) => !(e.source === loopNodeId && e.sourcePort === 'exhausted'),
      ),
      nodes: next.definition.nodes.map((n) => {
        if (n.id === reviewer.id)
          return {
            ...n,
            inputBindings: [
              { kind: 'task_output' as const, name: 'draft', sourceNodeId },
              { kind: 'run_input' as const, name: 'criteria' },
            ],
          };
        // A producer can already have feedback from an enclosing review Loop.
        if (
          n.id !== sourceNodeId ||
          !isWorkAgent(n) ||
          n.inputBindings.some(
            (b) => b.kind === 'previous_iteration_output' && b.sourceNodeId === reviewer.id,
          )
        )
          return n;
        let name = 'review';
        for (let i = 2; n.inputBindings.some((b) => b.name === name); i++) name = `review_${i}`;
        return {
          ...n,
          inputBindings: [
            ...n.inputBindings,
            {
              kind: 'previous_iteration_output' as const,
              name,
              sourceNodeId: reviewer.id,
              optional: true,
            },
          ],
        };
      }),
      roles: next.definition.roles.map((r) =>
        r.id === reviewer.roleId
          ? {
              ...r,
              prompt: outrider.principles,
              modelProfile: outrider.modelProfile,
              allowedWorkTools: ['write_artifact'],
            }
          : r,
      ),
    });
  }
  // Unrelated inputs can have identical names and producers. Only this row receives the policy.
  const used = new Set([...gates, ...output.inputBindings].map((b) => b.bindingId));
  let bindingId = sourceBinding.bindingId;
  if (!bindingId) {
    let i = 1;
    while (used.has('input-' + i)) i++;
    bindingId = 'input-' + i;
  }
  return {
    ok: true,
    draft: patchNode(next, outputId, {
      inputBindings: output.inputBindings.map((b) =>
        b === sourceBinding ? { ...b, bindingId } : b,
      ),
      requiredReviews: [...gates, { ...gate, bindingName, bindingId }],
    }),
  };
}

/** Runs a copy of the agent beside it from the same step, and joins the two before what followed. */
function splitParallel(draft: EditorDraft, ids: string[]): EditResult {
  const nodes = nodesOf(draft.definition);
  const step = ids.length === 1 ? nodes.get(ids[0] as string) : undefined;
  if (step?.type !== 'agent' || step.invocation !== 'scheduled')
    return { ok: false, reason: 'oneAgentOnly' };
  const edges = draft.definition.controlEdges;
  const incoming = edges.filter((e) => e.target === step.id && e.targetPort === 'in');
  if (!incoming.length) return { ok: false, reason: 'noPredecessor' };
  const outgoing = edges.filter((e) => e.source === step.id && e.sourcePort === 'out');
  const copy = duplicateNode(draft, step.id);
  // The copy keeps its role's tools, so it calls the same helpers the agent calls, and the
  // advisors watching the agent watch the copy too.
  let linked = copy.draft;
  for (const link of draft.definition.capabilityLinks) {
    const watch = link.kind === 'advise' && link.targetNodeId === step.id;
    if (link.sourceNodeId !== step.id && !watch) continue;
    const { id, counters } = nextId(linked, 'link');
    linked = withDefinition(
      { ...linked, counters },
      {
        ...linked.definition,
        capabilityLinks: [
          ...linked.definition.capabilityLinks,
          watch
            ? { ...link, id, targetNodeId: copy.nodeId }
            : { ...link, id, sourceNodeId: copy.nodeId },
        ],
      },
    );
  }
  const join = createStep(linked, 'join', step.parentId ?? null);
  const gone = new Set(outgoing.map((e) => e.id));
  return {
    ok: true,
    nodeId: join.nodeId,
    draft: withEdges(
      join.draft,
      (e) => gone.has(e.id),
      [
        ...incoming.map((e) => ({
          source: e.source,
          sourcePort: e.sourcePort,
          target: copy.nodeId,
          targetPort: 'in' as const,
        })),
        { source: step.id, sourcePort: 'out', target: join.nodeId, targetPort: 'in' as const },
        { source: copy.nodeId, sourcePort: 'out', target: join.nodeId, targetPort: 'in' as const },
        ...outgoing.map((e) => ({
          source: join.nodeId,
          sourcePort: 'out',
          target: e.target,
          targetPort: e.targetPort,
        })),
      ],
      [],
    ),
  };
}

// ── roles ────────────────────────────────────────────────────────────────────

const isAdvisorRole = (role: Pick<AgentRole, 'allowedCollaborationTools'>) =>
  role.allowedCollaborationTools.includes('advise');

/** The roles of a team another team may copy: not those its advisors run. */
export function importableRoles(definition: {
  nodes: readonly CorralNode[];
  roles: readonly AgentRole[];
}): AgentRole[] {
  const advisors = new Set(
    definition.nodes.flatMap((n) => (isAdvisor(n) && n.type === 'agent' ? [n.roleId] : [])),
  );
  return definition.roles.filter((role) => !advisors.has(role.id) && !isAdvisorRole(role));
}

export interface AgentSource {
  role: Omit<AgentRole, 'id' | 'origin'>;
  origin?: RoleOrigin;
  stepInstruction?: string;
}

/** Start the seat with the submitted materials, not the producer nearest in control flow. */
function finalResultInputs(
  output: OutputNode,
  defaults: InputBinding[],
  nodes: ReadonlyMap<string, CorralNode>,
): InputBinding[] | null {
  const optionalBySource = new Map<string, boolean>();
  for (const { kind, sourceNodeId, optional } of output.inputBindings) {
    if (kind !== 'task_output' || !sourceNodeId) continue;
    // Multiple submission aliases for one producer still describe one material.
    optionalBySource.set(
      sourceNodeId,
      (optionalBySource.get(sourceNodeId) ?? true) && optional === true,
    );
  }
  if (!optionalBySource.size) return null;
  const inputs = [...defaults];
  const names = new Set(inputs.map((b) => b.name));
  for (const [sourceNodeId, optional] of optionalBySource) {
    const producer = nodes.get(sourceNodeId);
    const base = producer?.type === 'agent' ? producer.outputName : 'result';
    let name = base;
    for (let i = 2; names.has(name); i++) name = `${base}_${i}`;
    names.add(name);
    inputs.push({ kind: 'task_output', name, sourceNodeId, ...(optional ? { optional } : {}) });
  }
  return inputs;
}

/** All routes into a final Output can move together only when they come from the same step. */
function finalApproach(definition: CorralDefinition, outputId: string): ControlEdge[] {
  const incoming = definition.controlEdges.filter((e) => e.target === outputId);
  const first = incoming[0];
  return first && incoming.every((e) => e.source === first.source) ? incoming : [];
}

export function compositionPlacement(definition: CorralDefinition): Placement {
  const outputs = definition.nodes.filter((node) => node.type === 'output');
  const only = outputs.length === 1 ? outputs[0] : undefined;
  return only && finalApproach(definition, only.id).length
    ? { kind: 'beforeOutput', outputId: only.id }
    : { kind: 'empty' };
}

function copyAgentRole(source: AgentSource, id: string): AgentRole {
  const role: AgentRole = structuredClone({ ...source.role, id });
  // A saved team's role is structurally assignable to the source type. Only the explicit
  // origin of this copy counts, never an id or origin left inside source.role.
  if (source.origin) role.origin = structuredClone(source.origin);
  else delete role.origin;
  return role;
}

export function addAgent(draft: EditorDraft, source: AgentSource, at: Placement): EditResult {
  if (isAdvisorRole(source.role)) return { ok: false, reason: 'advisorRole' };
  const placed = placeFlowStep(draft, 'agent', at, (parentId) => {
    const seat = nextId(draft, 'agent');
    const fresh = nextId({ ...draft, counters: seat.counters }, 'role');
    const role = copyAgentRole(source, fresh.id);
    const node = newWorkAgent(seat.id, role);
    if (parentId) node.parentId = parentId;
    if (source.stepInstruction?.trim()) node.stepInstruction = source.stepInstruction;
    return {
      nodeId: node.id,
      draft: withDefinition(
        { ...draft, counters: fresh.counters },
        {
          ...draft.definition,
          roles: [...draft.definition.roles, role],
          nodes: [...draft.definition.nodes, node],
        },
      ),
    };
  });
  if (!placed.ok || draft.definition.nodes.some((n) => isWorkAgent(n) || n.type === 'output'))
    return placed;
  const node = placed.draft.definition.nodes.find((n) => n.id === placed.nodeId);
  if (!isWorkAgent(node)) return { ok: false, reason: 'roleNeedsAgent' };
  const output = createStep(placed.draft, 'output', node.parentId ?? null);
  const bound = patchNode(output.draft, output.nodeId, {
    inputBindings: [{ kind: 'task_output', name: node.outputName, sourceNodeId: node.id }],
  });
  return {
    ...placed,
    draft: withEdges(
      bound,
      () => false,
      [{ source: node.id, sourcePort: 'out', target: output.nodeId, targetPort: 'in' }],
      [],
    ),
  };
}

const keptSeatFields = [
  'id',
  'label',
  'stepInstruction',
  'inputBindings',
  'controlEdges',
  'capabilityLinks',
  'outputBindings',
  'outriderTargets',
] as const;

type RoleField = Exclude<keyof AgentRole, 'id'>;

/** The prospective draft is the preview: closing it is free; applying it takes one undo. */
export function previewReplaceAgent(
  draft: EditorDraft,
  nodeId: string,
  source: AgentSource,
  options?: CompileOptions,
):
  | EditFailure
  | {
      ok: true;
      draft: EditorDraft;
      nodeId: string;
      changed: RoleField[];
      kept: typeof keptSeatFields;
    } {
  const { definition } = draft;
  const seat = definition.nodes.find((n) => n.id === nodeId);
  if (!isWorkAgent(seat)) return { ok: false, reason: 'roleNeedsAgent' };
  if (isAdvisorRole(source.role)) return { ok: false, reason: 'advisorRole' };
  const previous = definition.roles.find((r) => r.id === seat.roleId);
  const fields = new Set([...Object.keys(previous ?? {}), ...Object.keys(source.role), 'origin']);
  fields.delete('id');
  const changed = ([...fields] as RoleField[]).filter(
    (key) => !sameRoleField(previous?.[key], key === 'origin' ? source.origin : source.role[key]),
  );
  const preview = { ok: true as const, nodeId, changed, kept: keptSeatFields };
  if (!changed.length) return { ...preview, draft };

  const shared = definition.nodes.some(
    (n) => n.id !== nodeId && n.type === 'agent' && n.roleId === seat.roleId,
  );
  const movesOwner = definition.planOwnerRoleId === seat.roleId && !shared;
  if (movesOwner && !source.role.allowedCollaborationTools.includes('update_plan'))
    return { ok: false, reason: 'movePlanOwner' };
  const { id, counters } = nextId(draft, 'role');
  const role = copyAgentRole(source, id);
  const next: EditorDraft = {
    counters,
    definition: {
      ...definition,
      ...(movesOwner ? { planOwnerRoleId: id } : {}),
      roles:
        previous && !shared
          ? definition.roles.map((r) => (r === previous ? role : r))
          : [...definition.roles, role],
      nodes: definition.nodes.map((n) => (n === seat ? { ...seat, roleId: id } : n)),
    },
  };
  const errors = compileDefinition(next.definition, options).diagnostics.filter(
    (d) => d.severity === 'error',
  );
  if (errors.length) {
    const location = (d: Diagnostic) =>
      JSON.stringify([d.code, d.nodeId, d.edgeId, d.linkId, d.schemaPath]);
    const existing = new Set(
      compileDefinition(definition, options)
        .diagnostics.filter((d) => d.severity === 'error')
        .map(location),
    );
    const diagnostic = errors.find((d) => !existing.has(location(d)));
    if (diagnostic) return { ok: false, reason: 'replacementCompileError', diagnostic };
  }
  return { ...preview, draft: next };
}

export function replaceAgent(
  draft: EditorDraft,
  nodeId: string,
  source: AgentSource,
  options?: CompileOptions,
): EditResult {
  return previewReplaceAgent(draft, nodeId, source, options);
}

export function setStepInstruction(draft: EditorDraft, nodeId: string, text: string): EditResult {
  const seat = draft.definition.nodes.find((n) => n.id === nodeId);
  if (!isWorkAgent(seat)) return { ok: false, reason: 'roleNeedsAgent' };
  const stepInstruction = text.trim() ? text : undefined;
  return {
    ok: true,
    nodeId,
    draft:
      seat.stepInstruction === stepInstruction
        ? draft
        : patchNode(draft, nodeId, { stepInstruction }),
  };
}

export function seatTask(
  definition: CorralDefinition,
  nodeId: string,
): { target: 'role' | 'step'; text: string; base: string | null } | null {
  const seat = definition.nodes.find((n) => n.id === nodeId);
  if (!isWorkAgent(seat)) return null;
  const role = definition.roles.find((r) => r.id === seat.roleId);
  if (!role) return null;
  return seat.stepInstruction !== undefined || role.origin
    ? { target: 'step', text: seat.stepInstruction ?? '', base: role.prompt }
    : { target: 'role', text: role.prompt, base: null };
}

export function setSeatTask(draft: EditorDraft, nodeId: string, text: string): EditResult {
  const task = seatTask(draft.definition, nodeId);
  if (!task) return { ok: false, reason: 'roleNeedsAgent' };
  if (task.target === 'step') return setStepInstruction(draft, nodeId, text);
  return { ok: true, nodeId, draft: updateNode(draft, nodeId, { prompt: text }) };
}

// ── settings ─────────────────────────────────────────────────────────────────

/** Changes which producer supplies one binding, independently of execution order. */
export function replaceOutputSource(
  draft: EditorDraft,
  outputId: string,
  index: number,
  sourceId: string,
): EditResult {
  const output = draft.definition.nodes.find((node) => node.id === outputId);
  if (output?.type !== 'output') return { ok: false, reason: 'unknownNode' };
  const binding = output.inputBindings[index];
  if (binding?.kind !== 'task_output') return { ok: false, reason: 'invalidResultInput' };
  if (!outputSources(draft.definition, outputId).some((source) => source.id === sourceId)) {
    return { ok: false, reason: 'invalidResultSource' };
  }
  if (binding.sourceNodeId === sourceId) return { ok: true, draft };
  const inputBindings = output.inputBindings.map((existing, i) =>
    i === index ? { ...existing, sourceNodeId: sourceId } : existing,
  );
  const nodes = draft.definition.nodes.map((node) =>
    node === output ? { ...output, inputBindings } : node,
  );
  return { ok: true, draft: { ...draft, definition: { ...draft.definition, nodes } } };
}

/** Sets fields of one node; `undefined` removes an optional field. The compiler validates. */
export function patchNode(
  draft: EditorDraft,
  id: string,
  patch: Record<string, unknown>,
): EditorDraft {
  const nodes = draft.definition.nodes.map((node) => {
    if (node.id !== id) return node;
    const next: Record<string, unknown> = { ...node, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
    return next as CorralNode;
  });
  return withDefinition(draft, { ...draft.definition, nodes });
}

export interface TeamPatch {
  name?: string;
  brief?: string;
  criteria?: string[];
  limits?: Partial<CorralDefinition['limits']>;
}

export function patchTeam(draft: EditorDraft, patch: TeamPatch): EditorDraft {
  const { definition } = draft;
  return withDefinition(draft, {
    ...definition,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    input: {
      ...definition.input,
      ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
      ...(patch.criteria !== undefined ? { criteria: patch.criteria } : {}),
    },
    limits: { ...definition.limits, ...patch.limits },
  });
}
