import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { ExecutionView, RunProjection } from '@corral/core';

// The demo guide reads committed run facts only. A click in the UI never completes a
// step, and a run that ends early leaves the remaining steps missed, not done (AGENTS 5).

export type GuideStepId = 'start' | 'delegate' | 'ask' | 'revise' | 'steer' | 'finish';
export type GuideStepState = 'pending' | 'current' | 'done' | 'missed';

export interface GuideStep {
  id: GuideStepId;
  state: GuideStepState;
  /** For the steer step: the running round 2+ Writer execution to steer. */
  steerTarget?: string;
}

export const GUIDE_STEP_IDS: readonly GuideStepId[] = [
  'start',
  'delegate',
  'ask',
  'revise',
  'steer',
  'finish',
];

/** Steering is optional: the run finishes whether or not the visitor tries it. */
const REQUIRED: readonly GuideStepId[] = ['start', 'delegate', 'ask', 'revise', 'finish'];

export function guideSteps(projection: RunProjection | null): GuideStep[] {
  const executions = projection
    ? projection.executionOrder.flatMap((id) => projection.executions[id] ?? [])
    : [];
  const roundOf = (e: ExecutionView) =>
    (e.iterationId ? projection?.iterations[e.iterationId]?.no : null) ?? 0;
  const research = new Set(
    executions.filter((e) => e.nodeId === 'research').map((e) => e.executionId),
  );
  const laterWriters = executions.filter((e) => e.nodeId === 'write' && roundOf(e) >= 2);
  const laterWriterIds = new Set(laterWriters.map((e) => e.executionId));
  const steerTarget = laterWriters.filter((e) => !TERMINAL_EXECUTION_STATUSES.has(e.status)).at(-1);

  const done: Record<GuideStepId, boolean> = {
    start: projection !== null,
    delegate:
      executions.filter(
        (e) => e.nodeId === 'helper' && e.parentExecutionId && research.has(e.parentExecutionId),
      ).length >= 2,
    ask: executions.some((e) => e.nodeId === 'respond' && e.status === 'succeeded'),
    revise: laterWriters.length > 0,
    steer: Object.values(projection?.directives ?? {}).some(
      (d) => d.status === 'delivered' && laterWriterIds.has(d.targetExecutionId),
    ),
    finish: projection?.status === 'succeeded',
  };
  const ended = projection !== null && TERMINAL_RUN_STATUSES.has(projection.status);
  const steerOpen = !ended && done.revise && !done.steer && steerTarget !== undefined;
  const firstOpen = REQUIRED.find((id) => !done[id]);

  const stateOf = (id: GuideStepId): GuideStepState => {
    if (done[id]) return 'done';
    if (ended) return 'missed';
    if (id === 'steer') {
      if (steerOpen) return 'current';
      return done.revise ? 'missed' : 'pending';
    }
    if (id === 'finish' && steerOpen) return 'pending';
    return id === firstOpen ? 'current' : 'pending';
  };

  return GUIDE_STEP_IDS.map((id) => {
    const state = stateOf(id);
    return id === 'steer' && state === 'current' && steerTarget
      ? { id, state, steerTarget: steerTarget.executionId }
      : { id, state };
  });
}
