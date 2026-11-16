import { Button, fontWeights } from '@corral/react/design-kit';
import { X } from '@corral/react/icons';
import {
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { TopbarSlotContext } from '../TopbarSlot.tsx';
import { useContainerAtLeast } from '../useContainerAtLeast.ts';

// The session's read-only file viewer beside the work area (workbench.md). It sits beside only
// while the work area keeps its minimum width; without that room it gives way and the work area
// stays, and it comes back when the room returns. Pressed without room, it covers the work area.

/** The narrowest the work area gets with the viewer beside it. */
export const WORK_AREA_MIN_WIDTH = 560;
/** The viewer's own width beside the work area. */
export const FILE_VIEWER_WIDTH = 384;

/**
 * closed: not wanted. beside: wanted, with room. away: wanted, without room, so the work area
 * stays. covering: opened without room, in the work area's place until closed or room appears.
 */
export type FileViewerState = 'closed' | 'beside' | 'away' | 'covering';

export interface FileViewerPlacement {
  state: FileViewerState;
  /** Whether the viewer is on screen: what the top bar's button shows. */
  open: boolean;
  /** The person opening or closing the viewer. */
  toggle: (open: boolean) => void;
  /** Kept mounted once wanted, so it keeps its folder and file while closed or away. */
  mounted: boolean;
  row: RefObject<HTMLDivElement | null>;
  aside: RefObject<HTMLElement | null>;
}

/**
 * Where the viewer is, from the remembered wish and the row's own width (not the window's: the
 * sidebar changes it). `key` names whose wish it is; a covering viewer belongs to that key only.
 */
export function useFileViewerPlacement(
  key: string,
  wish: boolean,
  remember: (open: boolean) => void,
): FileViewerPlacement {
  const row = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  // Measured before paint, so a remembered viewer without room never shows before it gives way.
  const room = useContainerAtLeast(row, WORK_AREA_MIN_WIDTH + FILE_VIEWER_WIDTH);
  const [cover, setCover] = useState<string | null>(null);
  const [visited, setVisited] = useState(false);
  const covering = wish && !room && cover === key;
  // Room, a closed viewer or another key ends covering: losing the room later gives way instead.
  if (cover !== null && !covering) setCover(null);
  const state: FileViewerState = !wish
    ? 'closed'
    : room
      ? 'beside'
      : covering
        ? 'covering'
        : 'away';
  const { actions } = useContext(TopbarSlotContext);
  const tdock = useTranslations('Docking');
  const openLabel = tdock('openFileViewer');
  const closeLabel = tdock('closeFileViewer');
  // Giving way or closing hides the viewer: focus inside it would fall to the page, so the top
  // bar's button takes it. Closing from the bar's own button, or from elsewhere, leaves focus be.
  useLayoutEffect(() => {
    if (state !== 'away' && state !== 'closed') return;
    const target = focusOutOfViewer(aside.current, row.current, actions, [openLabel, closeLabel]);
    target?.focus();
  }, [state, actions, openLabel, closeLabel]);
  return {
    state,
    open: state === 'beside' || state === 'covering',
    toggle: (open) => {
      setVisited(true);
      remember(open);
      setCover(open && !room ? key : null);
    },
    mounted: wish || visited,
    row,
    aside,
  };
}

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
    [
      ...(row?.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ].find((element) => !viewer.contains(element)) ??
    null
  );
}

/** The work area with the viewer beside it, or the viewer in its place. */
export function FileViewerRow({
  viewer,
  panel,
  children,
}: {
  viewer: FileViewerPlacement;
  /** The viewer's content. */
  panel: ReactNode;
  /** The work area; it stays mounted in every state, so it keeps its tab, scroll and draft. */
  children: ReactNode;
}) {
  const tdock = useTranslations('Docking');
  const covering = viewer.state === 'covering';
  return (
    <div ref={viewer.row} className="flex h-full min-h-0 min-w-0 flex-1">
      <div className={`${covering ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col`}>
        {children}
      </div>
      {viewer.mounted ? (
        <aside
          ref={viewer.aside}
          hidden={!viewer.open}
          aria-label={tdock('fileViewer')}
          style={{ width: covering ? '100%' : FILE_VIEWER_WIDTH }}
          className="min-h-0 max-w-full shrink-0 overflow-auto border-l border-line p-3"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
              {tdock('fileViewer')}
            </h2>
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label={tdock('closeFileViewer')}
              onClick={() => viewer.toggle(false)}
            >
              <X />
            </Button>
          </div>
          {panel}
        </aside>
      ) : null}
    </div>
  );
}
