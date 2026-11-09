import type { EventPayload } from '@corral/contracts';

// Runs have no usage budget (product contract §9); usage is recorded and shown. A run's model
// calls carry their own usage (`modelCalls`); `usage.recorded` holds what was spent outside them.

/** The output allowance of a request whose model reports no maximum (an estimate, §9). */
export const FALLBACK_OUTPUT_TOKENS = 4_096;

export type UsageRecordView = EventPayload<'usage.recorded'>;

/** A later record with the same id fills only the values the first one did not know. */
export function applyUsageRecord(
  records: Record<string, UsageRecordView>,
  record: UsageRecordView,
): Record<string, UsageRecordView> {
  const previous = records[record.usageId];
  if (!previous) return { ...records, [record.usageId]: record };
  const filled: UsageRecordView = {
    ...previous,
    profileId: previous.profileId ?? record.profileId,
    inputTokens: previous.inputTokens ?? record.inputTokens,
    outputTokens: previous.outputTokens ?? record.outputTokens,
    costMicros: previous.costMicros ?? record.costMicros,
  };
  return JSON.stringify(filled) === JSON.stringify(previous)
    ? records
    : { ...records, [record.usageId]: filled };
}

/** Whether a record would change what is known; a repeat or an all-null record does not. */
export function usageRecordChanges(
  records: Record<string, UsageRecordView>,
  record: UsageRecordView,
): boolean {
  return applyUsageRecord(records, record) !== records;
}

interface UsageSource {
  modelCalls: Record<
    string,
    { executionId: string; finished: boolean; usage: { outputTokens: number | null } | null }
  >;
  executions: Record<string, { status: string } | undefined>;
  usage: Record<string, UsageRecordView>;
}

export interface UsageTotals {
  /** Model requests: the run's model calls and its team chooser calls. */
  requests: number;
  /** Output tokens the providers reported; unreported counts are not guessed. */
  outputTokens: number;
  /** Requests still running. */
  inFlight: number;
  /** Requests that ended without reported output usage. */
  unknown: number;
  imageCalls: number;
  imageCostMicros: number;
  /** Image calls whose price nobody knows. */
  imageCostUnknown: number;
}

const ENDED = new Set(['succeeded', 'failed', 'cancelled']);

export function usageTotals(p: UsageSource): UsageTotals {
  const totals: UsageTotals = {
    requests: 0,
    outputTokens: 0,
    inFlight: 0,
    unknown: 0,
    imageCalls: 0,
    imageCostMicros: 0,
    imageCostUnknown: 0,
  };
  for (const call of Object.values(p.modelCalls)) {
    totals.requests += 1;
    const output = call.usage?.outputTokens ?? null;
    if (output !== null) totals.outputTokens += output;
    else if (call.finished || ENDED.has(p.executions[call.executionId]?.status ?? ''))
      totals.unknown += 1;
    else totals.inFlight += 1;
  }
  for (const record of Object.values(p.usage)) {
    if (record.kind === 'image') {
      totals.imageCalls += 1;
      if (record.costMicros === null) totals.imageCostUnknown += 1;
      else totals.imageCostMicros += record.costMicros;
      continue;
    }
    totals.requests += 1;
    if (record.outputTokens === null) totals.unknown += 1;
    else totals.outputTokens += record.outputTokens;
  }
  return totals;
}
