import {
  Button,
  cn,
  Dialog,
  DialogPopup,
  DialogTitle,
  fontWeights,
  Tooltip,
} from '@corral/react/design-kit';
import { Maximize2, Minimize2, X } from '@corral/react/icons';
import { type ReactNode, type RefObject, useId, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';

// Below the shell's sidebar boundary the records cover the conversation instead of sharing it.
const NARROW = '(max-width: 1023px)';
const narrowNow = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches;
function subscribe(change: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(NARROW);
  media.addEventListener?.('change', change);
  return () => media.removeEventListener?.('change', change);
}

/** Whether the window is under 1024px. */
export function useNarrowScreen() {
  return useSyncExternalStore(subscribe, narrowNow, () => false);
}

const headingClass = 'min-w-0 flex-1 truncate rounded-sm text-subtitle text-foreground';

/**
 * The minutes, decisions and handoff beside the conversation. Closing only hides the panel, so a
 * decision being edited survives; widening gives it the conversation's room above the composer.
 */
export function MeetingRecordsPanel({
  open,
  widened,
  onWiden,
  onClose,
  headingRef,
  children,
}: {
  open: boolean;
  widened: boolean;
  onWiden(widened: boolean): void;
  onClose(): void;
  headingRef: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  const t = useTranslations('Meetings');
  const heading = useId();
  return (
    <aside
      data-meeting-records
      aria-labelledby={heading}
      hidden={!open}
      className={cn(
        'min-h-0 flex-col border-l border-border',
        open ? 'flex' : 'hidden',
        widened ? 'min-w-0 flex-1' : 'w-90 shrink-0',
      )}
    >
      <div className="flex shrink-0 items-center gap-1 py-2 pr-2 pl-4">
        <h2
          id={heading}
          ref={headingRef}
          tabIndex={-1}
          className={headingClass}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {t('records')}
        </h2>
        <Tooltip content={t(widened ? 'compactRecords' : 'expandRecords')}>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={t(widened ? 'compactRecords' : 'expandRecords')}
            aria-pressed={widened}
            onClick={() => onWiden(!widened)}
          >
            {widened ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </Tooltip>
        <CloseRecords onClose={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        <div className={widened ? 'mx-auto w-full max-w-(--chat-content-max-width)' : undefined}>
          {children}
        </div>
      </div>
    </aside>
  );
}

/** The same records as a drawer over the conversation, which stays mounted underneath. */
export function MeetingRecordsDrawer({
  open,
  onClose,
  headingRef,
  children,
}: {
  open: boolean;
  onClose(): void;
  headingRef: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  const t = useTranslations('Meetings');
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPopup
        data-meeting-records
        position="left"
        showCloseButton={false}
        initialFocus={headingRef}
        className="top-0 right-0 left-auto flex h-dvh max-h-dvh w-[min(30rem,calc(100vw-3rem))] max-w-none flex-col overflow-hidden rounded-none p-0"
      >
        <div className="flex shrink-0 items-center gap-1 py-2 pr-2 pl-4">
          <DialogTitle
            ref={headingRef}
            tabIndex={-1}
            className={headingClass}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {t('records')}
          </DialogTitle>
          <CloseRecords onClose={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {children}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function CloseRecords({ onClose }: { onClose(): void }) {
  const t = useTranslations('Meetings');
  return (
    <Tooltip content={t('closeRecords')}>
      <Button variant="ghost" size="icon-compact" aria-label={t('closeRecords')} onClick={onClose}>
        <X />
      </Button>
    </Tooltip>
  );
}
