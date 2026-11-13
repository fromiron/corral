import type { SessionEntry } from '@corral/core';
import { type KeyboardEvent, useState } from 'react';
import type { ComposerDraftState } from './useComposerDraft.ts';

// ↑/↓ in an empty box recall earlier requests. The send keys are the input's (ComposerInput).

export function useComposerKeys({
  draft,
  entries,
  write,
}: {
  draft: Pick<
    ComposerDraftState,
    'text' | 'resetAttachments' | 'setAttachments' | 'setPermissionMode' | 'setImages'
  >;
  entries: SessionEntry[];
  write: (value: string) => void;
}) {
  const { text, resetAttachments, setAttachments, setPermissionMode, setImages } = draft;
  const [recall, setRecall] = useState(-1);
  // Earlier requests, newest first, for ↑ in an empty box.
  const history = entries
    .map((e) => e.text)
    .filter((value, index, all) => value.trim() && all.lastIndexOf(value) === index)
    .reverse();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const box = event.currentTarget;
    const recalled = recall >= 0 && text === history[recall];
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.shiftKey &&
      (text === '' || recalled) &&
      box.selectionStart === box.selectionEnd
    ) {
      const next = event.key === 'ArrowUp' ? recall + 1 : recall - 1;
      if (next < -1 || next >= history.length) return;
      event.preventDefault();
      setRecall(next);
      resetAttachments();
      write(next === -1 ? '' : (history[next] ?? ''));
      const recalledEntry =
        next === -1 ? undefined : entries.findLast((entry) => entry.text === history[next]);
      setAttachments(recalledEntry?.attachments ?? []);
      setPermissionMode(recalledEntry?.permissionMode);
      setImages(recalledEntry?.images ?? []);
    }
  };
  /** Typing leaves the recalled request. */
  const resetRecall = () => setRecall(-1);
  return { onKeyDown, resetRecall };
}
