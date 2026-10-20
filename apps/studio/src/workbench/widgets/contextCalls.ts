import { ModelProfileSnapshot, type RunEvent } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import type { ContextCall, ExecutionFact } from './selectors.ts';

export function contextCalls(
  events: RunEvent[],
  modelCalls: RunProjection['modelCalls'] | undefined,
  modelProfiles: RunProjection['modelProfiles'] | undefined,
  executions: ExecutionFact[],
): ContextCall[] {
  if (!modelCalls || !modelProfiles) return [];
  const payloadSnapshot = new Map<
    string,
    {
      coverage: 'messages' | 'request';
      completeness: ContextCall['completeness'];
      usedTokens: number | null;
      parts: ContextCall['parts'];
      method: string;
    }
  >();
  for (const event of events) {
    if (event.type !== 'model.payload_recorded' || !event.payload.contextUsage) continue;
    const usage = event.payload.contextUsage;
    payloadSnapshot.set(event.payload.modelCallId, {
      coverage: usage.coverage,
      completeness: usage.completeness,
      usedTokens: usage.usedTokens ?? null,
      parts: usage.parts,
      method: usage.method,
    });
  }
  const calls: ContextCall[] = [];
  const nodeModels = new Map<string, ModelProfileSnapshot>();
  const patchModels = new Map<string, ModelProfileSnapshot>();
  const executionModels = new Map<string, ModelProfileSnapshot>();
  for (const event of events) {
    if (event.type === 'patch.committed' && event.payload.kind === 'node_future') {
      const { patchId, scope, after } = event.payload;
      const parsed = ModelProfileSnapshot.safeParse(after.modelSnapshot);
      const inherited = scope.nodeId ? nodeModels.get(scope.nodeId) : undefined;
      const profile = typeof after.modelProfile === 'string' ? after.modelProfile : undefined;
      const model = parsed.success
        ? parsed.data
        : inherited && (!profile || inherited.profile === profile)
          ? inherited
          : profile
            ? modelProfiles[profile]
            : undefined;
      if (model) {
        patchModels.set(patchId, model);
        if (scope.nodeId) nodeModels.set(scope.nodeId, model);
      }
      continue;
    }
    if (event.type === 'patch.activated' && 'executionId' in event.payload) {
      const model = patchModels.get(event.payload.patchId);
      if (model) executionModels.set(event.payload.executionId, model);
      continue;
    }
    if (event.type !== 'model.request_recorded') continue;
    const call = modelCalls[event.payload.modelCallId];
    if (!call) continue;
    const activatedModel = executionModels.get(call.executionId);
    const model =
      activatedModel?.profile === call.profile ? activatedModel : modelProfiles[call.profile];
    const recorded = event.payload.contextUsage;
    const finalPayload = payloadSnapshot.get(event.payload.modelCallId);
    const usage =
      finalPayload ??
      (recorded
        ? {
            coverage: recorded.coverage,
            completeness:
              recorded.completeness === 'complete' ? ('partial' as const) : recorded.completeness,
            usedTokens: recorded.usedTokens ?? null,
            parts: recorded.parts,
            method: recorded.method,
          }
        : null);
    calls.push({
      modelCallId: event.payload.modelCallId,
      executionId: call.executionId,
      recordedAt: event.recordedAt,
      coverage: usage
        ? usage.coverage
        : event.payload.contextEstimate
          ? 'legacy-messages'
          : 'messages',
      completeness: usage
        ? usage.completeness
        : event.payload.contextEstimate
          ? 'legacy'
          : 'unmeasured',
      messageTokens: event.payload.contextEstimate?.tokens ?? null,
      usedTokens: usage?.usedTokens ?? null,
      parts: usage?.parts ?? [],
      windowTokens: model?.contextPolicy?.contextWindow ?? model?.contextWindow ?? null,
      reserveTokens: model?.contextPolicy?.reserveTokens ?? null,
      measurementStage: finalPayload ? 'payload' : recorded ? 'assembled' : 'legacy',
      providerInput: call.usage?.inputTokens ?? null,
      providerCacheRead: call.usage?.cachedInputTokens ?? null,
      providerOutput: call.usage?.outputTokens ?? null,
      roleLabel: executions.find((execution) => execution.executionId === call.executionId)
        ?.roleName,
      modelLabel: model?.modelId ?? undefined,
      method: usage?.method ?? event.payload.contextEstimate?.method,
      omissions: [
        ...new Set(usage?.parts.flatMap((part) => (part.omission ? [part.omission] : [])) ?? []),
      ],
    });
  }
  return calls;
}
