import { ModelProfileSnapshot } from '@corral/contracts';
import type { RunProjection } from '@corral/core';

export interface ObservedAgentModel {
  name: string;
  provider: string | null;
  identified: boolean;
}

/** Resolve the pinned model at each execution/request revision, including node_future changes. */
export function observedAgentModels(
  projection: RunProjection | null,
  executionIds: readonly string[],
): ObservedAgentModel[] {
  if (!projection) return [];
  const models = new Map<string, ObservedAgentModel>();
  for (const id of executionIds) {
    const execution = projection.executions[id];
    if (!execution) continue;
    const calls = execution.modelCallIds.flatMap((call) => projection.modelCalls[call] ?? []);
    const records = calls.length
      ? calls.map((call) => ({ profile: call.profile, revision: call.configRevision }))
      : [{ profile: execution.modelProfile, revision: execution.configRevision }];
    for (const record of records) {
      let snapshot = projection.modelProfiles[record.profile];
      let revision = -1;
      for (const patch of Object.values(projection.patches)) {
        if (
          patch.kind !== 'node_future' ||
          patch.scope.nodeId !== execution.nodeId ||
          patch.controlRevision > record.revision ||
          patch.controlRevision <= revision
        )
          continue;
        const parsed = ModelProfileSnapshot.safeParse(patch.after.modelSnapshot);
        if (!parsed.success || parsed.data.profile !== record.profile) continue;
        snapshot = parsed.data;
        revision = patch.controlRevision;
      }
      const key = snapshot?.modelId
        ? JSON.stringify([snapshot.provider, snapshot.modelId])
        : `profile:${record.profile}`;
      models.set(key, {
        name: snapshot?.modelId ?? record.profile,
        provider: snapshot?.provider ?? null,
        identified: !!snapshot?.modelId,
      });
    }
  }
  return [...models.values()];
}
