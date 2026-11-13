import type { SessionEntry } from '@corral/core';
import {
  Button,
  collapsedStackHeight,
  type QueuedMessage,
  QueuedStack,
  Switch,
  useQueueCardHeight,
} from '@corral/react/design-kit';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

// A queued image's bytes, read once per address while the page is open, so the queue redrawing
// never reads them again. A read that fails stays the file glyph.
const imageBytes = new Map<string, Promise<Blob | null>>();
const readImage = (url: string) => {
  let read = imageBytes.get(url);
  if (!read) {
    read = fetch(url, { credentials: 'include' }).then(
      (response) => (response.ok ? response.blob() : null),
      () => null,
    );
    imageBytes.set(url, read);
  }
  return read;
};

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
  autoStartShown = true,
  onAutoStartChange,
  startDisabled,
  onStart,
  onEdit,
  onRemove,
  imageUrl,
}: {
  queued: SessionEntry[];
  /** Where a saved image of this session is read; none or empty in a browser demo. */
  imageUrl?: (imageId: string) => string;
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
  const cardHeight = useQueueCardHeight();
  const stack = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  // The images read so far, by address; until then a tile is the file glyph at the same size.
  const [read, setRead] = useState<ReadonlyMap<string, Blob>>(new Map());
  const urlOf = (imageId: string) => imageUrl?.(imageId) || null;
  const urls = queued.flatMap((entry) =>
    (entry.images ?? []).flatMap((item) => urlOf(item.imageId) ?? []),
  );
  const wanted = urls.join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again only when the addresses change
  useEffect(() => {
    let live = true;
    for (const url of urls)
      void readImage(url).then((blob) => {
        if (live && blob) setRead((done) => (done.has(url) ? done : new Map(done).set(url, blob)));
      });
    return () => {
      live = false;
    };
  }, [wanted]);
  // Text attachments and images travel with the request; the card shows them as file tiles.
  const identity = queued
    .map((entry) =>
      [
        entry.entryId,
        entry.text,
        ...(entry.attachments ?? []).map((item) => item.sha256),
        ...(entry.images ?? []).map(
          (item) => `${item.imageId}:${read.has(urlOf(item.imageId) ?? '')}`,
        ),
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
          // The preview a sent message shows; a typeless file is the glyph until it is read.
          ...(entry.images ?? []).map((item) => {
            const blob = read.get(urlOf(item.imageId) ?? '');
            return blob
              ? new File([blob], item.name, { type: item.mime })
              : new File([], item.name);
          }),
        ],
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
      className="mx-auto mb-2 flex w-full max-w-(--chat-content-max-width) flex-col gap-1"
    >
      {autoStartShown ? (
        <div className="flex justify-end px-1">
          <Switch
            label={t('autoStart')}
            title={t('autoStartHint')}
            checked={autoStart}
            onToggle={() => onAutoStartChange(!autoStart)}
          />
        </div>
      ) : null}
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
              <Button variant="ghost" disabled={startDisabled} onClick={() => onStart(entry)}>
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
