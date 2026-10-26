import type { FileChangeView } from '@corral/client';
import { useState } from 'react';

// What a person marks while reading a review, kept in this browser per session
// (a view state). Reading is about a file's content and holds while the content is
// the same. Reviewing a change is about one comparison: it holds only for the same host, path and
// pair of contents, so reading the final file under A→B never reviews C→B. Neither is an
// approval; that is a ReviewService decision, and applying or staging are separate actions again.

/** A read of this content (the key "reviewed" used before change reviews existed). */
export const contentReadKey = (file: Pick<FileChangeView, 'path' | 'beforeBlob' | 'afterBlob'>) =>
  `${file.path}@${file.afterBlob ?? file.beforeBlob ?? 'gone'}`;

/** A review of this change: the same blob pair is the same change, whichever copy shows it. */
export const changeReviewKey = (
  hostId: string,
  file: Pick<FileChangeView, 'path' | 'beforeBlob' | 'afterBlob'>,
) => `change:${JSON.stringify([hostId, file.path, file.beforeBlob, file.afterBlob])}`;

export interface ReviewMarks {
  has(key: string): boolean;
  toggle(key: string): void;
  changeReviewed(file: FileChangeView): boolean;
  contentRead(file: FileChangeView): boolean;
  /** Marking a change reviewed also records reading it; unmarking keeps the read. */
  toggleChange(file: FileChangeView): void;
}

const load = (storageKey: string) => {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') as string[]);
  } catch {
    return new Set<string>();
  }
};

export function useReviewMarks(hostId: string, sessionId: string): ReviewMarks {
  const storageKey = `corral:reviewed:${sessionId}`;
  const [stored, setStored] = useState(() => ({ storageKey, keys: load(storageKey) }));
  // Another session's marks never stay on screen or get written under this session's key.
  if (stored.storageKey !== storageKey) setStored({ storageKey, keys: load(storageKey) });
  const keys = stored.storageKey === storageKey ? stored.keys : load(storageKey);
  const save = (next: Set<string>) => {
    setStored({ storageKey, keys: next });
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...next].slice(-2000)));
    } catch {
      // Remembered for this page only.
    }
  };
  const toggle = (key: string) => {
    const next = new Set(keys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    save(next);
  };
  return {
    has: (key) => keys.has(key),
    toggle,
    changeReviewed: (file) => keys.has(changeReviewKey(hostId, file)),
    contentRead: (file) => keys.has(contentReadKey(file)),
    toggleChange: (file) => {
      const next = new Set(keys);
      const key = changeReviewKey(hostId, file);
      if (next.has(key)) next.delete(key);
      else next.add(key).add(contentReadKey(file));
      save(next);
    },
  };
}
