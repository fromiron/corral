import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { SteerTarget } from '../components/ReinsPanel.tsx';
import type { RunSessionStore } from './session.ts';

/**
 * Who the Reins steer: the execution the user chose; otherwise the latest one still working.
 * After the run ends the last execution stays shown read-only, so expired instructions remain
 * visible (Spec §4.4).
 */
export function useSteerTarget(
  session: RunSessionStore,
  chosen: string | null,
): SteerTarget | null {
  const projection = useStore(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  return useMemo(() => {
    if (!projection) return null;
    const executions = projection.executionOrder.map((id) => projection.executions[id]);
    const execution =
      (chosen ? projection.executions[chosen] : undefined) ??
      [...executions].reverse().find((e) => e && !TERMINAL_EXECUTION_STATUSES.has(e.status)) ??
      executions.at(-1);
    if (!execution) return null;
    const label =
      definition?.nodes.find((n) => n.id === execution.nodeId)?.label ?? execution.nodeId;
    return {
      executionId: execution.executionId,
      nodeLabel: label,
      finished: TERMINAL_EXECUTION_STATUSES.has(execution.status),
    };
  }, [projection, definition, chosen]);
}
