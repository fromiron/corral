import { TabsSubtle, TabsSubtleItem } from '@corral/react/design-kit';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

const HEIGHT_KEY = 'corral.run.dockHeight';
const MIN = 160;
const MAX = 720;
const STEP = 24;
const clamp = (value: number, min = MIN, max = MAX) =>
  Math.min(max, Math.max(min, Math.round(value)));

/** The remembered height, or half the window: the graph and the flow need room to read. */
function savedHeight() {
  const value = Number(globalThis.localStorage?.getItem(HEIGHT_KEY));
  if (Number.isFinite(value) && value > 0) return clamp(value);
  return clamp((globalThis.innerHeight || 640) / 2);
}

export interface RunDockView {
  /** Stable identity; counts and localized labels may change while the view is open. */
  id: string;
  label: string;
  render: () => ReactNode;
  testId?: string;
}

/**
 * The run's secondary views under its column: a tab bar that always stays, opening the chosen
 * view under it at a height the person drags or steps with the arrow keys. Pressing the open
 * tab folds it again. Views mount on first opening, then stay mounted while folded, so their
 * first measurement uses the visible area and their position and zoom survive later changes.
 */
export function RunDock({
  idPrefix,
  views,
  trailing,
}: {
  idPrefix: string;
  views: RunDockView[];
  /** Controls at the bar's end. */
  trailing?: ReactNode;
}) {
  const m = useTranslations('RunMonitor');
  const [open, setOpen] = useState<string | null>(null);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [height, setHeight] = useState(savedHeight);
  const section = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [maximum, setMaximum] = useState(MAX);
  const minimum = Math.min(MIN, maximum);
  const shownHeight = clamp(height, minimum, maximum);
  const drag = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  const selectedIndex = views.findIndex((view) => view.id === open);
  useLayoutEffect(() => {
    const column = section.current?.parentElement;
    const tabs = bar.current;
    if (!column || !tabs) return;
    const measure = () => {
      // A hidden column has no size. Keep its last limit until it becomes visible again.
      if (!column.clientHeight) return;
      // Reserve the tab bar, the 8px resize handle and the section border. Keep an activity
      // reading area above the dock; in very short containers each surface gets half the rest.
      const room = Math.max(0, column.clientHeight - tabs.offsetHeight - 9);
      setMaximum(Math.min(MAX, Math.floor(room - Math.min(MIN, room / 2))));
    };
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(column);
    observer.observe(tabs);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  useEffect(() => {
    globalThis.localStorage?.setItem(HEIGHT_KEY, String(height));
  }, [height]);
  return (
    <section
      ref={section}
      data-testid="run-dock"
      aria-label={m('views')}
      className="flex shrink-0 flex-col border-t border-line"
    >
      {open !== null ? (
        // biome-ignore lint/a11y/useSemanticElements: a resizable split is a focusable separator, which <hr> cannot be.
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={m('dockHeight')}
          aria-valuenow={shownHeight}
          aria-valuemin={minimum}
          aria-valuemax={maximum}
          aria-controls={`${idPrefix}-content`}
          tabIndex={0}
          onKeyDown={(event) => {
            const delta = event.key === 'ArrowUp' ? STEP : event.key === 'ArrowDown' ? -STEP : null;
            if (delta === null) return;
            event.preventDefault();
            setHeight(clamp(shownHeight + delta, minimum, maximum));
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = { pointerId: event.pointerId, y: event.clientY, height: shownHeight };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag.current || drag.current.pointerId !== event.pointerId) return;
            setHeight(
              clamp(drag.current.height + drag.current.y - event.clientY, minimum, maximum),
            );
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          className="h-2 shrink-0 cursor-row-resize touch-none select-none transition-colors duration-80 hover:bg-hover focus-visible:bg-active focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]"
        />
      ) : null}
      <div ref={bar} className="flex min-w-0 items-center justify-between gap-2 px-4 py-1.5">
        <TabsSubtle
          idPrefix={idPrefix}
          selectedIndex={selectedIndex}
          onSelect={(index) => {
            const id = views[index]?.id ?? null;
            setOpen(id);
            if (id !== null) setVisited((previous) => new Set(previous).add(id));
          }}
          className="min-w-0 flex-1"
          size="compact"
          aria-label={m('views')}
        >
          {views.map((view, index) => (
            <TabsSubtleItem
              key={view.id}
              index={index}
              label={view.label}
              // The open tab folds the dock again: the tab list does not report a repeat press.
              onClick={() => {
                if (open === view.id) setOpen(null);
              }}
              {...(view.testId ? { 'data-testid': view.testId } : {})}
            />
          ))}
        </TabsSubtle>
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>
      <div
        data-run-dock-content
        id={`${idPrefix}-content`}
        hidden={open === null}
        style={{ height: shownHeight }}
        className="min-h-0 overflow-hidden border-t border-line"
      >
        {views.map((view, index) => (
          <div
            key={view.id}
            id={`${idPrefix}-panel-${index}`}
            role="tabpanel"
            aria-labelledby={`${idPrefix}-tab-${index}`}
            hidden={open !== view.id}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: each scrollable tabpanel needs a keyboard entry point.
            tabIndex={0}
            data-run-dock-panel={view.id}
            className="h-full min-w-0 overflow-auto overscroll-contain px-6 py-4 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]"
          >
            {visited.has(view.id) ? view.render() : null}
          </div>
        ))}
      </div>
    </section>
  );
}
