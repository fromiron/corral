import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import { useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { SteerTarget } from '../components/ReinsPanel.tsx';
import { agentName } from './advisor.ts';
import type { RunSessionStore } from './session.ts';

/**
 * Who the Reins steer: the execution the user chose; otherwise the latest one still working.
 * After the run ends the last execution stays shown read-only, so expired instructions remain
 * visible.
 */
export function useSteerTarget(
  session: RunSessionStore,
  chosen: string | null,
): SteerTarget | null {
  const projection = useStore(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  const advisorWord = useTranslations('Advice')('advisor');
  return useMemo(() => {
    if (!projection) return null;
    const executions = projection.executionOrder.map((id) => projection.executions[id]);
    // A chosen execution the run does not have targets nothing, never a different one.
    if (chosen && !projection.executions[chosen]) return null;
    const execution =
      (chosen ? projection.executions[chosen] : undefined) ??
      [...executions].reverse().find((e) => e && !TERMINAL_EXECUTION_STATUSES.has(e.status)) ??
      executions.at(-1);
    if (!execution) return null;
    const label = agentName(definition, execution.nodeId, advisorWord);
    return {
      executionId: execution.executionId,
      nodeLabel: label,
      finished: TERMINAL_EXECUTION_STATUSES.has(execution.status),
    };
  }, [projection, definition, chosen, advisorWord]);
}
