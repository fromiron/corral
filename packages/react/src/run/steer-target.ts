import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { SteerTarget } from '../components/ReinsPanel.tsx';
import { agentName } from './advisor.ts';
import type { RunSessionStore } from './session.ts';

/**
 * Who the Reins steer: the execution the user chose; otherwise the latest one still working.
 * After the run ends the last execution stays shown read-only, so expired instructions remain
 * visible. An Outrider takes no person's instruction (features/advisor.md): it is never the
 * target, and choosing one targets nothing rather than another execution.
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
    // A chosen execution the run does not have, or an Outrider, targets nothing, never another.
    if (chosen && !takesInstruction(projection.executions[chosen])) return null;
    const instructable = executions.filter(takesInstruction);
    const execution =
      (chosen ? projection.executions[chosen] : undefined) ??
      [...instructable].reverse().find((e) => !TERMINAL_EXECUTION_STATUSES.has(e.status)) ??
      instructable.at(-1);
    if (!execution) return null;
    const label = agentName(definition, execution.nodeId, advisorWord);
    return {
      executionId: execution.executionId,
      nodeLabel: label,
      finished: TERMINAL_EXECUTION_STATUSES.has(execution.status),
    };
  }, [projection, definition, chosen, advisorWord]);
}

/** Whether a person may instruct this execution at all: it exists and is not an Outrider. */
export function takesInstruction(
  execution: RunProjection['executions'][string] | undefined,
): execution is RunProjection['executions'][string] {
  return !!execution && !execution.advisor;
}
