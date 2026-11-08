import type { CorralDefinition, CorralNode, TargetPort } from '@corral/contracts';
import type { Diagnostic } from '@corral/core';
import { animate, useReducedMotion } from 'motion/react';
import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { type Bounds, useGraphViewport, ZoomControls } from '../components/GraphViewport.tsx';
import { AgentCard, Button, KitBadge, useSize } from '../design-kit/index.ts';
import { focusRing } from '../design-kit/lib/focus.ts';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import { tween } from '../design-kit/lib/springs.ts';
import { cn } from '../design-kit/lib/utils.ts';
import { ChevronDown, ChevronRight, CircleAlert, Plus, TriangleAlert } from '../ui/icons.ts';
import type { EditRejection, Placement, PortRequest, StepKind } from './commands.ts';
import { KIND_COLOR, KIND_ICON, kindOf, membersOf, roleOf } from './kinds.ts';
import {
  boundsOf,
  type LaidItem,
  layoutTeam,
  type PortMark,
  type Rect,
  routeTeam,
} from './layout.ts';

// The team editor's canvas (docs/specs/features/team-graph.md). Layout is automatic: the canvas
// only turns pointer and keyboard input into structural edits and shows where they would land.

export interface TeamSelection {
  nodes: string[];
  edge: string | null;
}

export const STEP_DRAG_TYPE = 'application/x-corral-step';

type Check = { ok: true } | { ok: false; reason: EditRejection };

export interface TeamGraphCanvasProps {
  definition: CorralDefinition;
  diagnostics: readonly Diagnostic[];
  selection: TeamSelection;
  onSelect: (selection: TeamSelection) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (boxId: string) => void;
  /** The step being dragged from the palette, while it is. */
  dragging: StepKind | null;
  canPlace: (kind: StepKind, at: Placement) => Check;
  onPlace: (kind: StepKind, at: Placement) => void;
  /** Asks which step to add at this place (the command menu). */
  onRequestAdd: (at: Placement) => void;
  canConnect: (request: PortRequest) => Check;
  onConnect: (request: PortRequest) => void;
  onDelete: (ids: string[]) => void;
  /** How much of the canvas's right side a floating panel covers. */
  insetRight?: number;
}

type Shown = LaidItem & { opacity?: number };

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** Moves the items from where they were drawn to their new places, redrawing as they go. */
function useTweenedItems(items: Map<string, LaidItem>, reduced: boolean): Map<string, Shown> {
  const [shown, setShown] = useState<Map<string, Shown>>(items);
  const drawn = useRef<Map<string, Shown>>(items);
  useLayoutEffect(() => {
    const from = drawn.current;
    if (reduced || from === items) {
      drawn.current = items;
      setShown(items);
      return;
    }
    const step = (p: number) => {
      const next = new Map<string, Shown>();
      for (const [id, to] of items) {
        const was = from.get(id);
        if (!was) {
          next.set(id, { ...to, opacity: p });
          continue;
        }
        next.set(id, {
          ...to,
          rect: {
            x: lerp(was.rect.x, to.rect.x, p),
            y: lerp(was.rect.y, to.rect.y, p),
            w: lerp(was.rect.w, to.rect.w, p),
            h: lerp(was.rect.h, to.rect.h, p),
          },
          mainY: lerp(was.mainY, to.mainY, p),
        });
      }
      drawn.current = next;
      setShown(next);
    };
    const controls = animate(0, 1, {
      duration: tween.slow.duration,
      ease: tween.slow.ease,
      onUpdate: step,
      onComplete: () => {
        drawn.current = items;
        setShown(items);
      },
    });
    return () => controls.stop();
  }, [items, reduced]);
  return shown;
}

const within = (r: Rect, p: { x: number; y: number }, slack = 0) =>
  p.x >= r.x - slack && p.x <= r.x + r.w + slack && p.y >= r.y - slack && p.y <= r.y + r.h + slack;

export function TeamGraphCanvas({
  definition,
  diagnostics,
  selection,
  onSelect,
  collapsed,
  onToggle,
  dragging,
  canPlace,
  onPlace,
  onRequestAdd,
  canConnect,
  onConnect,
  onDelete,
  insetRight = 0,
}: TeamGraphCanvasProps) {
  const t = useTranslations('TeamEditor');
  const portName = useTranslations('Canvas.ports');
  const codeText = useTranslations('Validation.codes');
  const size = useSize();
  const reduced = useReducedMotion() ?? false;
  const markerId = useId().replace(/:/g, '');

  const layout = useMemo(() => layoutTeam(definition, collapsed), [definition, collapsed]);
  const items = useTweenedItems(layout.items, reduced);
  const routed = useMemo(
    () => routeTeam(definition, items, collapsed),
    [definition, items, collapsed],
  );
  const nodes = useMemo(() => new Map(definition.nodes.map((n) => [n.id, n])), [definition]);

  const { pane, viewport, setViewport, fit, zoomAt, paneHandlers } = useGraphViewport({
    bounds: () => {
      const b = boundsOf(layout.items);
      return b.w ? { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h } : null;
    },
    ready: true,
    onTap: (event) => {
      if (!event.shiftKey && (selection.nodes.length || selection.edge))
        onSelect({ nodes: [], edge: null });
    },
    canPan: (event) => !event.shiftKey,
  });
  const toStage = (clientX: number, clientY: number) => {
    const rect = pane.current?.getBoundingClientRect();
    const v = viewport ?? { x: 0, y: 0, k: 1 };
    return {
      x: (clientX - (rect?.left ?? 0) - v.x) / v.k,
      y: (clientY - (rect?.top ?? 0) - v.y) / v.k,
    };
  };

  // Problems: the worst one per node and per connection, with every message for its title.
  const problems = useMemo(() => {
    const byId = new Map<string, { severity: Diagnostic['severity']; text: string[] }>();
    for (const d of diagnostics) {
      const id = d.nodeId ?? d.edgeId ?? d.linkId;
      if (!id) continue;
      const text = codeText.has(d.code) ? codeText(d.code, { message: d.message }) : d.message;
      const entry = byId.get(id) ?? { severity: 'warning', text: [] };
      if (d.severity === 'error') entry.severity = 'error';
      entry.text.push(text);
      byId.set(id, entry);
    }
    // A collapsed box shows the worst problem inside it.
    for (const boxId of collapsed) {
      for (const member of membersOf(definition, boxId)) {
        const inner = byId.get(member.id);
        if (!inner) continue;
        const entry = byId.get(boxId) ?? { severity: 'warning', text: [] };
        if (inner.severity === 'error') entry.severity = 'error';
        entry.text.push(...inner.text);
        byId.set(boxId, entry);
      }
    }
    return byId;
  }, [diagnostics, codeText, collapsed, definition]);

  const selected = useMemo(() => new Set(selection.nodes), [selection.nodes]);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);

  // ── keep the selection in view ────────────────────────────────────────────
  const lastSelected = selection.nodes.at(-1);
  const view = useRef(viewport);
  view.current = viewport;
  useEffect(() => {
    const element = pane.current;
    const viewport = view.current;
    const item = lastSelected ? layout.items.get(lastSelected) : undefined;
    if (!element || !item || !viewport) return;
    const { x, y, w, h } = item.rect;
    const k = viewport.k;
    const left = x * k + viewport.x;
    const top = y * k + viewport.y;
    const margin = 32;
    let dx = 0;
    let dy = 0;
    const right = element.clientWidth - margin - insetRight;
    if (left < margin) dx = margin - left;
    else if (left + w * k > right) dx = Math.max(margin - left, right - (left + w * k));
    if (top < margin) dy = margin - top;
    else if (top + h * k > element.clientHeight - margin)
      dy = element.clientHeight - margin - (top + h * k);
    // Only a new selection or a new layout moves the view; panning by hand never snaps back.
    if (dx || dy) setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy });
  }, [lastSelected, layout.items, setViewport, pane, insetRight]);

  // ── dropping a step from the palette ─────────────────────────────────────
  const [drop, setDrop] = useState<{
    at: Placement;
    check: Check;
    point: { x: number; y: number };
  } | null>(null);
  useEffect(() => {
    if (!dragging) setDrop(null);
  }, [dragging]);
  const placementAt = (point: { x: number; y: number }): Placement => {
    let best: { id: string; d: number } | null = null;
    for (const edge of layout.edges) {
      if (!edge.insertAt || edge.kind !== 'control') continue;
      const d = Math.hypot(edge.insertAt.x - point.x, edge.insertAt.y - point.y);
      if (d < 28 && (!best || d < best.d)) best = { id: edge.id, d };
    }
    if (best) return { kind: 'edge', edgeId: best.id };
    let box: LaidItem | null = null;
    for (const item of layout.items.values()) {
      if (!within(item.rect, point)) continue;
      if (item.kind !== 'box') return { kind: 'after', nodeId: item.id };
      if (!box || item.depth > box.depth) box = item;
    }
    return box ? { kind: 'into', boxId: box.id } : { kind: 'empty' };
  };
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragging || !event.dataTransfer.types.includes(STEP_DRAG_TYPE)) return;
    event.preventDefault();
    const point = toStage(event.clientX, event.clientY);
    const at = placementAt(point);
    const check = canPlace(dragging, at);
    event.dataTransfer.dropEffect = check.ok ? 'copy' : 'none';
    setDrop((current) =>
      current && JSON.stringify(current.at) === JSON.stringify(at) && current.check.ok === check.ok
        ? { ...current, point }
        : { at, check, point },
    );
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const kind = event.dataTransfer.getData(STEP_DRAG_TYPE) as StepKind;
    if (!kind) return;
    event.preventDefault();
    const at = placementAt(toStage(event.clientX, event.clientY));
    setDrop(null);
    if (canPlace(kind, at).ok) onPlace(kind, at);
  };

  // ── connecting by dragging a port ────────────────────────────────────────
  const [wire, setWire] = useState<{
    from: PortMark;
    to: { x: number; y: number };
    request: PortRequest | null;
    check: Check | null;
    /** The input ports this output may lead to, worked out when the drag starts. */
    reachable: Set<string>;
  } | null>(null);
  const inMarks = routed.ports.filter((p) => p.side === 'in');
  const requestAt = (from: PortMark, point: { x: number; y: number }): PortRequest | null => {
    let best: { mark: PortMark; d: number } | null = null;
    for (const mark of inMarks) {
      const d = Math.hypot(mark.at.x - point.x, mark.at.y - point.y);
      if (d < 24 && (!best || d < best.d)) best = { mark, d };
    }
    const ask = (target: string, targetPort: TargetPort) => ({
      source: from.nodeId,
      sourcePort: from.port,
      target,
      targetPort,
    });
    if (best) return ask(best.mark.nodeId, best.mark.port as TargetPort);
    let box: LaidItem | null = null;
    for (const item of items.values()) {
      if (!within(item.rect, point)) continue;
      if (item.kind === 'node') {
        const node = nodes.get(item.id);
        return node && node.type !== 'loop' && node.type !== 'team' ? ask(item.id, 'in') : null;
      }
      if (item.kind === 'tile') return ask(item.id, 'enter');
      if (!box || item.depth > box.depth) box = item;
    }
    if (!box) return null;
    const source = nodes.get(from.nodeId);
    const inside = source ? membersOf(definition, box.id).some((n) => n.id === source.id) : false;
    return ask(box.id, inside ? 'exit' : 'enter');
  };
  const startWire = (event: ReactPointerEvent<HTMLElement>, from: PortMark) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const reachable = new Set<string>();
    for (const mark of inMarks) {
      const check = canConnect({
        source: from.nodeId,
        sourcePort: from.port,
        target: mark.nodeId,
        targetPort: mark.port as TargetPort,
      });
      if (check.ok) reachable.add(`${mark.nodeId}:${mark.port}`);
    }
    setWire({ from, to: from.at, request: null, check: null, reachable });
  };
  const moveWire = (event: ReactPointerEvent<HTMLElement>) => {
    if (!wire) return;
    const point = toStage(event.clientX, event.clientY);
    const request = requestAt(wire.from, point);
    setWire({ ...wire, to: point, request, check: request ? canConnect(request) : null });
  };
  const endWire = () => {
    if (wire?.request && wire.check?.ok) onConnect(wire.request);
    setWire(null);
  };

  // ── selecting by dragging a frame ────────────────────────────────────────
  const [frame, setFrame] = useState<{
    id: number;
    from: { x: number; y: number };
    to: { x: number; y: number };
  } | null>(null);
  const onPanePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const empty = !(event.target as Element).closest('button, [data-edge]');
    if (event.shiftKey && empty && event.button === 0) {
      const point = toStage(event.clientX, event.clientY);
      setFrame({ id: event.pointerId, from: point, to: point });
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    paneHandlers.onPointerDown(event);
  };
  const onPanePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (frame && frame.id === event.pointerId) {
      setFrame({ ...frame, to: toStage(event.clientX, event.clientY) });
      return;
    }
    paneHandlers.onPointerMove(event);
  };
  const onPanePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (frame && frame.id === event.pointerId) {
      const r = {
        x: Math.min(frame.from.x, frame.to.x),
        y: Math.min(frame.from.y, frame.to.y),
        w: Math.abs(frame.to.x - frame.from.x),
        h: Math.abs(frame.to.y - frame.from.y),
      };
      const hit = [...layout.items.values()]
        .filter(
          (i) =>
            i.rect.x >= r.x &&
            i.rect.y >= r.y &&
            i.rect.x + i.rect.w <= r.x + r.w &&
            i.rect.y + i.rect.h <= r.y + r.h,
        )
        .map((i) => i.id);
      setFrame(null);
      if (r.w > 3 || r.h > 3)
        onSelect({ nodes: [...new Set([...selection.nodes, ...hit])], edge: null });
      return;
    }
    paneHandlers.onPointerUp(event);
  };

  // ── keyboard ──────────────────────────────────────────────────────────────
  const focusNode = (id: string) => {
    pane.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('input, textarea, [contenteditable]')) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const ids = selection.edge ? [selection.edge] : selection.nodes;
      if (!ids.length) return;
      event.preventDefault();
      onDelete(ids);
      onSelect({ nodes: [], edge: null });
      return;
    }
    if (event.key === 'Escape') {
      if (wire) setWire(null);
      else onSelect({ nodes: [], edge: null });
      return;
    }
    const step = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[
      event.key
    ];
    const current = lastSelected ? layout.items.get(lastSelected) : undefined;
    if (!step || !current) return;
    event.preventDefault();
    const [sx, sy] = step as [number, number];
    const cx = current.rect.x + current.rect.w / 2;
    const cy = current.rect.y + current.rect.h / 2;
    let best: { id: string; score: number } | null = null;
    for (const item of layout.items.values()) {
      if (item.id === current.id) continue;
      const dx = item.rect.x + item.rect.w / 2 - cx;
      const dy = item.rect.y + item.rect.h / 2 - cy;
      const along = dx * sx + dy * sy;
      if (along <= 1) continue;
      const across = Math.abs(dx * sy) + Math.abs(dy * sx);
      const score = along + across * 2;
      if (!best || score < best.score) best = { id: item.id, score };
    }
    if (!best) return;
    onSelect({ nodes: [best.id], edge: null });
    focusNode(best.id);
  };

  const select = (event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, id: string) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      const next = selected.has(id)
        ? selection.nodes.filter((n) => n !== id)
        : [...selection.nodes, id];
      onSelect({ nodes: next, edge: null });
    } else onSelect({ nodes: [id], edge: null });
  };

  // ── drawing ───────────────────────────────────────────────────────────────
  const bounds: Bounds | null = layout.bounds.w
    ? {
        minX: layout.bounds.x,
        minY: layout.bounds.y,
        maxX: layout.bounds.x + layout.bounds.w,
        maxY: layout.bounds.y + layout.bounds.h,
      }
    : null;
  const ordered = [...items.values()].sort((a, b) => a.depth - b.depth);
  const boxes = ordered.filter((i) => i.kind === 'box');
  const cards = ordered.filter((i) => i.kind !== 'box');
  const problemMark = (id: string) => {
    const problem = problems.get(id);
    if (!problem) return null;
    const Icon = problem.severity === 'error' ? CircleAlert : TriangleAlert;
    return (
      <span
        data-problem={problem.severity}
        title={problem.text.join('\n')}
        className={cn(
          'inline-flex shrink-0',
          problem.severity === 'error' ? 'text-destructive' : 'text-warning',
        )}
      >
        <Icon size={14} aria-hidden />
        <span className="sr-only">{problem.text.join(' ')}</span>
      </span>
    );
  };
  const kindName = (node: CorralNode) => t(`kinds.${kindOf(node)}`);
  const summary = (node: CorralNode): string => {
    switch (node.type) {
      case 'agent':
        return roleOf(definition, node)?.modelProfile ?? t('noModel');
      case 'decision':
        return kindName(node);
      case 'loop':
        return t('rounds', { count: node.maxIterations });
      case 'team':
        return node.source.kind === 'inline'
          ? t('inline')
          : t('reference', { revision: node.source.definitionRevision });
      case 'join':
        return t(node.policy === 'all' ? 'joinAll' : 'joinAny');
      case 'output':
        return node.requireApproval ? t('approvalRequired') : kindName(node);
    }
  };
  const detail = (node: CorralNode): string => {
    if (node.type === 'agent') return roleOf(definition, node)?.prompt.split('\n')[0] ?? '';
    if (node.type === 'loop' || node.type === 'team')
      return membersOf(definition, node.id)
        .filter((n) => n.parentId === node.id)
        .map((n) => n.label)
        .join(' · ');
    if (node.type === 'decision' && node.mode === 'check') return node.checkIds.join(', ');
    if (node.type === 'decision' && node.mode === 'router')
      return node.routes.map((r) => r.label).join(' · ');
    return '';
  };
  const outPorts = routed.ports.filter((p) => p.side === 'out');
  const edgeStroke = (id: string) =>
    selection.edge === id
      ? 'var(--emphasis)'
      : problems.get(id)?.severity === 'error'
        ? 'var(--destructive)'
        : 'color-mix(in oklab, var(--muted-foreground) 70%, transparent)';
  const shownInserter = (id: string) =>
    !dragging && !wire && (hoverEdge === id || selection.edge === id);

  // Why the connection or the drop under the pointer would be refused, shown beside the pointer.
  const refusal: { reason: EditRejection; at: { x: number; y: number } } | null =
    wire?.check && !wire.check.ok
      ? { reason: wire.check.reason, at: wire.to }
      : drop && !drop.check.ok
        ? { reason: drop.check.reason, at: drop.point }
        : null;

  return (
    <div
      ref={pane}
      data-team-canvas
      role="application"
      aria-label={t('canvas')}
      aria-roledescription={t('canvasRole')}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas takes arrow, Delete and Escape keys itself.
      tabIndex={0}
      className="relative h-full min-h-0 w-full touch-none overflow-hidden select-none outline-none"
      style={{
        backgroundImage: 'radial-gradient(circle, var(--border) 1px, transparent 1px)',
        backgroundSize: `${18 * (viewport?.k ?? 1)}px ${18 * (viewport?.k ?? 1)}px`,
        backgroundPosition: `${viewport?.x ?? 0}px ${viewport?.y ?? 0}px`,
      }}
      onPointerDown={onPanePointerDown}
      onPointerMove={onPanePointerMove}
      onPointerUp={onPanePointerUp}
      onPointerCancel={onPanePointerUp}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={onDrop}
      onKeyDown={onKeyDown}
    >
      {viewport ? (
        <div
          data-graph-stage
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})` }}
        >
          {boxes.map((item) => {
            const node = nodes.get(item.id) as CorralNode;
            const kind = kindOf(node);
            const Icon = KIND_ICON[kind];
            const isSelected = selected.has(item.id);
            const target =
              drop && drop.at.kind === 'into' && drop.at.boxId === item.id ? drop : null;
            return (
              <div
                key={item.id}
                data-box={item.id}
                className={cn(
                  'absolute rounded-[14px] border',
                  isSelected ? 'border-emphasis' : 'border-border',
                  target && (target.check.ok ? 'border-emphasis' : 'border-destructive'),
                )}
                style={{
                  transform: `translate(${item.rect.x}px, ${item.rect.y}px)`,
                  width: item.rect.w,
                  height: item.rect.h,
                  opacity: item.opacity,
                  background: `color-mix(in oklab, ${kind === 'loop' ? 'var(--info, #3b82f6)' : '#14b8a6'} ${target?.check.ok ? 10 : 4}%, transparent)`,
                }}
              >
                <div className="flex h-11 items-center gap-2 pr-2 pl-3">
                  <button
                    type="button"
                    data-node={item.id}
                    aria-pressed={isSelected}
                    className={cn(
                      focusRing,
                      size.type.body,
                      'flex min-w-0 items-center gap-2 rounded-md px-1 text-left text-foreground',
                    )}
                    onClick={(event) => select(event, item.id)}
                  >
                    <Icon size={14} aria-hidden className="shrink-0 text-muted-foreground" />
                    <span
                      className="truncate"
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      {node.label}
                    </span>
                    <span className="sr-only">{kindName(node)}</span>
                  </button>
                  {problemMark(item.id)}
                  <KitBadge size="compact" color="gray">
                    {summary(node)}
                  </KitBadge>
                  {node.type === 'loop' && node.budget?.maxModelCalls ? (
                    <KitBadge size="compact" color="gray">
                      {t('budgetCalls', { count: node.budget.maxModelCalls })}
                    </KitBadge>
                  ) : null}
                  <span className="grow" />
                  <Button
                    variant="ghost"
                    size="icon-compact"
                    aria-label={t('collapse', { name: node.label })}
                    aria-expanded
                    onClick={() => onToggle(item.id)}
                  >
                    <ChevronDown />
                  </Button>
                </div>
              </div>
            );
          })}
          <svg
            className="pointer-events-none absolute top-0 left-0 overflow-visible"
            width={Math.max(1, (bounds?.maxX ?? 0) + 200)}
            height={Math.max(1, (bounds?.maxY ?? 0) + 200)}
            aria-hidden
          >
            <defs>
              {[
                ['n', 'color-mix(in oklab, var(--muted-foreground) 70%, transparent)'],
                ['s', 'var(--emphasis)'],
                ['e', 'var(--destructive)'],
              ].map(([key, color]) => (
                <marker
                  key={key}
                  id={`${markerId}-${key}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M1 1 L9 5 L1 9"
                    fill="none"
                    stroke={color}
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </marker>
              ))}
            </defs>
            {routed.edges.map((edge) => {
              const stroke = edgeStroke(edge.id);
              const marker =
                selection.edge === edge.id
                  ? 's'
                  : problems.get(edge.id)?.severity === 'error'
                    ? 'e'
                    : 'n';
              return (
                <g key={edge.id} data-edge={edge.id}>
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the inspector lists each connection with its own controls. */}
                  <path
                    d={edge.path}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    style={{
                      pointerEvents: wire || dragging ? 'none' : 'stroke',
                      cursor: 'pointer',
                    }}
                    onPointerEnter={() => setHoverEdge(edge.id)}
                    onPointerLeave={() => setHoverEdge((h) => (h === edge.id ? null : h))}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onSelect({ nodes: [], edge: edge.id })}
                  />
                  <path
                    d={edge.path}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={selection.edge === edge.id ? 2 : 1.5}
                    strokeDasharray={edge.kind === 'call' ? '4 4' : undefined}
                    markerEnd={edge.arrow ? `url(#${markerId}-${marker})` : undefined}
                  />
                  {edge.label ? (
                    <text
                      x={edge.label.at.x}
                      y={edge.label.at.y}
                      className="fill-muted-foreground"
                      fontSize={11}
                    >
                      {t(`links.${edge.label.text}`)}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {wire ? (
              <path
                d={`M${wire.from.at.x} ${wire.from.at.y} L${wire.to.x} ${wire.to.y}`}
                fill="none"
                stroke={wire.check && !wire.check.ok ? 'var(--destructive)' : 'var(--emphasis)'}
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            ) : null}
            {frame ? (
              <rect
                x={Math.min(frame.from.x, frame.to.x)}
                y={Math.min(frame.from.y, frame.to.y)}
                width={Math.abs(frame.to.x - frame.from.x)}
                height={Math.abs(frame.to.y - frame.from.y)}
                fill="color-mix(in oklab, var(--emphasis) 8%, transparent)"
                stroke="var(--emphasis)"
                strokeDasharray="3 3"
              />
            ) : null}
          </svg>
          {cards.map((item) => {
            const node = nodes.get(item.id) as CorralNode;
            const kind = kindOf(node);
            const Icon = KIND_ICON[kind];
            const isSelected = selected.has(item.id);
            const target =
              drop && drop.at.kind === 'after' && drop.at.nodeId === item.id ? drop : null;
            const wired = wire?.request?.target === item.id ? wire : null;
            const ring =
              (target && !target.check.ok) || (wired && !wired.check?.ok)
                ? 'outline-2 outline-destructive'
                : isSelected || target || wired
                  ? 'outline-2 outline-emphasis'
                  : '';
            if (node.type === 'join')
              return (
                <button
                  key={item.id}
                  type="button"
                  data-node={item.id}
                  aria-pressed={isSelected}
                  className={cn(focusRing, 'absolute text-left')}
                  style={{
                    transform: `translate(${item.rect.x}px, ${item.rect.y}px)`,
                    width: item.rect.w,
                    height: item.rect.h,
                    opacity: item.opacity,
                  }}
                  onClick={(event) => select(event, item.id)}
                >
                  <AgentCard
                    className={cn(
                      size.type.caption,
                      'flex h-full items-center gap-2 px-3 text-foreground',
                      ring && `outline ${ring}`,
                    )}
                  >
                    <Icon size={14} aria-hidden className="text-muted-foreground" />
                    <span className="truncate">{node.label}</span>
                    {problemMark(item.id)}
                  </AgentCard>
                </button>
              );
            const ports =
              node.type === 'decision' ? outPorts.filter((p) => p.nodeId === node.id) : [];
            return (
              <button
                key={item.id}
                type="button"
                data-node={item.id}
                aria-pressed={isSelected}
                className={cn(focusRing, 'absolute rounded-[12px] text-left')}
                style={{
                  transform: `translate(${item.rect.x}px, ${item.rect.y}px)`,
                  width: item.rect.w,
                  height: item.rect.h,
                  opacity: item.opacity,
                }}
                onClick={(event) => select(event, item.id)}
              >
                <AgentCard
                  className={cn(
                    'grid h-full content-start gap-0.5 px-3 py-2.5',
                    ring && `outline ${ring}`,
                    kind === 'callable' && 'border-dashed',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Icon size={14} aria-hidden className="shrink-0 text-muted-foreground" />
                    <span
                      className={cn(size.type.body, 'truncate text-foreground')}
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      {node.label}
                    </span>
                    {problemMark(item.id)}
                    <span className="grow" />
                    {item.kind === 'tile' ? <span aria-hidden className="size-5 shrink-0" /> : null}
                  </span>
                  <span className={cn(size.type.caption, 'flex min-w-0 items-center gap-1.5')}>
                    <span
                      className={cn(
                        'truncate',
                        node.type === 'agent' && !roleOf(definition, node)?.modelProfile
                          ? 'text-destructive'
                          : 'text-muted-foreground',
                      )}
                    >
                      {summary(node)}
                    </span>
                    {definition.entryNodeId === node.id ? (
                      <KitBadge size="compact" color={KIND_COLOR.output}>
                        {t('start')}
                      </KitBadge>
                    ) : null}
                    {node.type === 'agent' && node.retry?.maxAttempts ? (
                      <KitBadge size="compact" color="gray">
                        {t('retry', { count: node.retry.maxAttempts })}
                      </KitBadge>
                    ) : null}
                  </span>
                  <span
                    className={cn(size.type.caption, 'truncate text-muted-foreground')}
                    style={{ maxWidth: ports.length ? item.rect.w - 72 : undefined }}
                  >
                    {detail(node)}
                  </span>
                  {ports.map((port) => (
                    <span
                      key={port.port}
                      aria-hidden
                      className={cn(
                        size.type.micro,
                        'absolute right-2.5 -translate-y-1/2 text-muted-foreground',
                      )}
                      style={{ top: port.at.y - item.rect.y }}
                    >
                      {node.type === 'decision' && node.mode === 'router'
                        ? (node.routes.find((r) => r.id === port.port)?.label ?? port.port)
                        : portName(port.port)}
                    </span>
                  ))}
                </AgentCard>
              </button>
            );
          })}
          {outPorts.map((port) => {
            const key = `${port.nodeId}:${port.port}`;
            const active = wire?.from.nodeId === port.nodeId && wire.from.port === port.port;
            const bottom = port.port === 'error' || port.port === 'exhausted';
            return (
              // A pointer shortcut: the inspector's connection list does the same from the keyboard.
              <span
                key={key}
                data-port={key}
                aria-hidden
                title={portName(port.port)}
                className={cn(
                  'absolute z-10 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border bg-background transition-transform',
                  active
                    ? 'scale-125 border-emphasis'
                    : 'border-muted-foreground/60 hover:scale-125',
                  bottom ? 'size-2.5' : 'size-3',
                )}
                style={{ left: port.at.x, top: port.at.y }}
                onPointerDown={(event) => startWire(event, port)}
                onPointerMove={moveWire}
                onPointerUp={endWire}
                onPointerCancel={() => setWire(null)}
              />
            );
          })}
          {cards
            .filter((item) => {
              // A reference team is always a tile: its inside is edited in its own editor.
              const node = nodes.get(item.id);
              return (
                item.kind === 'tile' && !(node?.type === 'team' && node.source.kind === 'reference')
              );
            })
            .map((item) => (
              <Button
                key={`expand-${item.id}`}
                variant="ghost"
                size="icon-compact"
                aria-label={t('expand', { name: nodes.get(item.id)?.label ?? item.id })}
                aria-expanded={false}
                className="absolute z-10 size-6"
                style={{ left: item.rect.x + item.rect.w - 32, top: item.rect.y + 7 }}
                onClick={() => onToggle(item.id)}
              >
                <ChevronRight size={14} />
              </Button>
            ))}
          {wire
            ? inMarks.map((mark) => {
                const key = `${mark.nodeId}:${mark.port}`;
                const ok = wire.reachable.has(key);
                const hit =
                  wire.request?.target === mark.nodeId && wire.request.targetPort === mark.port;
                return (
                  <span
                    key={key}
                    aria-hidden
                    className={cn(
                      'pointer-events-none absolute z-10 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2',
                      ok ? 'border-emphasis bg-background' : 'border-border bg-muted opacity-40',
                      hit && ok && 'scale-150 bg-emphasis',
                    )}
                    style={{ left: mark.at.x, top: mark.at.y }}
                  />
                );
              })
            : null}
          {routed.edges.map((edge) =>
            edge.insertAt && edge.kind === 'control' && (shownInserter(edge.id) || dragging) ? (
              <Button
                key={`insert-${edge.id}`}
                variant={
                  drop?.at.kind === 'edge' && drop.at.edgeId === edge.id ? 'primary' : 'secondary'
                }
                size="icon-compact"
                aria-label={t('insertHere')}
                className="absolute z-20 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ left: edge.insertAt.x, top: edge.insertAt.y }}
                onPointerEnter={() => setHoverEdge(edge.id)}
                onPointerLeave={() => setHoverEdge((h) => (h === edge.id ? null : h))}
                onClick={() => onRequestAdd({ kind: 'edge', edgeId: edge.id })}
              >
                <Plus size={14} />
              </Button>
            ) : null,
          )}
        </div>
      ) : null}
      {layout.items.size === 0 ? (
        <div className="absolute inset-0 grid place-items-center">
          <Button variant="secondary" onClick={() => onRequestAdd({ kind: 'empty' })}>
            <Plus /> {t('addFirst')}
          </Button>
        </div>
      ) : null}
      {refusal && viewport ? (
        <p
          role="status"
          className={cn(
            size.type.caption,
            'pointer-events-none absolute z-30 max-w-64 rounded-md border border-border bg-background px-2 py-1 text-destructive shadow-sm',
          )}
          style={{
            left: refusal.at.x * viewport.k + viewport.x + 14,
            top: refusal.at.y * viewport.k + viewport.y + 14,
          }}
        >
          {t(`rejected.${refusal.reason}`)}
        </p>
      ) : null}
      {viewport && layout.items.size ? (
        <ZoomControls
          labels={{ zoomIn: t('zoomIn'), zoomOut: t('zoomOut'), fit: t('fit') }}
          onZoom={(factor) => zoomAt(factor)}
          onFit={fit}
        />
      ) : null}
    </div>
  );
}
