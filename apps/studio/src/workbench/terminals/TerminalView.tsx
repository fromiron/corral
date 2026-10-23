import { cn } from '@corral/react/design-kit';
import { useEffect, useRef } from 'react';
import type { TerminalProvenance, TerminalSourceState, TerminalStore } from './store.ts';

export interface TerminalViewProps {
  store: TerminalStore;
  terminalId: string;
  ariaLabel: string;
  'aria-describedby'?: string;
  className?: string;
  onExit?: () => void;
  revealSource?: TerminalProvenance;
  onReveal?: (state: TerminalSourceState) => void;
}

export function TerminalView({
  store,
  terminalId,
  ariaLabel,
  className,
  onExit,
  revealSource,
  onReveal,
  ...aria
}: TerminalViewProps) {
  const container = useRef<HTMLElement>(null);
  const exit = useRef(onExit);
  const reportReveal = useRef(onReveal);
  useEffect(() => {
    exit.current = onExit;
    reportReveal.current = onReveal;
  });
  useEffect(() => {
    let disposed = false;
    let detach = () => {};
    if (container.current) {
      void store
        .mount(
          terminalId,
          container.current,
          ariaLabel,
          () => exit.current?.(),
          aria['aria-describedby'],
        )
        .then((release) => {
          if (disposed) release();
          else {
            detach = release;
            if (revealSource)
              void store.revealSelection(revealSource).then(
                (found) => {
                  if (!disposed)
                    reportReveal.current?.(
                      found ? 'current' : store.inspectSelection(revealSource),
                    );
                },
                () => {
                  if (!disposed) reportReveal.current?.('unavailable');
                },
              );
          }
        });
    }
    return () => {
      disposed = true;
      detach();
    };
  }, [store, terminalId, ariaLabel, revealSource, aria['aria-describedby']]);
  return (
    <section
      ref={container}
      tabIndex={-1}
      aria-label={ariaLabel}
      aria-describedby={aria['aria-describedby']}
      className={cn(
        'h-80 min-h-64 min-w-0 overflow-hidden bg-surface p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring',
        className,
      )}
    />
  );
}
