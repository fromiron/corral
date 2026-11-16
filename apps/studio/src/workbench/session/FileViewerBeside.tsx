import { Button, fontWeights, Tooltip } from '@corral/react/design-kit';
import { RefreshCw, X } from '@corral/react/icons';
import {
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { TopbarSlotContext } from '../TopbarSlot.tsx';
import { useContainerStep } from '../useContainerAtLeast.ts';

// The session's read-only file viewer beside the work area (workbench.md). It sits beside only
// while the work area keeps its minimum width; without that room it gives way and the work area
// stays, and it comes back when the room returns. Pressed without room, it opens as a drawer over
// the work area's right edge while the work area stays in place behind a scrim.

/** The narrowest the work area gets with the viewer beside it. */
export const WORK_AREA_MIN_WIDTH = 560;
/** The viewer's own width, beside the work area or as a drawer over it. */
export const FILE_VIEWER_WIDTH = 384;
/** A row narrower than this gives the drawer its whole width. */
export const DRAWER_FULL_WIDTH_BELOW = 640;

/** The row's widths that change the viewer: one observer measures both. */
const ROW_STEPS = [DRAWER_FULL_WIDTH_BELOW, WORK_AREA_MIN_WIDTH + FILE_VIEWER_WIDTH] as const;

/**
 * closed: not wanted. beside: wanted, with room. away: wanted, without room, so the work area
 * stays. drawer: opened without room, over the work area's right edge until closed or room
 * appears; the work area stays in place, inert.
 */
export type FileViewerState = 'closed' | 'beside' | 'away' | 'drawer';

export interface FileViewerPlacement {
  state: FileViewerState;
  /** Whether the viewer is on screen: what the top bar's button shows. */
  open: boolean;
  /** The person opening or closing the viewer. */
  toggle: (open: boolean) => void;
  /** Kept mounted once wanted, so it keeps its folder and file while closed or away. */
  mounted: boolean;
  /** A row too narrow for a drawer beside some of the work area: the drawer takes all of it. */
  narrow: boolean;
  row: RefObject<HTMLDivElement | null>;
  /** The work area: inert behind a drawer, and where focus goes back to after one. */
  work: RefObject<HTMLDivElement | null>;
  aside: RefObject<HTMLElement | null>;
}

/** The viewer's one-line head, given the panel's own refresh. */
export type FileViewerHead = (refresh: () => void) => ReactNode;

/**
 * Where the viewer is, from the remembered wish and the row's own width (not the window's: the
 * sidebar changes it). `key` names whose wish it is; a drawer belongs to that key only.
 */
export function useFileViewerPlacement(
  key: string,
  wish: boolean,
  remember: (open: boolean) => void,
): FileViewerPlacement {
  const row = useRef<HTMLDivElement>(null);
  const work = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  // Measured before paint, so a remembered viewer without room never shows before it gives way.
  const step = useContainerStep(row, ROW_STEPS);
  const room = step === ROW_STEPS.length;
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const [visited, setVisited] = useState(false);
  const drawer = wish && !room && drawerKey === key;
  // Room, a closed viewer or another key ends the drawer: losing the room later gives way instead.
  if (drawerKey !== null && !drawer) setDrawerKey(null);
  const state: FileViewerState = !wish ? 'closed' : room ? 'beside' : drawer ? 'drawer' : 'away';
  const { actions } = useContext(TopbarSlotContext);
  const tdock = useTranslations('Docking');
  const openLabel = tdock('openFileViewer');
  const closeLabel = tdock('closeFileViewer');
  // Where focus was in the work area when a drawer opened, to go back to when it closes.
  const returnTo = useRef<HTMLElement | null>(null);
  const previous = useRef(state);
  // A drawer opened from inside the work area takes focus, which the inert work area would lose.
  // Giving way or closing hides the viewer: focus inside it would fall to the page, so it goes
  // back to where it was in the work area after a drawer, else to the top bar's button. Closing
  // from the bar's own button, or from elsewhere, leaves focus be.
  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (state === 'drawer') {
      // The drawer itself, as a dialog's popup takes it: named on arrival, its controls a Tab away.
      if (was !== 'drawer' && returnTo.current) aside.current?.focus();
      return;
    }
    const back = was === 'drawer' ? returnTo.current : null;
    returnTo.current = null;
    if (state !== 'away' && state !== 'closed') return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !aside.current?.contains(focused)) return;
    const target =
      back?.isConnected && work.current?.contains(back)
        ? back
        : focusOutOfViewer(aside.current, row.current, actions, [openLabel, closeLabel]);
    target?.focus();
  }, [state, actions, openLabel, closeLabel]);
  // Escape closes a drawer unless something already used it; a popup opened from the viewer sits
  // outside it and closes itself first.
  useEffect(() => {
    if (state !== 'drawer') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      const ours =
        target === document.body ||
        (target instanceof Node &&
          Boolean(aside.current?.contains(target) || actions?.contains(target)));
      if (!ours) return;
      event.preventDefault();
      remember(false);
      setDrawerKey(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state, actions, remember]);
  return {
    state,
    open: state === 'beside' || state === 'drawer',
    toggle: (open) => {
      setVisited(true);
      remember(open);
      const intoDrawer = open && !room;
      setDrawerKey(intoDrawer ? key : null);
      if (!open) return;
      // Read before the work area turns inert, which would take focus out of it.
      const focused = document.activeElement;
      returnTo.current =
        intoDrawer && focused instanceof HTMLElement && work.current?.contains(focused)
          ? focused
          : null;
    },
    mounted: wish || visited,
    narrow: step === 0,
    row,
    work,
    aside,
  };
}

const FOCUSABLE = 'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * Where focus inside the hidden viewer goes, or null when focus is not in it: the top bar's viewer
 * button, found by its labels; in a bar folded into its more menu, that menu; else the work area.
 */
function focusOutOfViewer(
  viewer: HTMLElement | null,
  row: HTMLElement | null,
  actions: HTMLElement | null,
  labels: readonly string[],
): HTMLElement | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !viewer?.contains(focused)) return null;
  const buttons = [...(actions?.querySelectorAll<HTMLElement>('button') ?? [])];
  return (
    buttons.find((button) => labels.includes(button.getAttribute('aria-label') ?? '')) ??
    buttons.findLast((button) => button.getAttribute('aria-haspopup') === 'menu') ??
    [...(row?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find(
      (element) => !viewer.contains(element),
    ) ??
    null
  );
}

/** The work area with the viewer beside it, or the viewer as a drawer over its right edge. */
export function FileViewerRow({
  viewer,
  panel,
  children,
}: {
  viewer: FileViewerPlacement;
  /** The viewer's content, which puts the head (given its own refresh) at its top. */
  panel: (head: FileViewerHead) => ReactNode;
  /** The work area; it stays mounted and in place in every state: its tab, scroll and draft. */
  children: ReactNode;
}) {
  const tdock = useTranslations('Docking');
  const t = useTranslations('Desktop');
  const drawer = viewer.state === 'drawer';
  const close = () => viewer.toggle(false);
  const head: FileViewerHead = (refresh) => (
    <div className="mb-1 flex min-w-0 items-center gap-2">
      <h2
        className="shrink-0 text-subtitle"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {tdock('fileViewer')}
      </h2>
      <span className="min-w-0 truncate text-caption text-muted-foreground">
        {tdock('fileViewerSource')}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Tooltip content={t('refreshFiles')}>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={t('refreshFiles')}
            onClick={refresh}
          >
            <RefreshCw />
          </Button>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon-compact"
          aria-label={tdock('closeFileViewer')}
          onClick={close}
        >
          <X />
        </Button>
      </div>
    </div>
  );
  return (
    <div ref={viewer.row} className="relative flex h-full min-h-0 min-w-0 flex-1">
      <div
        ref={viewer.work}
        inert={drawer}
        // Its own stacking context, so nothing raised inside it paints over the scrim.
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${drawer ? 'isolate' : ''}`}
      >
        {children}
      </div>
      {drawer ? (
        // A press outside the drawer closes it; the scrim never takes focus from where it is.
        <div
          data-file-viewer-scrim=""
          aria-hidden
          className="absolute inset-0 z-20 bg-(--dialog-scrim) transition-opacity duration-(--duration-moderate) ease-(--ease-out-soft) starting:opacity-0 motion-reduce:transition-none"
          onMouseDown={(event) => event.preventDefault()}
          onClick={close}
        />
      ) : null}
      {viewer.mounted ? (
        <aside
          ref={viewer.aside}
          hidden={!viewer.open}
          aria-label={tdock('fileViewer')}
          // Focus lands on the drawer itself when it opens from inside the work area.
          tabIndex={-1}
          style={{ width: drawer && viewer.narrow ? '100%' : FILE_VIEWER_WIDTH }}
          className={`min-h-0 max-w-full shrink-0 overflow-auto border-l border-line p-3 focus:outline-none ${
            drawer
              ? 'absolute inset-y-0 right-0 z-20 bg-surface-2 shadow-surface-4 transition-transform duration-(--duration-moderate) ease-(--ease-out-soft) starting:translate-x-full motion-reduce:transition-none'
              : ''
          }`}
        >
          {panel(head)}
        </aside>
      ) : null}
    </div>
  );
}
