import { Maximize2, Minimize2, X } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';

// The workbench frame (02-UX-Spec §1–§2): projects and sessions on the left, the work in the
// middle, and a side panel on the right. Both sides can be resized (pointer or arrow keys) and
// hidden; the widths and choices are remembered in this browser. Below 1024px one area shows
// at a time, chosen from a tab row, so nothing is squeezed.

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** A view preference kept in this browser; never a fact about a run (02-UX-Spec §9). */
export function useRemembered<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [state, setValue] = useState(() => ({ key, value: stored(key, fallback) }));
  const value = state.key === key ? state.value : stored(key, fallback);
  if (state.key !== key) setValue({ key, value });
  const set = useCallback(
    (next: T) => {
      setValue({ key, value: next });
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Remembered for this page only.
      }
    },
    [key],
  );
  return [value, set];
}

const RIGHT = { initial: 360, min: 280, max: 720 };

function Resizer({
  label,
  value,
  bounds,
  onChange,
  invert = false,
}: {
  label: string;
  value: number;
  bounds: { min: number; max: number };
  onChange: (value: number) => void;
  /** The right panel grows when dragged left. */
  invert?: boolean;
}) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (n: number) => Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    onChange(clamp(value + (invert ? -delta : delta)));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    start.current = { x: event.clientX, value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const delta = event.clientX - start.current.x;
    onChange(clamp(start.current.value + (invert ? -delta : delta)));
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter is the WAI-ARIA window splitter pattern
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        start.current = null;
      }}
      className="hidden w-1 shrink-0 cursor-col-resize bg-line/40 hover:bg-accent focus-visible:bg-accent lg:block"
    />
  );
}

type Area = 'main' | 'panel';

/**
 * T3's main-column / docked-panel composition. App navigation is owned by RootLayout; the page
 * owns whether the panel is open (it is closed until asked for) and its tabs, shown as the
 * panel's only header row.
 */
export function WorkbenchLayout({
  main,
  panel,
  panelTabs,
  panelOpen = false,
  onPanelClose,
  storageKey = 'global',
}: {
  main: ReactNode;
  panel?: ReactNode;
  panelTabs?: ReactNode;
  panelOpen?: boolean;
  onPanelClose?: () => void;
  storageKey?: string;
}) {
  const t = useTranslations('Workbench');
  const td = useTranslations('Desktop');
  const [savedRight, setRight] = useRemembered(`corral:wb:right:${storageKey}`, 400);
  const right =
    typeof savedRight === 'number' && Number.isFinite(savedRight)
      ? Math.min(RIGHT.max, Math.max(RIGHT.min, savedRight))
      : 400;
  const [maximized, setMaximized] = useState(false);
  const [area, setArea] = useState<Area>('main');
  const open = Boolean(panel) && panelOpen;
  const shown: Area = open ? area : 'main';
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {open ? (
        <div
          role="tablist"
          aria-label={t('areas')}
          className="flex shrink-0 items-center gap-1 border-b border-line/50 px-3 py-1 lg:hidden"
        >
          {(['main', 'panel'] as Area[]).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={shown === name}
              onClick={() => setArea(name)}
              className={`rounded-md px-3 py-1.5 text-xs ${shown === name ? 'bg-sidebar-selected text-text' : 'text-muted'}`}
            >
              {name === 'main' ? td('conversation') : td('panel')}
            </button>
          ))}
        </div>
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div
          className={`${shown === 'main' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col ${open && maximized ? 'lg:hidden' : 'lg:flex'}`}
        >
          {main}
        </div>
        {open ? (
          <>
            {!maximized ? (
              <Resizer
                label={t('resizePanel')}
                value={right}
                bounds={RIGHT}
                onChange={setRight}
                invert
              />
            ) : null}
            <aside
              aria-label={t('panelTabs')}
              style={{ '--wb-right': `${right}px` } as CSSProperties}
              className={`${shown === 'panel' ? 'flex' : 'hidden'} min-h-0 w-full shrink-0 flex-col border-l border-line/60 bg-surface ${maximized ? 'lg:flex lg:flex-1' : 'lg:flex lg:w-[var(--wb-right)]'}`}
            >
              <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line/50 pr-2 pl-1">
                <div className="min-w-0 flex-1 overflow-x-auto">{panelTabs}</div>
                <div className="flex items-center max-lg:hidden">
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label={maximized ? td('restore') : td('maximize')}
                    onClick={() => setMaximized((v) => !v)}
                  >
                    {maximized ? <Minimize2 /> : <Maximize2 />}
                  </Button>
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label={t('collapsePanel')}
                    onClick={() => {
                      setMaximized(false);
                      onPanelClose?.();
                    }}
                  >
                    <X />
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">{panel}</div>
            </aside>
          </>
        ) : null}
      </div>
    </div>
  );
}
