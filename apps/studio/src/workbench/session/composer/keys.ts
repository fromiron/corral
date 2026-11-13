import type { SessionEntry } from '@corral/core';
import { type KeyboardEvent, useState } from 'react';
import type { ComposerDraftState } from './useComposerDraft.ts';

// ↑/↓ in an empty box recall earlier requests. The send keys are the input's (ComposerInput).

export function useComposerKeys({
  draft,
  entries,
  write,
}: {
  draft: Pick<ComposerDraftState, 'text' | 'resetAttachments' | 'restore'>;
  entries: SessionEntry[];
  write: (value: string) => void;
}) {
  const { text, resetAttachments, restore } = draft;
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
      const value = next === -1 ? '' : (history[next] ?? '');
      write(value);
      // A recalled request comes back as every way back into the box brings it.
      const recalledEntry =
        next === -1 ? undefined : entries.findLast((entry) => entry.text === history[next]);
      restore(recalledEntry ?? { text: value });
    }
  };
  /** Typing leaves the recalled request. */
  const resetRecall = () => setRecall(-1);
  return { onKeyDown, resetRecall };
}
