import {
  Button,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
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
        <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
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
}: {
  sessionId: string;
  messageId?: string | undefined;
  children?: ReactNode;
  items: { id: string; content: ReactNode }[];
  composer: ReactNode;
  header?: ReactNode;
  /**
   * Widgets that float in the margin right of the conversation and stay put while it scrolls
   *; index.css hides them when the margin cannot hold them.
   */
  aside?: ReactNode;
  centerEmpty?: boolean;
}) {
  const t = useTranslations('Desktop');
  const centered = centerEmpty && items.length === 0;
  const timeline = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const restoreTop = useRef<number | null>(null);
  const restoreAnchor = useRef<{ id: string; offset: number } | null>(null);
  const readingAnchor = useRef<{ id: string; offset: number } | null>(null);
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
      } else if (follow.current) box.scrollTop = box.scrollHeight;
      setAtEnd(box.scrollHeight - box.scrollTop - box.clientHeight < 48);
    };
    const remember = () => {
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
  const jumped = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!messageId || jumped.current === messageId) return;
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

  return (
    <div
      data-chat-view
      data-empty-centered={centered || undefined}
      className={`relative flex h-full min-h-0 min-w-0 flex-1 flex-col ${centered ? 'overflow-y-auto' : 'overflow-clip'}`}
    >
      {header ? (
        <div className="shrink-0 px-5 pt-3 has-[>div:empty]:hidden">
          <div className="mx-auto w-full max-w-(--chat-content-max-width)">{header}</div>
        </div>
      ) : null}
      <section
        ref={timeline}
        data-testid="chat-timeline"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrolling conversation must be keyboard reachable
        tabIndex={0}
        aria-label={t('conversation')}
        className={`chat-timeline min-h-0 overscroll-contain ${centered ? 'mt-auto flex-none' : 'flex-1 overflow-y-auto'}`}
        onWheel={stopRestoring}
        onPointerDown={stopRestoring}
        onKeyDown={(event) => {
          if (
            ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
          )
            stopRestoring();
        }}
        onScroll={() => {
          const box = timeline.current;
          if (!box || restoreTop.current !== null || restoreAnchor.current !== null) return;
          follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
          const top = box.getBoundingClientRect().top;
          const row = [...box.querySelectorAll<HTMLElement>('[data-chat-item]')].find(
            (item) => item.getBoundingClientRect().bottom > top,
          );
          readingAnchor.current =
            !follow.current && row
              ? { id: row.dataset.chatItem!, offset: row.getBoundingClientRect().top - top }
              : null;
          setAtEnd(follow.current);
        }}
      >
        <div
          ref={content}
          className={`mx-auto w-full max-w-(--chat-content-max-width) px-5 pt-4 ${centered ? 'pb-2' : 'pb-6'}`}
        >
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
        className={`chat-composer relative flex min-h-0 max-h-[calc(100%_-_3rem)] shrink-0 flex-col px-4 pt-2 pb-4 sm:px-5 ${centered ? 'mb-auto' : ''}`}
      >
        {!atEnd ? (
          <div className="pointer-events-none absolute right-5 bottom-full z-20 pb-3">
            <Button
              aria-label={t('toLatest')}
              size="icon-compact"
              variant="tertiary"
              className="pointer-events-auto rounded-full"
              onClick={() => {
                restoreTop.current = null;
                restoreAnchor.current = null;
                readingAnchor.current = null;
                follow.current = true;
                if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
              }}
            >
              <ArrowDown />
            </Button>
          </div>
        ) : null}
        <div className="-m-1 min-h-0 overflow-y-auto overscroll-contain p-1">{composer}</div>
      </div>
      {aside === undefined ? null : (
        <aside data-testid="chat-overview" className="chat-overview">
          {aside}
        </aside>
      )}
    </div>
  );
}
