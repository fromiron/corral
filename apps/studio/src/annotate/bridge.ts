import type { AnnotateBridge } from '../../../desktop/src/annotate-bridge.ts';

declare global {
  interface Window {
    corralAnnotate?: AnnotateBridge;
  }
}

/** The overlay's only way out (the desktop's annotate-preload.cjs); none outside the desktop. */
export function annotateBridge(): AnnotateBridge | null {
  return window.corralAnnotate ?? null;
}
