import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import type { StudioServices } from './services.tsx';

// What a session sends: a follow-up run with its team, or an instruction to a
// running execution. Shared by the session's input box and the review page.

export const newCommandId = () => `cmd_${globalThis.crypto.randomUUID()}`;

/** The newest final result among ended runs (newest first in `runs`). */
export async function latestResult(
  services: Pick<StudioServices, 'transport'>,
  runs: RunSummary[],
): Promise<{ runId: string; id: string; label: string } | null> {
  for (const run of runs.filter((r) => TERMINAL_RUN_STATUSES.has(r.status))) {
    const { projection } = await services.transport.getSnapshot(run.runId);
    const id = projection.output?.artifactVersionIds[0];
    const artifact = id ? projection.artifacts[id] : undefined;
    if (id && artifact)
      return { runId: run.runId, id, label: `${artifact.name} v${artifact.version}` };
  }
  return null;
}

/** Starts a follow-up run of the session's team; returns the run or why not. */
export async function startFollowUp(
  services: Pick<StudioServices, 'transport' | 'repository' | 'mode'>,
  session: WorkSession,
  brief: string,
  options: {
    mode: 'mock' | 'live';
    startFrom: { runId: string; artifactVersionId: string } | null;
  },
): Promise<{ runId: string | null; detail: string | null }> {
  if (!session.corralId) return { runId: null, detail: 'no team' };
  const corral = await services.repository.get(session.corralId);
  if (!corral) return { runId: null, detail: 'no team' };
  const input = { brief, criteria: corral.definition.input.criteria };
  const common = {
    schemaVersion: '0.1' as const,
    commandId: newCommandId(),
    mode: options.mode,
    sessionId: session.sessionId,
    ...(options.startFrom ? { startFrom: options.startFrom } : {}),
  };
  const result = await services.transport.startRun(
    services.mode === 'server'
      ? {
          ...common,
          corralId: corral.corralId,
          definitionRevision: corral.definitionRevision,
          input,
        }
      : { ...common, definition: { ...corral.definition, input } },
  );
  return { runId: result.runId, detail: result.receipt.error?.message ?? null };
}

/** Executions of a run that can still take an instruction, named by their node. */
export async function steerTargets(
  services: Pick<StudioServices, 'transport'>,
  runId: string,
): Promise<{ id: string; label: string }[]> {
  const [{ projection }, definition] = await Promise.all([
    services.transport.getSnapshot(runId),
    services.transport.getRunDefinition(runId),
  ]);
  return projection.executionOrder.flatMap((id) => {
    const e = projection.executions[id];
    if (!e || TERMINAL_EXECUTION_STATUSES.has(e.status)) return [];
    const label = definition?.nodes.find((n) => n.id === e.nodeId)?.label ?? e.nodeId;
    return [{ id, label: `${label} · ${id}` }];
  });
}

/** Sends an instruction through Reins; the receipt says whether it was taken. */
export async function steer(
  services: Pick<StudioServices, 'transport'>,
  runId: string,
  executionId: string,
  text: string,
): Promise<{ sent: boolean; detail: string | null; commandId: string }> {
  const commandId = newCommandId();
  const receipt = await services.transport.sendCommand({
    schemaVersion: '0.1',
    commandId,
    runId,
    type: 'steer',
    payload: { targetExecutionId: executionId, text, delivery: 'next_request' },
  });
  return { sent: !receipt.error, detail: receipt.error?.message ?? null, commandId };
}
