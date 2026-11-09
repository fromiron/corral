import type { SessionEntry } from '@corral/core';
import {
  Button,
  collapsedStackHeight,
  type QueuedMessage,
  QueuedStack,
  Switch,
  useQueueCardHeight,
} from '@corral/react/design-kit';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

/**
 * Saved requests for the next run, stacked in the kit QueuedStack above the input: start one now,
 * edit it back into the box, or remove it. The stored order cannot change, so the cards never
 * drag. The kit positions the stack absolutely above its container's bottom edge; this host
 * gives it a container whose height follows the stack as it fans out, so the cards never cover
 * the input or the status line.
 */
export function ComposerQueue({
  queued,
  autoStart,
  onAutoStartChange,
  startDisabled,
  onStart,
  onEdit,
  onRemove,
}: {
  queued: SessionEntry[];
  /** Start the next saved request when a run of this session ends. */
  autoStart: boolean;
  onAutoStartChange: (value: boolean) => void;
  startDisabled: boolean;
  onStart: (entry: SessionEntry) => void;
  onEdit: (entry: SessionEntry) => void;
  onRemove: (entry: SessionEntry) => void;
}) {
  const t = useTranslations('Sessions');
  const cardHeight = useQueueCardHeight();
  const stack = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  // Text attachments travel with the request; the card shows them as file tiles.
  const identity = queued
    .map((entry) =>
      [entry.entryId, entry.text, ...(entry.attachments ?? []).map((item) => item.sha256)].join(
        '\u0000',
      ),
    )
    .join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt only when the saved requests change
  const items = useMemo<QueuedMessage[]>(
    () =>
      queued.map((entry) => ({
        id: entry.entryId,
        text: entry.text,
        files: (entry.attachments ?? []).map(
          (item) => new File([item.text], item.name, { type: item.mime }),
        ),
      })),
    [identity],
  );
  const entryFor = (item: QueuedMessage) => queued.find((entry) => entry.entryId === item.id);
  const shown = queued.length > 0;
  useLayoutEffect(() => {
    const box = stack.current?.firstElementChild;
    if (!shown || !box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(box.getBoundingClientRect().height));
    observer.observe(box);
    return () => observer.disconnect();
  }, [shown]);
  if (!shown) return null;
  return (
    <section
      aria-label={t('queueHeading')}
      data-corral-queue=""
      className="mx-auto mb-2 flex w-full max-w-(--chat-content-max-width) flex-col gap-1"
    >
      <div className="flex justify-end px-1">
        <Switch
          label={t('autoStart')}
          title={t('autoStartHint')}
          checked={autoStart}
          onToggle={() => onAutoStartChange(!autoStart)}
        />
      </div>
      <div
        ref={stack}
        className="relative"
        style={{ height: height ?? collapsedStackHeight(queued.length, cardHeight) }}
      >
        <QueuedStack
          queue={items}
          bottom={0}
          onEdit={(item) => {
            const entry = entryFor(item);
            if (entry) onEdit(entry);
          }}
          onRemove={(item) => {
            const entry = entryFor(item);
            if (entry) onRemove(entry);
          }}
          renderActions={(item) => {
            const entry = entryFor(item);
            return entry ? (
              <Button
                variant="ghost"
                size="compact"
                disabled={startDisabled}
                onClick={() => onStart(entry)}
              >
                {t('startNow')}
              </Button>
            ) : null;
          }}
          labels={{
            collapse: t('collapse'),
            collapseQueue: t('collapseQueue'),
            queued: (count) => t('queueCount', { count }),
            attachments: (count) => t('queueAttachments', { count }),
            edit: t('editQueued'),
            editMessage: (text) => t('editQueuedMessage', { text }),
            remove: t('remove'),
            removeMessage: (text) => t('removeQueuedMessage', { text }),
          }}
        />
      </div>
    </section>
  );
}
