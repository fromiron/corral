import type { SessionEntry } from '@corral/core';
import { type KeyboardEvent, useState } from 'react';
import { isSendKey, type Preferences } from '../../preferences.ts';
import type { ComposerDraftState } from './useComposerDraft.ts';

// The composer's keys: the send key, and ↑/↓ in an empty box to recall earlier requests.

export function useComposerKeys({
  draft,
  entries,
  write,
  sendKey,
  send,
}: {
  draft: Pick<
    ComposerDraftState,
    'text' | 'resetAttachments' | 'setAttachments' | 'setPermissionMode' | 'setImages'
  >;
  entries: SessionEntry[];
  write: (value: string) => void;
  sendKey: Preferences['sendKey'];
  send: () => void;
}) {
  const { text, resetAttachments, setAttachments, setPermissionMode, setImages } = draft;
  const [recall, setRecall] = useState(-1);
  // Earlier requests, newest first, for ↑ in an empty box.
  const history = entries
    .map((e) => e.text)
    .filter((value, index, all) => value.trim() && all.lastIndexOf(value) === index)
    .reverse();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME composition's Enter confirms the text; it never sends.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (isSendKey(event, sendKey)) {
      event.preventDefault();
      send();
      return;
    }
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
