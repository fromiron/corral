import type { SessionEntry } from '@corral/core';
import {
  Button,
  collapsedStackHeight,
  type QueuedMessage,
  QueuedStack,
  Switch,
  useQueueCardHeight,
} from '@corral/react/design-kit';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

/**
 * Saved requests for the next run, stacked in the kit QueuedStack above the input: start one now,
 * edit it back into the box, or remove it. The stored order cannot change, so the cards never
 * drag.
 */
export function ComposerQueue({
  queued,
  autoStart,
  autoStartShown = true,
  onAutoStartChange,
  startDisabled,
  onStart,
  onEdit,
  onRemove,
}: {
  queued: SessionEntry[];
  /** Start the next saved request when a run of this session ends. */
  autoStart: boolean;
  /** A server starts saved requests, so the switch is there. */
  autoStartShown?: boolean;
  onAutoStartChange: (value: boolean) => void;
  startDisabled: boolean;
  onStart: (entry: SessionEntry) => void;
  onEdit: (entry: SessionEntry) => void;
  onRemove: (entry: SessionEntry) => void;
}) {
  const t = useTranslations('Sessions');
  // Text attachments and images travel with the request; the card shows them as file tiles.
  const identity = queued
    .map((entry) =>
      [
        entry.entryId,
        entry.text,
        ...(entry.attachments ?? []).map((item) => item.sha256),
        ...(entry.images ?? []).map((item) => item.imageId),
      ].join('\u0000'),
    )
    .join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt only when the saved requests change
  const items = useMemo<QueuedMessage[]>(
    () =>
      queued.map((entry) => ({
        id: entry.entryId,
        text: entry.text,
        files: [
          ...(entry.attachments ?? []).map(
            (item) => new File([item.text], item.name, { type: item.mime }),
          ),
          // Only the name is here, not the bytes: a typeless file is the file glyph.
          ...(entry.images ?? []).map((item) => new File([], item.name)),
        ],
      })),
    [identity],
  );
  const entryFor = (item: QueuedMessage) => queued.find((entry) => entry.entryId === item.id);
  return (
    <QueueLine
      items={items}
      header={
        autoStartShown ? (
          <div className="flex justify-end px-1">
            <Switch
              label={t('autoStart')}
              title={t('autoStartHint')}
              checked={autoStart}
              onToggle={() => onAutoStartChange(!autoStart)}
            />
          </div>
        ) : null
      }
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
          <Button variant="ghost" disabled={startDisabled} onClick={() => onStart(entry)}>
            {t('startNow')}
          </Button>
        ) : null;
      }}
    />
  );
}

/**
 * The queue line above the input: the kit QueuedStack, in a container whose height follows the
 * stack as it fans out (the kit positions it absolutely above its container's bottom edge), so
 * the cards never cover the input or the status line. A conversation's saved requests and a
 * meeting's waiting message stand in it alike.
 */
export function QueueLine({
  items,
  header,
  onEdit,
  onRemove,
  renderActions,
}: {
  items: QueuedMessage[];
  /** Above the cards, at their right (the conversation's auto-start switch). */
  header?: ReactNode;
  onEdit: (item: QueuedMessage) => void;
  onRemove: (item: QueuedMessage) => void;
  renderActions: (item: QueuedMessage) => ReactNode;
}) {
  const t = useTranslations('Sessions');
  const cardHeight = useQueueCardHeight();
  const stack = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const shown = items.length > 0;
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
      className="mx-auto mb-2 flex w-full max-w-(--chat-content-max-width) flex-col gap-1"
    >
      {header}
      <div
        ref={stack}
        className="relative"
        style={{ height: height ?? collapsedStackHeight(items.length, cardHeight) }}
      >
        <QueuedStack
          queue={items}
          bottom={0}
          onEdit={onEdit}
          onRemove={onRemove}
          renderActions={renderActions}
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
