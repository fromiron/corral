import { useState } from 'react';

const focusNode = (node: HTMLElement | null) => node?.focus();

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
