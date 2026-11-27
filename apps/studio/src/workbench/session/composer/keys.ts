import { textAttachmentKey } from '@corral/contracts';
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
    'text' | 'attachments' | 'images' | 'resetAttachments' | 'restore'
  >;
  entries: SessionEntry[];
  write: (value: string) => void;
}) {
  const { text, attachments, images, resetAttachments, restore } = draft;
  const [recall, setRecall] = useState(-1);
  // Earlier requests, newest first, for ↑ in an empty box.
  const history = entries
    .map((e) => e.text)
    .filter((value, index, all) => value.trim() && all.lastIndexOf(value) === index)
    .reverse();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const box = event.currentTarget;
    const shown =
      recall >= 0 ? entries.findLast((entry) => entry.text === history[recall]) : undefined;
    const recalled =
      recall >= 0 &&
      text === history[recall] &&
      sameKeys(
        attachments.map(textAttachmentKey),
        (shown?.attachments ?? []).map(textAttachmentKey),
      ) &&
      sameKeys(
        images.map((image) => image.imageId),
        (shown?.images ?? []).map((image) => image.imageId),
      );
    const empty = text === '' && !attachments.length && !images.length;
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.shiftKey &&
      (empty || recalled) &&
      box.selectionStart === box.selectionEnd
    ) {
      const from = recalled ? recall : -1;
      const next = event.key === 'ArrowUp' ? from + 1 : from - 1;
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

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, index) => key === b[index]);
