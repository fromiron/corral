import {
  Button,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  Tooltip,
} from '@corral/react/design-kit';
import { ArrowDown } from '@corral/react/icons';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { changePreferences, preferences } from './preferences.ts';

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
 * A wheel or touch aimed at a scrollable row (a capped reply, a code block) belongs to that
 * box. The conversation only leaves the end when the person moves the conversation itself.
 */
function scrollingNested(target: EventTarget | null, timeline: HTMLElement) {
  let node = target instanceof Element ? target : null;
  while (node && node !== timeline) {
    if (node.scrollHeight - node.clientHeight > 1) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
    node = node.parentElement;
  }
  return false;
}

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
}: {
  sessionId: string;
  messageId?: string | undefined;
  children?: ReactNode;
  items: { id: string; content: ReactNode }[];
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
  const readingAnchor = useRef<{ id: string; offset: number } | null>(null);
  // A pointer is down on the scrollbar, so the next upward scroll is the person, not layout.
  const scrollbarPointer = useRef(false);
  const touchY = useRef<number | null>(null);
  const sentSeen = useRef<number | undefined>(undefined);
  const [atEnd, setAtEnd] = useState(true);
  const [focused, setFocused] = useState<string | null>(null);
  const virtualized = items.length > 40;
  const rows = useVirtualizer({
    count: items.length,
    enabled: virtualized,
    getScrollElement: () => timeline.current,
    estimateSize: () => 260,
    getItemKey: (index) => items[index]!.id,
    overscan: 4,
    anchorTo: 'end',
    followOnAppend: true,
    rangeExtractor: (range) => {
      const indices = defaultRangeExtractor(range);
      const index = focused ? items.findIndex((item) => item.id === focused) : -1;
      if (index >= 0 && !indices.includes(index)) indices.push(index);
      return indices.sort((a, b) => a - b);
    },
  });
  const position = useRef<() => void>(() => {});
  const current = useRef({ items, rows, virtualized });
  current.current = { items, rows, virtualized };
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
      const { items, rows, virtualized } = current.current;
      const anchor = restoreAnchor.current ?? (!follow.current ? readingAnchor.current : null);
      if (anchor && items.some((item) => item.id === anchor.id)) {
        const row = [...body.querySelectorAll<HTMLElement>('[data-chat-item]')].find(
          (row) => row.dataset.chatItem === anchor.id,
        );
        if (row) {
          box.scrollTop +=
            row.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.offset;
          restoreTop.current = null;
        } else if (virtualized)
          rows.scrollToIndex(
            items.findIndex((item) => item.id === anchor.id),
            { align: 'start' },
          );
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
    window.addEventListener('pagehide', remember);
    return () => {
      observer.disconnect();
      port.disconnect();
      window.removeEventListener('pagehide', remember);
      remember();
    };
  }, [sessionId]);
  useLayoutEffect(() => {
    position.current();
  });
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
    if (virtualized) rows.scrollToIndex(index, { align: 'start' });
    position.current();
    jumped.current = messageId;
  }, [messageId, items, rows, virtualized]);
  const stopRestoring = () => {
    restoreTop.current = null;
    restoreAnchor.current = null;
    readingAnchor.current = null;
    follow.current = false;
  };
  const rememberPlace = (box: HTMLElement) => {
    const top = box.getBoundingClientRect().top;
    const row = [...box.querySelectorAll<HTMLElement>('[data-chat-item]')].find(
      (item) => item.getBoundingClientRect().bottom > top,
    );
    readingAnchor.current =
      !follow.current && row
        ? { id: row.dataset.chatItem!, offset: row.getBoundingClientRect().top - top }
        : null;
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
        className={`chat-timeline min-h-0 overscroll-contain ${centered ? 'mt-auto flex-none' : 'flex-1 overflow-y-auto'}`}
        onWheel={(event) => {
          if (!(event.deltaY < 0)) return;
          const box = timeline.current;
          if (!box || box.scrollTop <= 0 || scrollingNested(event.target, box)) return;
          stopRestoring();
        }}
        onPointerDown={(event) => {
          // A scrollbar drag is navigation; clicking message actions is not.
          if (event.target === event.currentTarget) scrollbarPointer.current = true;
          // Hit testing can scroll an older action into view before the scroll event.
          // Read that position before focus renders can move the target under the pointer.
          else lockReadingPosition();
        }}
        onPointerUp={() => {
          scrollbarPointer.current = false;
        }}
        onPointerCancel={() => {
          scrollbarPointer.current = false;
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
          if (!['ArrowUp', 'PageUp', 'Home'].includes(event.key)) return;
          const box = timeline.current;
          if (!box || box.scrollTop <= 0) return;
          stopRestoring();
        }}
        onScroll={readPosition}
      >
        <div
          ref={content}
          className={`mx-auto w-full max-w-(--chat-column-width) px-4 sm:px-6 ${centered ? '' : 'pt-6 pb-2'}`}
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
            <ol
              aria-label={t('conversation')}
              style={
                virtualized ? { height: rows.getTotalSize(), position: 'relative' } : undefined
              }
            >
              {(virtualized
                ? rows.getVirtualItems().map((row) => ({ index: row.index, start: row.start }))
                : items.map((_, index) => ({ index, start: 0 }))
              ).map(({ index, start }) => {
                const item = items[index]!;
                return (
                  <li
                    key={item.id}
                    aria-posinset={index + 1}
                    aria-setsize={items.length}
                    data-index={index}
                    data-chat-item={item.id}
                    data-latest={index === items.length - 1 || undefined}
                    aria-current={item.id === messageId ? 'location' : undefined}
                    className={
                      item.id === messageId ? 'rounded-lg ring-2 ring-focus-ring' : undefined
                    }
                    ref={virtualized ? rows.measureElement : undefined}
                    onFocusCapture={() => setFocused(item.id)}
                    onBlurCapture={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);
                    }}
                    style={
                      virtualized
                        ? {
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${start}px)`,
                          }
                        : undefined
                    }
                  >
                    {item.content}
                  </li>
                );
              })}
            </ol>
          ) : (
            children
          )}
        </div>
      </section>
      <div
        data-testid="chat-composer"
        className={`chat-composer relative flex min-h-0 max-h-[calc(100%_-_3rem)] shrink-0 flex-col px-3 pb-4 sm:px-6 ${centered ? 'mb-auto pt-6' : 'pt-2'}`}
      >
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
          <div className="mx-auto w-full max-w-(--chat-composer-width)">{composer}</div>
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
