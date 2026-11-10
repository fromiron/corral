import {
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '../design-kit/index.ts';
import { Maximize2, Minus, Plus } from '../ui/icons.ts';

// The pan and zoom stage shared by the run canvas and the team editor: wheel zooms at the
// pointer, dragging the empty stage pans, and the view fits its content once it has a size.

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const ZOOM = { min: 0.2, max: 2, step: 1.2 } as const;

/** How a fit frames the content: the margin around it and the largest zoom it may choose. */
export interface FitRule {
  padding: number;
  maxZoom: number;
}
const DEFAULT_FIT: FitRule = { padding: 48, maxZoom: 1 };

/** The view that shows `bounds` whole and centred, never enlarged past the rule's zoom. */
export function fitBounds(
  bounds: Bounds | null,
  width: number,
  height: number,
  rule: FitRule = DEFAULT_FIT,
): Viewport {
  if (!bounds || !width || !height) return { x: 0, y: 0, k: 1 };
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const k = Math.min(
    rule.maxZoom,
    Math.max(ZOOM.min, Math.min((width - rule.padding * 2) / w, (height - rule.padding * 2) / h)),
  );
  return {
    x: (width - w * k) / 2 - bounds.minX * k,
    y: (height - h * k) / 2 - bounds.minY * k,
    k,
  };
}

export interface GraphViewportOptions {
  /** The content to fit, read when fitting. */
  bounds: () => Bounds | null;
  /** False while the content is not ready to be fitted. */
  ready: boolean;
  /** Called when the view starts to move by wheel, drag or button. */
  onMove?: () => void;
  /** Called for a press on the empty stage that did not pan. */
  onTap?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Return false to leave a press to the caller instead of panning. */
  canPan?: (event: ReactPointerEvent<HTMLDivElement>) => boolean;
  /** How a fit frames the content. Omitted, a 48px margin and never past 100%. */
  fitRule?: FitRule;
  /**
   * Fit only when first shown and on request. A later change of the pane's size keeps the zoom
   * and the point at the pane's centre instead of fitting again. Omitted, the view refits with
   * the pane until the person moves it.
   */
  fitOnce?: boolean;
}

export function useGraphViewport({
  bounds,
  ready,
  onMove,
  onTap,
  canPan,
  fitRule = DEFAULT_FIT,
  fitOnce = false,
}: GraphViewportOptions) {
  const pane = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const read = useRef({ bounds, onMove, onTap, canPan, fitRule });
  read.current = { bounds, onMove, onTap, canPan, fitRule };

  // Until the person moves the view, it follows the pane: a panel opening beside it refits.
  const moved = useRef(false);
  // With `fitOnce`: whether the first fit happened, and the pane's size when the view was last
  // placed, so a later size change keeps the view's centre.
  const fitted = useRef(false);
  const size = useRef<{ width: number; height: number } | null>(null);
  const fit = useCallback(() => {
    const element = pane.current;
    if (!element) return;
    moved.current = false;
    size.current = { width: element.clientWidth, height: element.clientHeight };
    setViewport(
      fitBounds(
        read.current.bounds(),
        element.clientWidth,
        element.clientHeight,
        read.current.fitRule,
      ),
    );
  }, []);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!ready || !element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width <= 0 || height <= 0) return;
      if (!fitOnce) {
        if (!moved.current) fit();
        return;
      }
      if (!fitted.current) {
        fitted.current = true;
        fit();
        return;
      }
      const last = size.current;
      size.current = { width, height };
      if (!last || (last.width === width && last.height === height)) return;
      setViewport((current) =>
        current
          ? {
              ...current,
              x: current.x + (width - last.width) / 2,
              y: current.y + (height - last.height) / 2,
            }
          : current,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready, fit, fitOnce]);
  const moveTo = useCallback((next: SetStateAction<Viewport | null>) => {
    moved.current = true;
    setViewport(next);
  }, []);

  const zoomAt = useCallback((factor: number, at?: { x: number; y: number }) => {
    read.current.onMove?.();
    moved.current = true;
    setViewport((current) => {
      if (!current) return current;
      const element = pane.current;
      const point = at ?? {
        x: (element?.clientWidth ?? 0) / 2,
        y: (element?.clientHeight ?? 0) / 2,
      };
      const k = Math.min(ZOOM.max, Math.max(ZOOM.min, current.k * factor));
      return {
        k,
        x: point.x - ((point.x - current.x) * k) / current.k,
        y: point.y - ((point.y - current.y) * k) / current.k,
      };
    });
  }, []);
  useEffect(() => {
    const element = pane.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.002), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoomAt]);

  /** Moves the view by a screen distance, as the arrow keys and a drag do. */
  const panBy = useCallback((dx: number, dy: number) => {
    moved.current = true;
    setViewport((value) => (value ? { ...value, x: value.x + dx, y: value.y + dy } : value));
  }, []);

  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    if (read.current.canPan && !read.current.canPan(event)) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 3) return;
    if (!current.moved) read.current.onMove?.();
    moved.current = true;
    current.moved = true;
    current.x = event.clientX;
    current.y = event.clientY;
    panBy(dx, dy);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    if (!current.moved) read.current.onTap?.(event);
  };

  return {
    pane,
    viewport,
    /** Moves the view on the caller's behalf; it stops following the pane's size. */
    setViewport: moveTo,
    fit,
    zoomAt,
    panBy,
    paneHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}

/** The zoom in, zoom out and fit buttons in the stage's corner. */
export function ZoomControls({
  labels,
  onZoom,
  onFit,
  className = 'absolute bottom-3 left-3 flex flex-col gap-1',
}: {
  labels: { zoomIn: string; zoomOut: string; fit: string };
  onZoom: (factor: number) => void;
  onFit: () => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <Button
        variant="secondary"
        size="icon-compact"
        aria-label={labels.zoomIn}
        onClick={() => onZoom(ZOOM.step)}
      >
        <Plus />
      </Button>
      <Button
        variant="secondary"
        size="icon-compact"
        aria-label={labels.zoomOut}
        onClick={() => onZoom(1 / ZOOM.step)}
      >
        <Minus />
      </Button>
      <Button variant="secondary" size="icon-compact" aria-label={labels.fit} onClick={onFit}>
        <Maximize2 />
      </Button>
    </div>
  );
}
