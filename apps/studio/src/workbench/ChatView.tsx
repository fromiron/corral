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
  const [atEnd, setAtEnd] = useState(true);
  useLayoutEffect(() => {
    const box = timeline.current;
    const body = content.current;
    if (!box || !body) return;
    const key = `corral:chat-scroll:${sessionId}`;
    try {
      const stored = sessionStorage.getItem(key);
      box.scrollTop = stored === null ? box.scrollHeight : Number(stored);
    } catch {
      box.scrollTop = box.scrollHeight;
    }
    follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    setAtEnd(follow.current);
    const observer = new ResizeObserver(() => {
      if (follow.current) box.scrollTop = box.scrollHeight;
    });
    observer.observe(body);
    return () => {
      observer.disconnect();
      try {
        sessionStorage.setItem(key, String(box.scrollTop));
      } catch {
        /* Session only. */
      }
    };
  }, [sessionId]);

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
        onScroll={() => {
          const box = timeline.current;
          if (!box) return;
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
