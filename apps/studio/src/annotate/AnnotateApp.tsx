import { DesignKitProvider, SizeScope } from '@corral/react/design-kit';
import { useEffect, useRef, useState } from 'react';
import { IntlProvider } from 'use-intl';
import {
  Annotate as enAnnotate,
  Refusal as enRefusal,
  Select as enSelect,
} from '../../../../packages/react/src/messages/en.json';
import {
  Annotate as koAnnotate,
  Refusal as koRefusal,
  Select as koSelect,
} from '../../../../packages/react/src/messages/ko.json';
import type { AnnotateBridge } from '../../../desktop/src/annotate-bridge.ts';
import { Overlay } from './Overlay.tsx';
import type { AnnotateContext } from './protocol.ts';
import { applyContext } from './theme.ts';

// Only the namespaces the overlay draws, so the page carries none of the app's other words.
const MESSAGES = {
  en: { Annotate: enAnnotate, Refusal: enRefusal, Select: enSelect },
  ko: { Annotate: koAnnotate, Refusal: koRefusal, Select: koSelect },
};

/** Calls `tick` once per animation frame until the returned stop is called. */
export type Frames = (tick: () => void) => () => void;

export const animationFrames: Frames = (tick) => {
  let handle = requestAnimationFrame(function step() {
    tick();
    handle = requestAnimationFrame(step);
  });
  return () => cancelAnimationFrame(handle);
};

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The overlay: nothing until the app page's context, since it has no app storage of its own.
 * Events that come before it (the page, the focus) are kept for its first drawing.
 */
export function AnnotateApp({
  bridge,
  frames = animationFrames,
  newId = () => crypto.randomUUID(),
}: {
  bridge: AnnotateBridge;
  frames?: Frames;
  newId?: () => string;
}) {
  const [context, setContext] = useState<AnnotateContext | null>(null);
  const [page, setPage] = useState<{ kind: 'page' | 'preview'; generation: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const drawn = useRef(false);
  const ended = useRef(false);
  const tokens = useRef<ReadonlySet<string>>(new Set());
  drawn.current = context !== null;

  useEffect(() => {
    const end = () => {
      if (ended.current) return;
      ended.current = true;
      void bridge.ended();
    };
    return bridge.onEvent((event) => {
      switch (event.type) {
        case 'context':
          setContext(event.context as AnnotateContext);
          break;
        case 'page':
          setPage({ kind: event.kind, generation: event.generation });
          break;
        case 'navigated':
          setNavigation((n) => n + 1);
          break;
        case 'page-busy':
          setBusy(event.busy);
          break;
        case 'focus':
          setFocusRequest((n) => n + 1);
          break;
        case 'ending':
          // Nothing drawn, or nothing to watch: the exit has nothing to play.
          if (!drawn.current || reducedMotion()) end();
          setEnding(true);
          break;
      }
    });
  }, [bridge]);

  useEffect(() => {
    if (context) tokens.current = applyContext(document.documentElement, context, tokens.current);
  }, [context]);

  if (!context) return null;
  return (
    <IntlProvider
      locale={context.locale}
      messages={MESSAGES[context.locale]}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <DesignKitProvider size={context.density}>
        <SizeScope size={context.density}>
          <Overlay
            bridge={bridge}
            frames={frames}
            newId={newId}
            context={context}
            page={page}
            busy={busy}
            ending={ending}
            navigation={navigation}
            focusRequest={focusRequest}
            onExited={() => {
              if (ended.current) return;
              ended.current = true;
              void bridge.ended();
            }}
          />
        </SizeScope>
      </DesignKitProvider>
    </IntlProvider>
  );
}
