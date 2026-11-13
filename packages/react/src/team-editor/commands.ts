import {
  type AgentRole,
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  type HarnessBindingRef,
  isWorkAgent,
  type TargetPort,
} from '@corral/contracts';
import {
  boxBoundaryViolation,
  DECISION_RULE,
  inputPortsOf,
  isBox,
  isWithin,
  outputPortsOf,
  sourceSide,
  wouldCreateCycle,
} from '@corral/core';
import {
  addAdvisor,
  addNode,
  duplicateNode,
  type EditorDraft,
  watchAgent as linkWatch,
  nextId,
  removeNode,
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

/** Where a new step goes: on a connection, after a node, into a box, or on its own. */
export type Placement =
  | { kind: 'empty' }
  | { kind: 'edge'; edgeId: string }
  | { kind: 'after'; nodeId: string }
  | { kind: 'into'; boxId: string };

export type EditRejection =
  | 'unknownNode'
  | 'selfConnection'
  | 'callableInControlFlow'
  | 'invalidSourcePort'
  | 'invalidTargetPort'
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
  | 'advisorOutsideBoxes'
  | 'watchNeedsAdvisor'
  | 'watchNeedsAgent';

export type EditResult =
  | { ok: true; draft: EditorDraft; nodeId?: string }
  | { ok: false; reason: EditRejection };

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
): { ok: true } | { ok: false; reason: EditRejection } {
  const { definition } = draft;
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
    definition.controlEdges.some(
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
  if (wouldCreateCycle(definition.nodes, definition.controlEdges, request))
    return { ok: false, reason: 'cycle' };
  return { ok: true };
}

export function connectPorts(draft: EditorDraft, request: PortRequest): EditResult {
  const check = checkPorts(draft, request);
  if (!check.ok) return check;
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
  kind: StepKind,
  parentId: string | null,
  reference?: TeamReference,
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
    case 'observer':
      // Never in a box: an advisor sits outside the flow.
      return addAdvisor(draft);
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
              label: node.label,
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
  options: { reference?: TeamReference } = {},
): EditResult {
  const { definition } = draft;
  const nodes = nodesOf(definition);
  if (kind === 'observer') {
    // Never put into the flow: placed on an agent it watches that agent, anywhere else nobody.
    const watched = at.kind === 'after' ? nodes.get(at.nodeId) : undefined;
    if (at.kind === 'after' && !watched) return { ok: false, reason: 'unknownNode' };
    const created = addAdvisor(draft);
    const linked = isWorkAgent(watched)
      ? linkWatch(created.draft, created.nodeId, watched.id)
      : null;
    return { ok: true, nodeId: created.nodeId, draft: linked?.ok ? linked.draft : created.draft };
  }
  switch (at.kind) {
    case 'empty': {
      const created = createStep(draft, kind, null, options.reference);
      return { ok: true, ...created };
    }
    case 'edge': {
      const edge = definition.controlEdges.find((e) => e.id === at.edgeId);
      if (!edge) return { ok: false, reason: 'unknownNode' };
      const decision = ['review', 'approval', 'rule', 'check', 'router'].includes(kind);
      if (edge.targetPort === 'repeat' && !decision)
        return { ok: false, reason: 'repeatNeedsDecision' };
      const created = createStep(draft, kind, sourceSide(nodes, edge), options.reference);
      const step = nodesOf(created.draft.definition).get(created.nodeId) as CorralNode;
      const into = primaryIn(step) as TargetPort;
      const out = primaryOut(step);
      return {
        ok: true,
        nodeId: created.nodeId,
        draft: withEdges(
          created.draft,
          (e) => e.id === edge.id,
          [
            { source: edge.source, sourcePort: edge.sourcePort, target: step.id, targetPort: into },
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
          [step.id],
        ),
      };
    }
    case 'after': {
      const before = nodes.get(at.nodeId);
      if (!before) return { ok: false, reason: 'unknownNode' };
      const port = primaryOut(before);
      if (!port || (before.type === 'agent' && before.invocation === 'callable'))
        return { ok: false, reason: 'noNextStep' };
      const created = createStep(draft, kind, before.parentId ?? null, options.reference);
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
        return placeStep(draft, kind, { kind: 'edge', edgeId: lastStep.id }, options);
      const created = createStep(draft, kind, box.id, options.reference);
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
export function removeItems(draft: EditorDraft, ids: readonly string[]): EditorDraft {
  let next = draft;
  const gone = new Set(ids);
  const controlEdges = next.definition.controlEdges.filter((e) => !gone.has(e.id));
  const capabilityLinks = next.definition.capabilityLinks.filter((l) => !gone.has(l.id));
  next = withDefinition(next, { ...next.definition, controlEdges, capabilityLinks });
  for (const id of ids) {
    const node = next.definition.nodes.find((n) => n.id === id);
    if (!node) continue;
    if (isBox(node)) next = unwrap(next, node.id);
    next = removeNode(next, id);
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
): EditResult {
  let next = draft;
  let targets = [...ids];
  if (targets.length === 0) {
    const created = placeStep(draft, 'agent', at);
    if (!created.ok) return created;
    next = created.draft;
    targets = [created.nodeId as string];
  }
  return pattern === 'parallel' ? splitParallel(next, targets) : loopAround(next, targets, pattern);
}

/** Wraps the steps in a Loop that ends in a verdict: pass leaves, revise or fail goes round. */
function loopAround(
  draft: EditorDraft,
  ids: string[],
  pattern: 'reviewLoop' | 'checkLoop',
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
  const verdictStep = createStep(next, pattern === 'reviewLoop' ? 'review' : 'check', loop);
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
  // The copy keeps its role's tools, so it calls the same helpers the agent calls.
  let linked = copy.draft;
  for (const link of draft.definition.capabilityLinks) {
    if (link.sourceNodeId !== step.id) continue;
    const { id, counters } = nextId(linked, 'link');
    linked = withDefinition(
      { ...linked, counters },
      {
        ...linked.definition,
        capabilityLinks: [
          ...linked.definition.capabilityLinks,
          { ...link, id, sourceNodeId: copy.nodeId },
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

export interface RoleImportOptions {
  /** Whether a work style reference resolves here; one that does not is left out. */
  resolvesHarness?: ((ref: HarnessBindingRef) => boolean) | undefined;
}

export type RoleImportResult =
  | { ok: true; draft: EditorDraft; nodeId: string; droppedHarness: boolean }
  | { ok: false; reason: EditRejection };

/**
 * Copies a role onto one agent under a new role id: its instructions, model, reasoning, tools,
 * output contract and work style. The agent keeps its name, inputs, connections and call links.
 * Other agents that ran its previous role keep that role; a previous role no agent runs any
 * more goes, as it does when its agent is removed. With nothing selected, a new agent named
 * after the role is added at `at` first. The source is only read and never linked: a model
 * profile is kept as it is, and a work style this place cannot resolve is left out.
 */
export function importRole(
  draft: EditorDraft,
  source: AgentRole,
  ids: readonly string[],
  at: Placement = { kind: 'empty' },
  options: RoleImportOptions = {},
): RoleImportResult {
  let next = draft;
  let targetId = ids.length === 1 ? (ids[0] as string) : null;
  if (ids.length === 0) {
    const created = placeStep(draft, 'agent', at);
    if (!created.ok) return created;
    next = created.draft;
    targetId = created.nodeId as string;
  }
  const target = targetId ? nodesOf(next.definition).get(targetId) : undefined;
  // An advisor's role holds advisor tools only; a working agent's role would not fit it.
  if (target?.type !== 'agent' || isAdvisor(target)) return { ok: false, reason: 'roleNeedsAgent' };
  const label = ids.length === 0 ? source.name : target.label;
  const { id: roleId, counters } = nextId(next, 'role');
  const {
    id: _sourceId,
    name: _sourceName,
    harness,
    ...fields
  } = JSON.parse(JSON.stringify(source)) as AgentRole;
  const keep = harness !== undefined && (options.resolvesHarness?.(harness) ?? false);
  const role: AgentRole = { id: roleId, name: label, ...fields, ...(keep ? { harness } : {}) };
  const previous = target.roleId;
  const nodes = next.definition.nodes.map((n) =>
    n.id === target.id ? { ...target, label, roleId } : n,
  );
  const stillUsed = nodes.some((n) => n.type === 'agent' && n.roleId === previous);
  // The copy takes the previous role's place in the list, or sits right after it.
  const roles = next.definition.roles.flatMap((r) =>
    r.id !== previous ? [r] : stillUsed ? [r, role] : [role],
  );
  if (!roles.includes(role)) roles.push(role);
  const { planOwnerRoleId, ...definition } = next.definition;
  const owner = planOwnerRoleId === previous && !stillUsed ? undefined : planOwnerRoleId;
  return {
    ok: true,
    nodeId: target.id,
    droppedHarness: harness !== undefined && !keep,
    draft: withDefinition(
      { ...next, counters },
      { ...definition, ...(owner ? { planOwnerRoleId: owner } : {}), nodes, roles },
    ),
  };
}

// ── settings ─────────────────────────────────────────────────────────────────

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
