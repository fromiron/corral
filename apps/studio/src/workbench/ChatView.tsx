// Adapted from T3 Code ChatView's timeline/composer layout (MIT). See THIRD-PARTY-NOTICES/T3-Code.md.
import { ArrowDown } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

/** A session is the conversation; each child turn keeps its Corral Run/Execution identity. */
export function ChatView({
  sessionId,
  children,
  composer,
  header,
}: {
  sessionId: string;
  children: ReactNode;
  composer: ReactNode;
  header?: ReactNode;
}) {
  const t = useTranslations('Desktop');
  const timeline = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const restoreTop = useRef<number | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  useLayoutEffect(() => {
    const box = timeline.current;
    const body = content.current;
    if (!box || !body) return;
    const key = `corral:chat-scroll:${sessionId}`;
    follow.current = true;
    restoreTop.current = null;
    try {
      const raw = sessionStorage.getItem(key);
      const stored = raw === null ? null : JSON.parse(raw);
      const top = typeof stored === 'number' ? stored : stored?.top;
      if (typeof top === 'number' && Number.isFinite(top) && top >= 0) {
        follow.current = stored?.follow === true;
        if (!follow.current) restoreTop.current = top;
      }
    } catch {
      /* A missing preference does not block the conversation. */
    }
    const position = () => {
      if (restoreTop.current !== null) {
        box.scrollTop = restoreTop.current;
        if (box.scrollHeight - box.clientHeight >= restoreTop.current) restoreTop.current = null;
      } else if (follow.current) box.scrollTop = box.scrollHeight;
      setAtEnd(box.scrollHeight - box.scrollTop - box.clientHeight < 48);
    };
    const remember = () => {
      try {
        sessionStorage.setItem(
          key,
          JSON.stringify({ top: restoreTop.current ?? box.scrollTop, follow: follow.current }),
        );
      } catch {
        /* Session only. */
      }
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(body);
    window.addEventListener('pagehide', remember);
    return () => {
      observer.disconnect();
      window.removeEventListener('pagehide', remember);
      remember();
    };
  }, [sessionId]);
  const stopRestoring = () => {
    if (restoreTop.current !== null) {
      restoreTop.current = null;
      follow.current = false;
    }
  };

  return (
    <div
      data-chat-view
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {header}
      <section
        ref={timeline}
        data-testid="chat-timeline"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrolling conversation must be keyboard reachable
        tabIndex={0}
        aria-label={t('conversation')}
        className="chat-timeline min-h-0 flex-1 overflow-y-auto overscroll-contain"
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
          if (!box || restoreTop.current !== null) return;
          follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
          setAtEnd(follow.current);
        }}
      >
        <div
          ref={content}
          className="mx-auto w-full max-w-(--chat-content-max-width) px-5 pt-8 pb-6"
        >
          {children}
        </div>
      </section>
      <div
        data-testid="chat-composer"
        className="chat-composer relative shrink-0 px-4 pt-2 pb-4 sm:px-5"
      >
        {!atEnd ? (
          <div className="pointer-events-none absolute right-5 bottom-full z-20 pb-3">
            <Button
              aria-label={t('toLatest')}
              size="icon-sm"
              variant="outline"
              className="pointer-events-auto rounded-full"
              onClick={() => {
                restoreTop.current = null;
                follow.current = true;
                if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
              }}
            >
              <ArrowDown />
            </Button>
          </div>
        ) : null}
        {composer}
      </div>
    </div>
  );
}
