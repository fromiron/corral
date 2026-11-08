import type { RunStats, RuntimeTransport } from '@corral/core';
import { useEffect, useState } from 'react';

export type RunStatsState =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'ready'; stats: RunStats }
  | { status: 'failed' };

/**
 * Run stats of one saved revision while `on`. Reads when turned on and when the revision changes,
 * never on its own (docs/specs/features/run-stats.md); an answer for a revision no longer open
 * is dropped.
 */
export function useRunStats(
  transport: Pick<RuntimeTransport, 'getRunStats'>,
  on: boolean,
  corralId: string,
  definitionRevision: number,
): RunStatsState {
  const [state, setState] = useState<RunStatsState>({ status: 'off' });
  useEffect(() => {
    if (!on) {
      setState({ status: 'off' });
      return;
    }
    let current = true;
    setState({ status: 'loading' });
    transport.getRunStats(corralId, definitionRevision).then(
      (stats) => {
        if (current) setState({ status: 'ready', stats });
      },
      () => {
        if (current) setState({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [transport, on, corralId, definitionRevision]);
  return on ? state : { status: 'off' };
}
