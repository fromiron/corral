import {
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  isWorkAgent,
  type LoopNode,
  type SharedOutrider,
  type TeamSource,
} from '@corral/contracts';
import { decisionPortsOf, isBox } from '@corral/core';

interface CalledRow {
  kind: 'called';
  nodeId: string;
  callerId: string;
  calls: CalledRow[];
}

interface DecisionBranch {
  edgeId: string;
  port: string;
  routeLabel?: string;
  /** The actual wire end, and the step it leads to through an unambiguous exit/repeat. */
  targetId: string;
  destinationId: string;
}

export type RosterStep = { nodeId: string } & (
  | { kind: 'agent' | 'callable'; calls: CalledRow[] }
  | { kind: 'decision'; branches: DecisionBranch[] }
  | ({ kind: 'loop'; children: RosterRow[] } & Pick<
      LoopNode,
      'maxIterations' | 'limitPolicy' | 'stallDetection'
    >)
  | { kind: 'team'; children: RosterRow[] }
  | { kind: 'reference'; source: Extract<TeamSource, { kind: 'reference' }> }
  | { kind: 'join' }
);

interface ParallelGroup {
  kind: 'parallel';
  sourceId: string;
  port: string;
  branches: { edgeId: string; targetId: string; rows: RosterRow[] }[];
}

export type RosterRow = RosterStep | ParallelGroup;

export interface Roster {
  steps: RosterRow[];
  unconnected: RosterStep[];
  outputs: {
    nodeId: string;
    connected: boolean;
    bindings: { name: string; producerId: string | null }[];
  }[];
  advice: { shared: SharedOutrider['targets'] | null; observerIds: string[] };
}

type Wires = Map<string, Map<string, ControlEdge[]>>;

function append<K, V>(index: Map<K, V[]>, key: K, value: V) {
  const existing = index.get(key);
  if (existing) existing.push(value);
  else index.set(key, [value]);
}

/** One row per caller/callee pair. Expand a helper's own calls at one occurrence only. */
function callsOf(definition: CorralDefinition, nodes: Map<string, CorralNode>) {
  const targets = new Map<string, Set<string>>();
  for (const link of definition.capabilityLinks) {
    const target = nodes.get(link.targetNodeId);
    if (
      link.kind === 'advise' ||
      !isWorkAgent(nodes.get(link.sourceNodeId)) ||
      target?.type !== 'agent' ||
      target.invocation !== 'callable'
    )
      continue;
    const group = targets.get(link.sourceNodeId);
    if (group) group.add(target.id);
    else targets.set(link.sourceNodeId, new Set([target.id]));
  }
  const calls = new Map<string, CalledRow[]>();
  const nested = new Set<string>();
  const open = new Set<string>();
  const begin = (id: string) => {
    const children: CalledRow[] = [];
    calls.set(id, children);
    open.add(id);
    return { id, children, next: targets.get(id)?.values() };
  };
  const visit = (rootId: string) => {
    const stack = [begin(rootId)];
    for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
      const next = frame.next?.next();
      if (!next || next.done) {
        open.delete(frame.id);
        stack.pop();
        continue;
      }
      const id = next.value;
      // A recursive or repeated call names its callee without repeating its descendants.
      const expand = !open.has(id) && !nested.has(id);
      if (expand) nested.add(id);
      let children = calls.get(id);
      if (!children) {
        const child = begin(id);
        children = child.children;
        stack.push(child);
      }
      frame.children.push({
        kind: 'called',
        callerId: frame.id,
        nodeId: id,
        calls: expand ? children : [],
      });
    }
  };
  for (const n of nodes.values()) {
    if (isWorkAgent(n) && n.invocation === 'scheduled' && targets.has(n.id)) visit(n.id);
  }
  for (const n of nodes.values()) {
    if (isWorkAgent(n) && n.invocation === 'callable' && !calls.has(n.id) && targets.has(n.id))
      visit(n.id);
  }
  return { calls, nested };
}

/** Use the compiler's distinction between entering a box and arriving at its exit. Entering
 * exposes the body and the continuation; a wire leaving an inner box cannot enter it backwards. */
function reachable(entry: string, nodes: Map<string, CorralNode>, wires: Wires) {
  const reached = new Set<string>();
  const bodies = new Set<string>();
  const queue = [{ id: entry, exit: false }];
  for (const { id, exit } of queue) {
    if (!nodes.has(id)) continue;
    const inside = !exit && !bodies.has(id);
    const outside = !reached.has(id);
    if (!inside && !outside) continue;
    if (inside) bodies.add(id);
    reached.add(id);
    for (const [port, edges] of wires.get(id) ?? []) {
      if (port === 'body' ? !inside : !outside) continue;
      for (const edge of edges) {
        if (edge.targetPort !== 'repeat')
          queue.push({ id: edge.target, exit: edge.targetPort === 'exit' });
      }
    }
  }
  return reached;
}

/** Merge points close one fan-out, not every enclosing fan-out. Exclusive decision paths
 * carrying the same branch stay in it even when they meet. */
interface Lane {
  rows: RosterRow[];
  parent: Lane | null;
}

function fillScope(
  box: string | null,
  members: string[],
  root: RosterRow[],
  wires: Wires,
  steps: Map<string, RosterStep>,
) {
  const pending = new Map(members.map((id) => [id, 0]));
  const outgoing = new Map<string, ControlEdge[][]>();
  const index = (id: string, body: boolean) => {
    for (const [port, all] of wires.get(id) ?? []) {
      if ((port === 'body') !== body) continue;
      const edges = all.filter(
        (e) => pending.has(e.target) && e.targetPort !== 'repeat' && e.targetPort !== 'exit',
      );
      if (!edges.length) continue;
      append(outgoing, id, edges);
      if (!body) for (const e of edges) pending.set(e.target, (pending.get(e.target) ?? 0) + 1);
    }
  };
  if (box !== null) index(box, true);
  for (const id of members) index(id, false);

  const arrivals = new Map<string, (Lane | null)[]>();
  const lanes = new Map<string, Lane | null>();
  const groupsBefore = new Map<string, { row: ParallelGroup; lane: Lane | null }[]>();
  const ready = members.filter((id) => pending.get(id) === 0);
  const send = (sourceId: string, lane: Lane | null) => {
    for (const edges of outgoing.get(sourceId) ?? []) {
      const first = edges[0] as ControlEdge;
      const group: ParallelGroup | null =
        edges.length > 1
          ? { kind: 'parallel', sourceId, port: first.sourcePort, branches: [] }
          : null;
      if (group) append(groupsBefore, first.target, { row: group, lane });
      for (const e of edges) {
        let child = lane;
        if (group) {
          child = { parent: lane, rows: [] };
          group.branches.push({ edgeId: e.id, targetId: e.target, rows: child.rows });
        }
        append(arrivals, e.target, child);
        if (sourceId !== box) {
          const remaining = (pending.get(e.target) as number) - 1;
          pending.set(e.target, remaining);
          if (!remaining) ready.push(e.target);
        }
      }
    }
  };
  if (box !== null) send(box, null);
  for (const id of ready) {
    const incoming = arrivals.get(id) ?? [];
    const first = incoming[0] ?? null;
    const lane = incoming.every((v) => v === first)
      ? first
      : first && incoming.every((v) => v?.parent === first.parent)
        ? first.parent
        : null;
    lanes.set(id, lane);
    send(id, lane);
  }
  // Topology determines membership only. It never picks a display order. On an unfinished
  // cycle there is no dependable lane; still show its steps, once each, in the outline order.
  for (const id of members) {
    for (const { row, lane } of groupsBefore.get(id) ?? []) (lane?.rows ?? root).push(row);
    const step = steps.get(id);
    if (step) (lanes.get(id)?.rows ?? root).push(step);
  }
}

/** `order` is the full, uncollapsed `outlineOrder`. No second layout, sort or compiler pass:
 * every node, binding, call and control edge is visited a bounded number of times. */
export function rosterOf(definition: CorralDefinition, order: ReadonlyMap<string, number>): Roster {
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const slots: (CorralNode | undefined)[] = new Array(nodes.size);
  const missing: CorralNode[] = [];
  for (const n of nodes.values()) {
    const i = order.get(n.id);
    if (i !== undefined && Number.isInteger(i) && i >= 0 && i < slots.length && !slots[i])
      slots[i] = n;
    else missing.push(n);
  }
  const ordered = slots.filter((n): n is CorralNode => n !== undefined).concat(missing);
  const incoming = new Map<string, ControlEdge[]>();
  for (const e of definition.controlEdges) {
    const source = nodes.get(e.source);
    const target = nodes.get(e.target);
    if (
      !source ||
      !target ||
      (source.type === 'agent' && source.invocation !== 'scheduled') ||
      (target.type === 'agent' && target.invocation !== 'scheduled')
    )
      continue;
    append(incoming, e.target, e);
  }
  const wires: Wires = new Map();
  for (const n of ordered) {
    for (const e of incoming.get(n.id) ?? []) {
      let ports = wires.get(e.source);
      if (!ports) {
        ports = new Map();
        wires.set(e.source, ports);
      }
      append(ports, e.sourcePort, e);
    }
  }
  const reached = reachable(definition.entryNodeId, nodes, wires);
  const { calls, nested } = callsOf(definition, nodes);
  const destinations = new Map<string, string>();
  const destination = (edge: ControlEdge) => {
    let at = edge;
    let id = at.target;
    const path = new Set<string>();
    while (isBox(nodes.get(id)) && (at.targetPort === 'repeat' || at.targetPort === 'exit')) {
      const key = `${id}\0${at.targetPort}`;
      const known = destinations.get(key);
      if (known !== undefined) {
        id = known;
        break;
      }
      if (path.has(key)) break;
      path.add(key);
      const next = wires.get(id)?.get(at.targetPort === 'repeat' ? 'body' : 'next');
      if (next?.length !== 1) break;
      at = next[0] as ControlEdge;
      id = at.target;
    }
    for (const key of path) destinations.set(key, id);
    return id;
  };

  const result: Roster = {
    steps: [],
    unconnected: [],
    outputs: [],
    advice: { shared: definition.sharedOutrider?.targets ?? null, observerIds: [] },
  };
  const steps = new Map<string, RosterStep>();
  const members = new Map<string | null, string[]>();
  for (const n of ordered) {
    const nodeId = n.id;
    let step: RosterStep;
    switch (n.type) {
      case 'output':
        result.outputs.push({
          nodeId,
          connected: reached.has(nodeId),
          bindings: n.inputBindings.map((b) => ({
            name: b.name,
            producerId: b.sourceNodeId && nodes.has(b.sourceNodeId) ? b.sourceNodeId : null,
          })),
        });
        if (reached.has(nodeId)) append(members, n.parentId ?? null, nodeId);
        continue;
      case 'agent':
        if (n.invocation === 'observer') {
          result.advice.observerIds.push(nodeId);
          continue;
        }
        if (n.invocation === 'callable' && nested.has(nodeId)) continue;
        step = {
          kind: n.invocation === 'callable' ? 'callable' : 'agent',
          nodeId,
          calls: calls.get(nodeId) ?? [],
        };
        break;
      case 'decision': {
        const labels =
          n.mode === 'router' ? new Map(n.routes.map((route) => [route.id, route.label])) : null;
        const branches: DecisionBranch[] = [];
        const ports = wires.get(nodeId);
        // Use the decision's port order, not the order in which the wires were drawn.
        for (const port of new Set([...decisionPortsOf(n), ...(ports?.keys() ?? [])])) {
          const routeLabel = labels?.get(port);
          for (const e of ports?.get(port) ?? [])
            branches.push({
              edgeId: e.id,
              port,
              ...(routeLabel !== undefined && { routeLabel }),
              targetId: e.target,
              destinationId: destination(e),
            });
        }
        step = { kind: 'decision', nodeId, branches };
        break;
      }
      case 'loop':
        step = {
          kind: 'loop',
          nodeId,
          maxIterations: n.maxIterations,
          limitPolicy: n.limitPolicy,
          stallDetection: n.stallDetection,
          children: [],
        };
        break;
      case 'team':
        step =
          n.source.kind === 'reference'
            ? { kind: 'reference', nodeId, source: n.source }
            : { kind: 'team', nodeId, children: [] };
        break;
      case 'join':
        step = { kind: 'join', nodeId };
        break;
    }
    steps.set(nodeId, step);
    if (step.kind !== 'callable' && reached.has(nodeId))
      append(members, n.parentId ?? null, nodeId);
  }
  // Only real, reachable inline boxes own rows. Missing or cyclic parents in a draft cannot
  // swallow their steps or turn a reference Team into an expandable box.
  const placed = new Set<string>();
  const scopes: { box: string | null; rows: RosterRow[] }[] = [{ box: null, rows: result.steps }];
  for (const { box, rows } of scopes) {
    const siblings = members.get(box);
    if (!siblings) continue;
    fillScope(box, siblings, rows, wires, steps);
    for (const id of siblings) {
      placed.add(id);
      const step = steps.get(id);
      if (step?.kind === 'team' || step?.kind === 'loop')
        scopes.push({ box: id, rows: step.children });
    }
  }
  for (const id of nodes.keys()) {
    const step = steps.get(id);
    if (step && !placed.has(id)) result.unconnected.push(step);
  }
  return result;
}
