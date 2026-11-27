import { useState } from 'react';

const focusNode = (node: HTMLElement | null) => node?.focus();

/**
 * Focus for a question asked in place of its button (Delete, then Confirm delete and Cancel).
 * The safe answer takes the focus when the question appears; cancelling gives it back to the
 * button the question replaced.
 */
export function useConfirmFocus() {
  const [focus] = useState(() => {
    let back = false;
    return {
      answer: focusNode,
      cancelled: () => {
        back = true;
      },
      opener: (node: HTMLElement | null) => {
        if (!node || !back) return;
        back = false;
        node.focus();
      },
    };
  });
  return focus;
}
