'use client';

import { type KeyboardEvent, useCallback, useEffect, useRef } from 'react';
import { POPUP_NAV_KEYS } from '../lib/popup.ts';

/**
 * Shows a popup's focus ring only after keyboard use — Chrome grants
 * `:focus-visible` to script focus, so pointer-opened popups would otherwise
 * ring their first row. Attach `trackKeyboardNav` in the CAPTURE phase.
 */
export function useKeyboardNavGate(open: boolean) {
  const keyboardNavRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    // Seed from the opener: a keyboard-focused trigger matches :focus-visible,
    // and script focus moved into the popup inherits that state.
    const active = document.activeElement;
    keyboardNavRef.current = active instanceof HTMLElement && active.matches(':focus-visible');
  }, [open]);

  const trackKeyboardNav = useCallback((e: KeyboardEvent) => {
    if (POPUP_NAV_KEYS.includes(e.key)) keyboardNavRef.current = true;
  }, []);

  return { keyboardNavRef, trackKeyboardNav };
}
