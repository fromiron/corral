import { useEffect, useState } from 'react';
import type { AnnotateBridge } from '../../../desktop/src/annotate-bridge.ts';
import type { AnnotateContext } from './protocol.ts';

/** The overlay: nothing until the app page's context, since it has no app storage of its own. */
export function AnnotateApp({ bridge }: { bridge: AnnotateBridge }) {
  const [context, setContext] = useState<AnnotateContext | null>(null);
  useEffect(
    () =>
      bridge.onEvent((event) => {
        if (event.type === 'context') setContext(event.context as AnnotateContext);
        if (event.type === 'ending') void bridge.ended();
      }),
    [bridge],
  );
  if (!context) return null;
  return null;
}
