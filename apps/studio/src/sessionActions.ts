import type { AutoRunStart } from '@corral/client';
import {
  type AutoModelChoice,
  type PermissionMode,
  type RunReference,
  TERMINAL_EXECUTION_STATUSES,
} from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import type { StudioServices } from './services.tsx';
import { sessionRunMode } from './workbench/autoChoice.ts';

// What a session sends: a follow-up run with its team, or an instruction to a
// running execution. Shared by the session's input box and the review page.

export const newCommandId = () => `cmd_${globalThis.crypto.randomUUID()}`;

/** The same conversation start for typed requests and review feedback. */
export function conversationRequest(
  services: Pick<StudioServices, 'mode' | 'live'>,
  session: Pick<WorkSession, 'sessionId' | 'corralId'>,
  input: {
    commandId: string;
    brief: string;
    choice: AutoModelChoice;
    team: 'none' | 'auto';
    throughRunId?: string;
    permissionMode?: PermissionMode;
    references?: RunReference[];
  },
): AutoRunStart {
  const { team, throughRunId, ...request } = input;
  return {
    ...request,
    sessionId: session.sessionId,
    team: session.corralId ? { corralId: session.corralId } : team,
    mode: sessionRunMode(services.mode, services.live),
    ...(throughRunId ? { conversation: { throughRunId } } : {}),
  };
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
