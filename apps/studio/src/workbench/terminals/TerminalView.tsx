import { cn } from '@corral/react/ui';
import { useEffect, useRef } from 'react';
import type { TerminalStore } from './store.ts';

export interface TerminalViewProps {
  store: TerminalStore;
  terminalId: string;
  ariaLabel: string;
  'aria-describedby'?: string;
  className?: string;
  onExit?: () => void;
}

export function TerminalView({
  store,
  terminalId,
  ariaLabel,
  className,
  onExit,
  ...aria
}: TerminalViewProps) {
  const container = useRef<HTMLElement>(null);
  const exit = useRef(onExit);
  useEffect(() => {
    exit.current = onExit;
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
          else detach = release;
        });
    }
    return () => {
      disposed = true;
      detach();
    };
  }, [store, terminalId, ariaLabel, aria['aria-describedby']]);
  return (
    <section
      ref={container}
      tabIndex={-1}
      aria-label={ariaLabel}
      aria-describedby={aria['aria-describedby']}
      className={cn(
        'h-80 min-h-64 min-w-0 overflow-hidden bg-surface p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
        className,
      )}
    />
  );
}
