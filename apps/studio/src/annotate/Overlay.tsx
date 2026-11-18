// The overlay's drawing over the page area (features/browser-annotate.md 사용자 관측 동작): the
// frame, the hover or keyboard outline with its name tag, the markers, the busy line. One full-size
// surface alone takes the pointer, the wheel and the page area's keys; everything drawn over it
// lets the pointer through to it.
import { Banner, BannerTitle } from '@corral/react/design-kit';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type {
  AnnotateBridge,
  AnnotatePoint,
  AnnotateRect,
  AnnotateTarget,
} from '../../../desktop/src/annotate-bridge.ts';
import type { Frames } from './AnnotateApp.tsx';
import { framePath, markerPlaces, outlineRect, type Size, tagPlace } from './geometry.ts';
import type { AnnotateContext } from './protocol.ts';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const ARROWS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
} as const;

function useArea(): Size {
  const [area, setArea] = useState<Size>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const resize = () => setArea({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return area;
}

const sameRect = (a: AnnotateRect | null | undefined, b: AnnotateRect | null | undefined) =>
  a === b ||
  (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

function sameBoxes(
  a: Record<string, AnnotateRect | null>,
  b: Record<string, AnnotateRect | null>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameRect(a[key], b[key]));
}

/** A polite live region; the same words twice are said twice. */
function useAnnouncer() {
  const [said, setSaid] = useState({ text: '', n: 0 });
  const announce = useCallback((text: string) => setSaid((last) => ({ text, n: last.n + 1 })), []);
  return { said, announce };
}

export function Overlay({
  bridge,
  frames,
  context,
  busy,
  ending,
  navigation,
  focusRequest,
  onExited,
}: {
  bridge: AnnotateBridge;
  frames: Frames;
  newId: () => string;
  context: AnnotateContext;
  page: { kind: 'page' | 'preview'; generation: number } | null;
  busy: boolean;
  ending: boolean;
  navigation: number;
  focusRequest: number;
  onExited: () => void;
}) {
  const t = useTranslations('Annotate');
  const area = useArea();
  const surface = useRef<HTMLElement>(null);
  const { said, announce } = useAnnouncer();
  const [outline, setOutline] = useState<{
    target: AnnotateTarget;
    from: 'pointer' | 'keys';
  } | null>(null);
  const [boxes, setBoxes] = useState<Record<string, AnnotateRect | null>>({});

  // What the frame loop reads without restarting: the pointer (null outside the page area, stale
  // after a keyboard move until it moves again), the read in flight, and an epoch that a leave, a
  // keyboard move or a navigation bumps so an older answer's hover is dropped.
  const live = useRef({
    pointer: null as AnnotatePoint | null,
    stale: false,
    pending: false,
    epoch: 0,
    stopped: false,
    track: [] as string[],
  });
  live.current.stopped = busy || ending;
  live.current.track = context.markers.map((marker) => marker.pickId);

  useEffect(() => {
    const state = live.current;
    let mounted = true;
    const stop = frames(() => {
      if (state.pending || state.stopped || document.hidden) return;
      const pointer = state.pointer && !state.stale ? state.pointer : null;
      const track = state.track;
      if (!pointer && track.length === 0) return;
      state.pending = true;
      const epoch = state.epoch;
      bridge.frame({ pointer, track }).then(
        (answer) => {
          state.pending = false;
          // Null: the read was skipped or the page didn't answer; what is drawn stays.
          if (!mounted || !answer) return;
          if (pointer && epoch === state.epoch && !state.stopped)
            setOutline((last) => {
              const hover = answer.hover;
              if (!hover) return null;
              if (
                last?.from === 'pointer' &&
                last.target.label === hover.label &&
                sameRect(last.target.box, hover.box)
              )
                return last;
              return { target: hover, from: 'pointer' };
            });
          setBoxes((last) => (sameBoxes(last, answer.boxes) ? last : answer.boxes));
        },
        () => {
          state.pending = false;
        },
      );
    });
    return () => {
      mounted = false;
      stop();
    };
  }, [bridge, frames]);

  // Markers: a pick whose chip went (present, then absent) is let go; one not there yet stays.
  const shown = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(context.markers.map((marker) => marker.pickId));
    for (const pickId of shown.current) if (!now.has(pickId)) void bridge.release(pickId);
    shown.current = now;
  }, [bridge, context.markers]);

  useEffect(() => {
    if (!busy) return;
    live.current.epoch++;
    setOutline(null);
    announce(t('busy'));
  }, [busy, t, announce]);

  useEffect(() => {
    if (navigation === 0) return;
    live.current.epoch++;
    setOutline(null);
  }, [navigation]);

  useEffect(() => {
    if (focusRequest > 0) surface.current?.focus();
  }, [focusRequest]);

  const walk = (direction: 'up' | 'down' | 'left' | 'right') => {
    live.current.stale = true;
    live.current.epoch++;
    void bridge.walk(direction).then((target) => {
      if (!target || live.current.stopped) return;
      setOutline({ target, from: 'keys' });
      announce(target.name ? `${target.label}, ${target.name}` : target.label);
    });
  };

  const closeOne = () => {
    void bridge.end();
  };

  const markers = useMemo(
    () =>
      markerPlaces(
        context.markers.flatMap(({ pickId, n }) => {
          const box = boxes[pickId];
          return box ? [{ pickId, n, box }] : [];
        }),
        area,
      ),
    [context.markers, boxes, area],
  );

  return (
    <div className="fixed inset-0 overflow-hidden">
      <section
        ref={surface}
        data-annotate="surface"
        aria-label={t('area')}
        tabIndex={-1}
        className="absolute inset-0 outline-none"
        onPointerMove={(event) => {
          live.current.pointer = { x: event.clientX, y: event.clientY };
          live.current.stale = false;
        }}
        onPointerLeave={() => {
          live.current.pointer = null;
          live.current.epoch++;
          setOutline((last) => (last?.from === 'pointer' ? null : last));
        }}
        onWheel={(event) => {
          bridge.wheel({
            x: event.clientX,
            y: event.clientY,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode as 0 | 1 | 2,
          });
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          const direction = ARROWS[event.key as keyof typeof ARROWS];
          if (direction && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            walk(direction);
          } else if (event.key === 'Escape' && !event.shiftKey) {
            event.preventDefault();
            closeOne();
          }
        }}
      />
      <PageFrame area={area} ending={ending} onExited={onExited} />
      {busy && (
        <div data-annotate="busy" className="pointer-events-none absolute inset-x-0 top-0">
          <Banner variant="fixed" status="warning" role="note">
            <BannerTitle>{t('busy')}</BannerTitle>
          </Banner>
        </div>
      )}
      {outline && !busy && !ending && <Outline target={outline.target} area={area} />}
      {!ending && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          {markers.map((marker) => (
            <span
              key={marker.pickId}
              data-annotate="marker"
              style={{ transform: `translate(${marker.x}px, ${marker.y}px)` }}
              className="absolute left-0 top-0"
            >
              <span className="annotate-pop flex size-[18px] items-center justify-center rounded-full bg-emphasis font-mono text-micro tabular-nums text-background forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]">
                {marker.n}
              </span>
            </span>
          ))}
        </div>
      )}
      <div data-annotate="announcer" role="status" aria-live="polite" className="sr-only">
        <span key={said.n}>{said.text}</span>
      </div>
    </div>
  );
}

/** The page area's frame: drawn once around from the top right corner, faded on the way out. */
function PageFrame({
  area,
  ending,
  onExited,
}: {
  area: Size;
  ending: boolean;
  onExited: () => void;
}) {
  const frame = useRef<SVGSVGElement>(null);
  const exited = useRef(onExited);
  exited.current = onExited;
  useEffect(() => {
    const element = frame.current;
    if (!element || !ending) return;
    const done = (event: Event) => {
      if (event.target === element) exited.current();
    };
    element.addEventListener('animationend', done);
    return () => element.removeEventListener('animationend', done);
  }, [ending]);
  if (ending && reducedMotion()) return null;
  return (
    <svg
      ref={frame}
      data-annotate="frame"
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 size-full${ending ? ' annotate-leave' : ''}`}
    >
      <path
        d={framePath(area)}
        pathLength={1}
        fill="none"
        strokeWidth={2}
        className="annotate-draw stroke-emphasis forced-colors:stroke-[Highlight]"
      />
    </svg>
  );
}

/** The outline 3px outside the element's border box, and its name tag. */
function Outline({ target, area }: { target: AnnotateTarget; area: Size }) {
  const rect = outlineRect(target.box);
  const tag = useRef<HTMLSpanElement>(null);
  const [tagSize, setTagSize] = useState<Size>({ width: 0, height: 18 });
  useLayoutEffect(() => {
    const box = tag.current?.getBoundingClientRect();
    if (box && (box.width !== tagSize.width || (box.height && box.height !== tagSize.height)))
      setTagSize({ width: box.width, height: box.height || tagSize.height });
  });
  const place = tagPlace(rect, tagSize, area);
  return (
    <>
      <div
        data-annotate="outline"
        style={{
          transform: `translate(${rect.x}px, ${rect.y}px)`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        }}
        className="pointer-events-none absolute left-0 top-0 border-2 border-emphasis transition-[transform,width,height] duration-(--duration-moderate) ease-(--ease-out-soft) motion-reduce:transition-none forced-colors:border-[Highlight]"
      />
      <span
        ref={tag}
        data-annotate="tag"
        style={{ transform: `translate(${place.x}px, ${place.y}px)` }}
        className="pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-sm bg-emphasis px-1.5 py-0.5 font-mono text-micro text-background transition-transform duration-(--duration-moderate) ease-(--ease-out-soft) motion-reduce:transition-none forced-colors:border forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]"
      >
        {target.label}
      </span>
    </>
  );
}
