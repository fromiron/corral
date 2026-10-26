import type { CorralDefinition, NodeLayout } from '@corral/contracts';

// Where the Run graph draws each node. A run keeps its definition but not a layout, so
// the Run page uses the Corral's saved layout when it places every node of the run, and arranges
// the nodes itself otherwise. Positions never carry meaning, so either is honest as
// long as the page says which one it shows.

export interface RunCanvasLayout {
  source: 'saved' | 'auto';
  nodes: Record<string, NodeLayout>;
}

const STEP_X = 230;
const NODE_W = 190;
const NODE_H = 110;
const LOOP_PAD_X = 30;
const LOOP_HEAD = 70;
const LOOP_PAD_Y = 40;
const TOP = 40;
const LEFT = 20;

export function runCanvasLayout(
  definition: CorralDefinition,
  saved: Record<string, NodeLayout> | null | undefined,
): RunCanvasLayout {
  if (saved && definition.nodes.every((node) => saved[node.id])) {
    return {
      source: 'saved',
      nodes: Object.fromEntries(
        definition.nodes.map((node) => [node.id, saved[node.id] as NodeLayout]),
      ),
    };
  }
  return { source: 'auto', nodes: autoLayout(definition) };
}

/** Longest-path rank of each node reachable from `starts` over `edges`, ignoring cycles. */
function ranks(starts: string[], edges: [string, string][]): Map<string, number> {
  const rank = new Map(starts.map((id) => [id, 0]));
  // Bounded relaxation: a back edge can raise a rank at most once per node.
  for (let pass = 0; pass <= edges.length; pass++) {
    let changed = false;
    for (const [from, to] of edges) {
      const r = rank.get(from);
      if (r === undefined) continue;
      if ((rank.get(to) ?? -1) < r + 1 && r + 1 <= edges.length) {
        rank.set(to, r + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

function columns(rank: Map<string, number>): string[][] {
  const cols: string[][] = [];
  for (const [id, r] of rank) {
    const col = cols[r] ?? [];
    col.push(id);
    cols[r] = col;
  }
  return cols.filter(Boolean);
}

/**
 * Positions for every node: the control flow left to right, each Loop as a box around its
 * members, callable agents in a row underneath. Shared by the Run page and the editor's
 * "Tidy up".
 */
export function autoLayout(definition: CorralDefinition): Record<string, NodeLayout> {
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const loopOf = (id: string) => {
    const node = nodes.get(id);
    return node && 'loopId' in node ? (node.loopId ?? null) : null;
  };
  const out: Record<string, NodeLayout> = {};

  // Each Loop is drawn as a box holding its members in their own control order.
  const loopBoxes = new Map<
    string,
    { width: number; height: number; place(x: number, y: number): void }
  >();
  for (const loop of definition.nodes.filter((n) => n.type === 'loop')) {
    const members = definition.nodes.filter((n) => loopOf(n.id) === loop.id).map((n) => n.id);
    const memberSet = new Set(members);
    const inner = definition.controlEdges
      .filter((e) => memberSet.has(e.source) && memberSet.has(e.target))
      .map((e): [string, string] => [e.source, e.target]);
    const starts = definition.controlEdges
      .filter((e) => e.source === loop.id && e.sourcePort === 'body' && memberSet.has(e.target))
      .map((e) => e.target);
    const rank = ranks(starts.length ? starts : members.slice(0, 1), inner);
    for (const id of members) if (!rank.has(id)) rank.set(id, Math.max(0, ...rank.values()) + 1);
    const cols = columns(rank);
    const tallest = Math.max(1, ...cols.map((c) => c.length));
    const width = LOOP_PAD_X * 2 + Math.max(1, cols.length) * STEP_X - (STEP_X - NODE_W);
    const height = LOOP_HEAD + tallest * NODE_H + LOOP_PAD_Y - (NODE_H - 80);
    loopBoxes.set(loop.id, {
      width,
      height,
      place(x, y) {
        out[loop.id] = { x, y, width, height };
        cols.forEach((col, c) => {
          col.forEach((id, row) => {
            out[id] = { x: x + LOOP_PAD_X + c * STEP_X, y: y + LOOP_HEAD + row * NODE_H };
          });
        });
      },
    });
  }

  // The outer flow: scheduled nodes outside Loops, with a Loop standing for its members.
  // Edges back into a Loop (repeat/exit) come from inside it and are not part of the outer flow.
  const outer = definition.controlEdges
    .filter((e) => !loopOf(e.source) && !loopOf(e.target) && e.sourcePort !== 'body')
    .map((e): [string, string] => [e.source, e.target]);
  const entry = nodes.has(definition.entryNodeId) ? [definition.entryNodeId] : [];
  const rank = ranks(entry, outer);
  let x = LEFT;
  let bottom = TOP;
  for (const col of columns(rank)) {
    let y = TOP;
    let colWidth = NODE_W;
    for (const id of col) {
      const box = loopBoxes.get(id);
      if (box) {
        box.place(x, y);
        y += box.height + 40;
        colWidth = Math.max(colWidth, box.width);
      } else {
        // Single nodes line up with the members inside a Loop box beside them.
        out[id] = { x, y: y + LOOP_HEAD };
        y += NODE_H + LOOP_HEAD;
      }
    }
    bottom = Math.max(bottom, y);
    x += colWidth + (STEP_X - NODE_W);
  }

  // Callable agents and anything the flow does not reach go in a row underneath.
  let rowX = LEFT;
  for (const node of definition.nodes) {
    if (out[node.id]) continue;
    const box = loopBoxes.get(node.id);
    if (box) {
      box.place(rowX, bottom + 20);
      rowX += box.width + (STEP_X - NODE_W);
    } else {
      out[node.id] = { x: rowX, y: bottom + 20 };
      rowX += STEP_X;
    }
  }
  return out;
}
