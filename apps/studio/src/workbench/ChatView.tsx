import {
  Button,
  cn,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  Tooltip,
} from '@corral/react/design-kit';
import { ArrowDown } from '@corral/react/icons';
import { defaultRangeExtractor, observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { changePreferences, preferences } from './preferences.ts';
import { ConnectionNotice } from './session/SessionConnection.tsx';

/**
 * How much of each reply the conversation shows; a display preference kept in the page's menu
 * rather than above the messages, so the conversation starts at its first message.
 */
export function ChatDensityMenu() {
  const t = useTranslations('Desktop');
  const chatDensity = useStore(preferences, (state) => state.chatDensity);
  return (
    <MenuSub>
      <MenuSubTrigger>
        {t('chatDensity')}
        <span className="ml-auto truncate pl-3 text-caption text-muted-foreground">
          {t(
            chatDensity === 'results'
              ? 'densityResults'
              : chatDensity === 'detailed'
                ? 'densityDetailed'
                : 'densityBasic',
          )}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuRadioGroup
          value={chatDensity}
          onValueChange={(value) => changePreferences({ chatDensity: value as typeof chatDensity })}
        >
          <MenuRadioItem value="results" closeOnClick>
            {t('densityResults')}
          </MenuRadioItem>
          <MenuRadioItem value="basic" closeOnClick>
            {t('densityBasic')}
          </MenuRadioItem>
          <MenuRadioItem value="detailed" closeOnClick>
            {t('densityDetailed')}
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}

/**
 * A wheel, touch, or key aimed at a scrollable row (a capped reply, a code block) belongs to that
 * box. The conversation only leaves the end when the person moves the conversation itself.
 */
function scrollingNested(target: EventTarget | null, timeline: HTMLElement) {
  let node = target instanceof Element ? target : null;
  while (node && node !== timeline) {
    // A box already at its top passes the upward scroll on to the conversation.
    if (node.scrollTop > 0 && node.scrollHeight - node.clientHeight > 1) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * Marks a pointer as held until it is released anywhere, since a drag often ends outside the
 * box that was pressed.
 */
export function holdPointer(held: { current: boolean }) {
  held.current = true;
  const release = () => {
    held.current = false;
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
}

/**
 * The row at the top of the view, its offset, and the scroll position it was read at: a
 * reader's place. Read before the list has mounted the rows for a new position, no row is in
 * view and there is no place to hold yet.
 */
function readPlace(box: HTMLElement) {
  const top = box.getBoundingClientRect().top;
  const row = [...box.querySelectorAll<HTMLElement>('[data-chat-item]')].find(
    (item) => item.getBoundingClientRect().bottom > top,
  );
  if (!row?.dataset.chatItem || row.getBoundingClientRect().top >= top + box.clientHeight)
    return null;
  return {
    id: row.dataset.chatItem,
    offset: row.getBoundingClientRect().top - top,
    top: box.scrollTop,
  };
}

/** A row's height until it is measured. */
const ESTIMATED_ROW = 260;

/** A session is the conversation; each child turn keeps its Corral Run/Execution identity. */
export function ChatView({
  sessionId,
  messageId,
  children,
  items,
  composer,
  header,
  aside,
  centerEmpty = false,
  expandedHeader = false,
  sent,
  tray,
}: {
  sessionId: string;
  messageId?: string | undefined;
  children?: ReactNode;
  items: { id: string; content: ReactNode }[];
  /**
   * What the conversation needs from the person now: after the last item, in the scrolling
   * area, outside the list's window (composer-flow.md "지금 필요한 것").
   */
  tray?: ReactNode;
  composer: ReactNode;
  header?: ReactNode;
  /** Read a long header (meeting records) without displacing the composer. */
  expandedHeader?: boolean;
  /** Increases when the person sends. Following the end starts again. */
  sent?: number;
  /**
   * Widgets that float in the margin right of the conversation and stay put while it scrolls
   *; index.css hides them when the margin cannot hold them.
   */
  aside?: ReactNode;
  centerEmpty?: boolean;
}) {
  const t = useTranslations('Desktop');
  const centered = centerEmpty && items.length === 0 && !expandedHeader;
  const headerInFlow = !expandedHeader && !centered;
  // With a timeline in view, the composer lies over its bottom edge instead of below it.
  const floating = !centered && !expandedHeader;
  const view = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const timeline = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  // Where the view last put the end in view itself; its scroll event may arrive after the turn
  // has grown again, which is not the reader leaving the end.
  const followedTop = useRef(Number.POSITIVE_INFINITY);
  /** The position the last scroll or pointer event saw, to tell moving down from moving up. */
  const seenTop = useRef(0);
  const restoreTop = useRef<number | null>(null);
  const restoreAnchor = useRef<{ id: string; offset: number } | null>(null);
  // The row a reader is on, its offset, and the scroll position it was read at.
  const readingAnchor = useRef<ReturnType<typeof readPlace>>(null);
  // A pointer is down on the scrollbar, so the next upward scroll is the person, not layout.
  const scrollbarPointer = useRef(false);
  // A pointer is down in the messages, so focus that follows is a click, not keyboard navigation.
  const contentPointer = useRef(false);
  const touchY = useRef<number | null>(null);
  const sentSeen = useRef<number | undefined>(undefined);
  const [atEnd, setAtEnd] = useState(true);
  const [focused, setFocused] = useState<string | null>(null);
  // Rows' last real heights; a hidden or not yet laid out row reads 0 and keeps its last size.
  const sizes = useRef(new Map<string, number>());
  // The timeline is always virtualized, whatever its length: one layout for one row or a
  // thousand, and only the rows in and near the view are mounted.
  const rows = useVirtualizer({
    count: items.length,
    getScrollElement: () => timeline.current,
    estimateSize: () => ESTIMATED_ROW,
    getItemKey: (index) => items[index]?.id ?? index,
    overscan: 4,
    // Following the end is this view's own (position below); the list only places rows.
    // A hidden timeline (another view in front, the expanded records) measures 0. It keeps
    // its rows mounted at their last size instead of unmounting the conversation.
    initialRect: { width: 0, height: typeof window === 'undefined' ? 800 : window.innerHeight },
    observeElementRect: (instance, notify) =>
      observeElementRect(instance, (rect) => {
        if (rect.width > 0 && rect.height > 0) notify(rect);
      }),
    measureElement: (element) => {
      const key = element.getAttribute('data-chat-item') ?? '';
      const height = element.getBoundingClientRect().height;
      if (height > 0) sizes.current.set(key, height);
      return height > 0 ? height : (sizes.current.get(key) ?? ESTIMATED_ROW);
    },
    rangeExtractor: (range) => {
      const indices = defaultRangeExtractor(range);
      const index = focused ? items.findIndex((item) => item.id === focused) : -1;
      if (index >= 0 && !indices.includes(index)) indices.push(index);
      return indices.sort((a, b) => a - b);
    },
  });
  // Rows enter and leave the window in flow, so the browser's scroll anchoring holds a reader's
  // row when one above changes size; the list correcting the offset as well would move it twice.
  rows.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  const virtual = rows.getVirtualItems();
  const last = virtual[virtual.length - 1];
  const windowed = {
    rows: virtual,
    before: virtual[0]?.start ?? 0,
    after: last ? Math.max(0, rows.getTotalSize() - last.end) : 0,
  };
  const position = useRef<() => void>(() => {});
  const current = useRef({ items, rows });
  current.current = { items, rows };
  useLayoutEffect(() => {
    const box = timeline.current;
    const body = content.current;
    if (!box || !body) return;
    const key = `corral:chat-scroll:${sessionId}`;
    follow.current = true;
    followedTop.current = Number.POSITIVE_INFINITY;
    restoreTop.current = null;
    restoreAnchor.current = null;
    readingAnchor.current = null;
    try {
      const raw = sessionStorage.getItem(key);
      const stored = raw === null ? null : JSON.parse(raw);
      const top = typeof stored === 'number' ? stored : stored?.top;
      if (typeof top === 'number' && Number.isFinite(top) && top >= 0) {
        follow.current = stored?.follow === true;
        if (!follow.current) {
          restoreTop.current = top;
          if (typeof stored?.anchor?.id === 'string' && Number.isFinite(stored?.anchor?.offset))
            restoreAnchor.current = stored.anchor;
        }
      }
    } catch {
      /* A missing preference does not block the conversation. */
    }
    position.current = () => {
      if (box.hidden) return;
      const { items, rows } = current.current;
      const reading = readingAnchor.current;
      // While reading, the place is read again when the person or the browser moved the view
      // since it was read: a key or a wheel animating over frames, a focused row scrolled into
      // view. Rows mounting for that move are seen here before its scroll event, and the move
      // stands. A scroll event read before the list mounted the rows in view left no place;
      // the rows are there now.
      if (
        !follow.current &&
        restoreAnchor.current === null &&
        restoreTop.current === null &&
        (!reading || Math.abs(box.scrollTop - reading.top) >= 0.5)
      )
        readingAnchor.current = readPlace(box);
      const anchor = restoreAnchor.current ?? (!follow.current ? readingAnchor.current : null);
      if (anchor && items.some((item) => item.id === anchor.id)) {
        // Only the mounted rows are looked at, so this costs the window, not the history.
        const row = [...body.querySelectorAll<HTMLElement>('[data-chat-item]')].find(
          (row) => row.dataset.chatItem === anchor.id,
        );
        if (row) {
          const shift =
            row.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.offset;
          // A write, even of the same offset, would stop a scroll the browser is animating.
          if (Math.abs(shift) >= 0.5) box.scrollTop += shift;
          restoreTop.current = null;
        } else
          rows.scrollToIndex(
            items.findIndex((item) => item.id === anchor.id),
            { align: 'start' },
          );
        if (anchor === readingAnchor.current) readingAnchor.current.top = box.scrollTop;
      } else if (restoreTop.current !== null) {
        box.scrollTop = restoreTop.current;
        if (box.scrollHeight - box.clientHeight >= restoreTop.current) restoreTop.current = null;
      } else if (follow.current) {
        box.scrollTop = box.scrollHeight;
        followedTop.current = box.scrollTop;
      }
      setAtEnd(box.scrollHeight - box.scrollTop - box.clientHeight < 48);
    };
    const remember = () => {
      if (box.hidden) return;
      try {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            top: restoreTop.current ?? box.scrollTop,
            follow: follow.current,
            anchor: (() => {
              const top = box.getBoundingClientRect().top;
              const row = [...body.querySelectorAll<HTMLElement>('[data-chat-item]')].find(
                (row) => row.getBoundingClientRect().bottom > top,
              );
              return row
                ? { id: row.dataset.chatItem, offset: row.getBoundingClientRect().top - top }
                : restoreAnchor.current;
            })(),
          }),
        );
      } catch {
        /* Session only. */
      }
    };
    position.current();
    const observer = new ResizeObserver(() => position.current());
    observer.observe(body);
    // The dock and the widget bar change the viewport independently of transcript content.
    // The same owner restores the reader's row/offset or follows the end in both cases.
    const port = new ResizeObserver(() => position.current());
    port.observe(box);
    // A row that renders on its own (a streamed reply, a run's state) is placed in the task
    // that changed it, before the next frame, rather than one frame later by the observer.
    const grown = new MutationObserver(() => position.current());
    grown.observe(body, {
      subtree: true,
      childList: true,
      characterData: true,
      // A collapse animating its height writes its style.
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'open'],
    });
    window.addEventListener('pagehide', remember);
    return () => {
      observer.disconnect();
      port.disconnect();
      grown.disconnect();
      window.removeEventListener('pagehide', remember);
      remember();
    };
  }, [sessionId]);
  // The timeline keeps the composer's height as its bottom space. A change is applied in the
  // same task that made it (a mutation is seen before the next frame), so following the end
  // stays at the end and a reader's rows never move; resizing covers what no mutation shows.
  useLayoutEffect(() => {
    const root = view.current;
    const face = surface.current;
    const box = timeline.current;
    if (!root || !face || !box) return;
    let height = -1;
    let gutter = -1;
    const fit = () => {
      const nextHeight = floating ? face.getBoundingClientRect().height : 0;
      const nextGutter = floating ? box.offsetWidth - box.clientWidth : 0;
      if (nextGutter !== gutter) {
        gutter = nextGutter;
        root.style.setProperty('--timeline-gutter', `${nextGutter}px`);
      }
      if (nextHeight === height) return;
      height = nextHeight;
      root.style.setProperty('--composer-h', `${nextHeight}px`);
      position.current();
    };
    fit();
    const resized = new ResizeObserver(fit);
    resized.observe(face);
    const mutated = new MutationObserver(fit);
    mutated.observe(face, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    return () => {
      resized.disconnect();
      mutated.disconnect();
    };
  }, [floating]);
  const followEnd = () => {
    restoreTop.current = null;
    restoreAnchor.current = null;
    readingAnchor.current = null;
    scrollbarPointer.current = false;
    follow.current = true;
    followedTop.current = Number.POSITIVE_INFINITY;
    position.current();
  };
  // followEnd only writes refs. Listing it would rerun this on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs only
  useLayoutEffect(() => {
    if (sent === undefined) return;
    // The first value is the mount, including a restored reading position. Only a later send
    // starts following again.
    if (sentSeen.current === undefined) {
      sentSeen.current = sent;
      return;
    }
    if (sentSeen.current === sent) return;
    sentSeen.current = sent;
    followEnd();
  }, [sent]);
  const jumped = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!messageId) {
      jumped.current = undefined;
      return;
    }
    if (jumped.current === messageId) return;
    const index = items.findIndex((item) => item.id === messageId);
    if (index < 0) return;
    follow.current = false;
    restoreTop.current = null;
    restoreAnchor.current = { id: messageId, offset: 0 };
    rows.scrollToIndex(index, { align: 'start' });
    position.current();
    jumped.current = messageId;
  }, [messageId, items, rows]);
  const stopRestoring = () => {
    restoreTop.current = null;
    restoreAnchor.current = null;
    readingAnchor.current = null;
    follow.current = false;
  };
  const rememberPlace = (box: HTMLElement) => {
    readingAnchor.current = follow.current ? null : readPlace(box);
    setAtEnd(follow.current);
  };
  const readPosition = () => {
    const box = timeline.current;
    if (!box || restoreTop.current !== null || restoreAnchor.current !== null) return;
    const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (follow.current) {
      // A lower offset while still following is the list remeasuring, scroll anchoring, or
      // the composer changing the port. The person leaves only with an upward gesture.
      const movedUp = box.scrollTop < followedTop.current - 1;
      if (!(movedUp && scrollbarPointer.current)) {
        seenTop.current = box.scrollTop;
        return;
      }
      stopRestoring();
      seenTop.current = box.scrollTop;
    } else {
      // Moving down to within 48px of the end follows again; staying put only follows at
      // the end itself (the content shrank).
      follow.current = gap < 1 || (box.scrollTop > seenTop.current && gap < 48);
      seenTop.current = box.scrollTop;
    }
    rememberPlace(box);
  };
  const lockReadingPosition = () => {
    const box = timeline.current;
    if (!box || restoreTop.current !== null || restoreAnchor.current !== null) return;
    // Still where following left the end: clicking a message is not navigation.
    if (follow.current && box.scrollTop >= followedTop.current - 1) {
      seenTop.current = box.scrollTop;
      return;
    }
    // Hit testing already scrolled an older action into view. Hold that place before
    // focus renders move it.
    if (follow.current) stopRestoring();
    rememberPlace(box);
  };

  return (
    <div
      ref={view}
      data-chat-view
      data-empty-centered={centered || undefined}
      className={`relative flex h-full min-h-0 min-w-0 flex-1 flex-col ${centered ? 'overflow-y-auto' : 'overflow-clip'}`}
    >
      {/* Expanded records read in their own area, and an empty session keeps its notices at
          the top. With messages, notices are part of the conversation flow (below). */}
      {header && !headerInFlow ? (
        <div
          className={`px-3 pt-3 has-[>div:empty]:hidden sm:px-6 ${expandedHeader ? 'min-h-0 flex-1 overflow-y-auto' : 'max-h-1/2 min-h-0 shrink overflow-y-auto'}`}
        >
          <div className="mx-auto flex w-full max-w-(--chat-composer-width) flex-col gap-2">
            {header}
          </div>
        </div>
      ) : null}
      <section
        ref={timeline}
        hidden={expandedHeader}
        data-testid="chat-timeline"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrolling conversation must be keyboard reachable
        tabIndex={0}
        aria-label={t('conversation')}
        // A focused row scrolls into view above the composer, not behind it.
        className={`chat-timeline min-h-0 overscroll-contain scroll-pb-(--composer-h) ${centered ? 'mt-auto flex-none' : 'flex-1 overflow-y-auto'}`}
        onWheel={(event) => {
          if (!(event.deltaY < 0)) return;
          const box = timeline.current;
          // The scroll a wheel causes can land before its event, already at the top; what
          // counts is that the conversation could move up, not where it is now.
          if (!box || box.scrollHeight <= box.clientHeight || scrollingNested(event.target, box))
            return;
          stopRestoring();
          rememberPlace(box);
        }}
        onPointerDown={(event) => {
          // A scrollbar drag is navigation; clicking message actions is not.
          if (event.target === event.currentTarget) {
            holdPointer(scrollbarPointer);
            return;
          }
          holdPointer(contentPointer);
          // Hit testing can scroll an older action into view before the scroll event.
          // Read that position before focus renders can move the target under the pointer.
          lockReadingPosition();
        }}
        onFocus={(event) => {
          const box = timeline.current;
          if (!box || !follow.current || contentPointer.current) return;
          if (event.target === event.currentTarget) return;
          // The offset within the content holds whether or not the browser has scrolled the
          // target into view yet. Following would pull a target above the end's view away.
          const offset =
            event.target.getBoundingClientRect().top -
            box.getBoundingClientRect().top +
            box.scrollTop;
          if (offset >= box.scrollHeight - box.clientHeight - 1) return;
          stopRestoring();
          rememberPlace(box);
        }}
        onTouchStart={(event) => {
          touchY.current = event.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(event) => {
          const box = timeline.current;
          const y = event.touches[0]?.clientY;
          const start = touchY.current;
          // A finger moving down carries the conversation toward the past.
          if (!box || y === undefined || start === null || y <= start) return;
          if (box.scrollTop <= 0 || scrollingNested(event.target, box)) return;
          stopRestoring();
        }}
        onKeyDown={(event) => {
          const box = timeline.current;
          if (!box) return;
          // On the timeline itself, Home and End go to the first row and to the end: rows not
          // yet measured would leave the browser's own scroll short of either.
          const plain = !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey);
          if (event.target === event.currentTarget && plain && event.key === 'End') {
            event.preventDefault();
            followEnd();
            return;
          }
          if (!['ArrowUp', 'PageUp', 'Home'].includes(event.key)) return;
          if (box.scrollTop <= 0 || scrollingNested(event.target, box)) return;
          stopRestoring();
          if (event.target === event.currentTarget && plain && event.key === 'Home') {
            event.preventDefault();
            // The first row starts at the top whatever the rows below it measure.
            box.scrollTop = 0;
            rememberPlace(box);
          }
        }}
        onScroll={readPosition}
      >
        <div
          ref={content}
          // The last row ends above the composer, which lies over the bottom of this area.
          className={`mx-auto w-full max-w-(--chat-column-width) px-4 sm:px-6 ${centered ? '' : 'pt-6 pb-[calc(var(--composer-h)+0.5rem)]'}`}
        >
          {header && headerInFlow ? (
            // One line in the flow: it scrolls away with the messages and never covers them.
            <div
              data-testid="chat-header"
              className="mb-6 flex flex-col gap-2 empty:hidden has-[>div:empty]:hidden"
            >
              {header}
            </div>
          ) : null}
          {items.length ? (
            // The window: the mounted rows in flow, the rest held as the list's padding. A row's
            // size counts in the layout as soon as it changes, so the end and the composer's
            // space move together in one frame; the browser keeps a reader's row in place.
            <ol
              aria-label={t('conversation')}
              data-chat-window
              style={{ paddingTop: windowed.before, paddingBottom: windowed.after }}
            >
              {windowed.rows.map(({ index, start }, at) => {
                const item = items[index];
                if (!item) return null;
                // A focused row kept mounted away from the window: the rows between are held
                // as space above it, so the list keeps its height.
                const previous = windowed.rows[at - 1];
                const between = previous ? start - previous.end : 0;
                return (
                  <li
                    key={item.id}
                    aria-posinset={index + 1}
                    aria-setsize={items.length}
                    data-index={index}
                    data-chat-item={item.id}
                    data-latest={index === items.length - 1 || undefined}
                    aria-current={item.id === messageId ? 'location' : undefined}
                    // Its own block, so the row's margins belong to its measured size.
                    className={cn(
                      'flow-root',
                      item.id === messageId && 'rounded-lg ring-2 ring-focus-ring',
                    )}
                    ref={rows.measureElement}
                    style={between > 0 ? { marginTop: between } : undefined}
                    onFocusCapture={() => setFocused(item.id)}
                    onBlurCapture={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);
                    }}
                  >
                    {item.content}
                  </li>
                );
              })}
            </ol>
          ) : (
            children
          )}
          {tray}
        </div>
      </section>
      <div
        ref={surface}
        data-testid="chat-composer"
        data-composer-surface={floating ? 'floating' : 'inline'}
        className={cn(
          'chat-composer flex min-h-0 max-h-[calc(100%_-_3rem)] shrink-0 flex-col px-3 pb-4 sm:px-6',
          floating
            ? // The bottom edge of the conversation, over its scrolling area and inside the view,
              // on the page's own floor; the scrollbar beside it stays uncovered.
              'absolute bottom-0 left-0 right-(--timeline-gutter) z-10 bg-(--chat-floor) pt-2'
            : // The home and the expanded records place the composer in the flow.
              `relative ${centered ? 'mb-auto pt-6' : 'pt-2'}`,
        )}
      >
        {floating ? (
          // The conversation fades out under the composer's top edge; paint only, no layout.
          <div
            aria-hidden
            data-composer-fade
            className="pointer-events-none absolute inset-x-0 bottom-full h-6 bg-linear-to-b from-transparent to-(--chat-floor)"
          />
        ) : null}
        {!expandedHeader && !atEnd ? (
          // Centered over the composer, where the conversation continues.
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 flex justify-center pb-3">
            <Tooltip content={t('toLatest')}>
              <Button
                aria-label={t('toLatest')}
                size="icon"
                variant="tertiary"
                className="pointer-events-auto rounded-full"
                onClick={followEnd}
              >
                <ArrowDown />
              </Button>
            </Tooltip>
          </div>
        ) : null}
        <div className="-m-1 min-h-0 overflow-y-auto overscroll-contain p-1">
          <div className="mx-auto w-full max-w-(--chat-composer-width)">
            {/* Where the activity bar will say it (U7); until then the same line, first. */}
            <ConnectionNotice />
            {composer}
          </div>
        </div>
      </div>
      {aside === undefined ? null : (
        <aside data-testid="chat-overview" className="chat-overview">
          {aside}
        </aside>
      )}
    </div>
  );
}
