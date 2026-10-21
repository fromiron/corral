import type { EventPayload, ImageGenerationProfile, RunEvent, RunLimits } from '@corral/contracts';

export interface BudgetReservation {
  image?: {
    profileId: string;
    reservedMicros: number;
    actualMicros: number | null;
    usage?: { inputTokens: number | null; outputTokens: number | null };
  };
  modelCallId: string | null;
  scope: string;
  reserved: number;
  actual: number | null;
  status: 'reserved' | 'unknown' | 'settled';
}

export interface BudgetState {
  imageSpentMicros?: number;
  imageReservedMicros?: number;
  imageUnknownOutstandingMicros?: number;
  spent: number;
  reserved: number;
  unknownOutstanding: number;
  modelCalls: number;
  reservations: Record<string, BudgetReservation>;
}

export function emptyBudget(): BudgetState {
  return { spent: 0, reserved: 0, unknownOutstanding: 0, modelCalls: 0, reservations: {} };
}

export function applyBudgetEvent(state: BudgetState, event: RunEvent): BudgetState {
  if (event.type === 'budget.reserved') {
    const { reservationId, modelCallId, scope, amount } = event.payload;
    if (state.reservations[reservationId]) return state;
    return {
      ...state,
      reserved: state.reserved + amount.outputTokens,
      modelCalls: state.modelCalls + amount.modelCalls,
      ...(amount.image
        ? {
            imageSpentMicros: state.imageSpentMicros ?? 0,
            imageReservedMicros: (state.imageReservedMicros ?? 0) + amount.image.costMicros,
            imageUnknownOutstandingMicros: state.imageUnknownOutstandingMicros ?? 0,
          }
        : {}),
      reservations: {
        ...state.reservations,
        [reservationId]: {
          modelCallId,
          scope,
          reserved: amount.outputTokens,
          actual: null,
          status: 'reserved',
          ...(amount.image
            ? {
                image: {
                  profileId: amount.image.profileId,
                  reservedMicros: amount.image.costMicros,
                  actualMicros: null,
                },
              }
            : {}),
        },
      },
    };
  }
  if (event.type !== 'budget.settled') return state;
  const { reservationId, actual } = event.payload;
  const row = state.reservations[reservationId];
  if (
    !row ||
    row.status === 'settled' ||
    (row.status === 'unknown' &&
      (row.image
        ? actual.imageCostMicros == null &&
          (!actual.imageUsage ||
            JSON.stringify(actual.imageUsage) === JSON.stringify(row.image.usage))
        : actual.outputTokens === null))
  )
    return state;
  const unknown = row.image ? actual.imageCostMicros == null : actual.outputTokens === null;
  return {
    ...state,
    spent: state.spent + (actual.outputTokens ?? 0),
    reserved: state.reserved - (row.status === 'reserved' ? row.reserved : 0),
    unknownOutstanding:
      state.unknownOutstanding +
      (unknown ? row.reserved : 0) -
      (row.status === 'unknown' ? row.reserved : 0),
    ...(row.image
      ? {
          imageSpentMicros: (state.imageSpentMicros ?? 0) + (actual.imageCostMicros ?? 0),
          imageReservedMicros:
            (state.imageReservedMicros ?? 0) -
            (row.status === 'reserved' ? row.image.reservedMicros : 0),
          imageUnknownOutstandingMicros:
            (state.imageUnknownOutstandingMicros ?? 0) +
            (unknown ? row.image.reservedMicros : 0) -
            (row.status === 'unknown' ? row.image.reservedMicros : 0),
        }
      : {}),
    reservations: {
      ...state.reservations,
      [reservationId]: {
        ...row,
        actual: actual.outputTokens,
        status: unknown ? 'unknown' : 'settled',
        ...(row.image
          ? {
              image: {
                ...row.image,
                actualMicros: actual.imageCostMicros ?? null,
                ...(actual.imageUsage ? { usage: actual.imageUsage } : {}),
              },
            }
          : {}),
      },
    },
  };
}

export function settlementFor(
  state: BudgetState,
  reservationId: string,
  actual: number | null,
  imageCostMicros?: number | null,
  imageUsage?: { inputTokens: number | null; outputTokens: number | null },
): EventPayload<'budget.settled'> | null {
  if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0))
    throw new RangeError('output usage must be a non-negative integer or null');
  const row = state.reservations[reservationId];
  if (imageCostMicros != null && (!Number.isSafeInteger(imageCostMicros) || imageCostMicros < 0))
    throw new RangeError('image cost must be non-negative integer microdollars or null');
  if (
    imageUsage &&
    Object.values(imageUsage).some(
      (value) => value !== null && (!Number.isSafeInteger(value) || value < 0),
    )
  )
    throw new RangeError('image usage must be non-negative integers or null');
  if (
    !row ||
    row.status === 'settled' ||
    (row.status === 'unknown' &&
      (row.image
        ? imageCostMicros == null &&
          (!imageUsage || JSON.stringify(imageUsage) === JSON.stringify(row.image.usage))
        : actual === null))
  )
    return null;
  return {
    reservationId,
    actual: {
      outputTokens: actual,
      ...(row.image
        ? {
            imageCostMicros: imageCostMicros ?? null,
            ...(imageUsage ? { imageUsage } : {}),
          }
        : {}),
    },
    unknownOutstanding: actual === null ? row.reserved : 0,
  };
}

export function admitImageRequest(
  state: BudgetState,
  limits: RunLimits,
  profile: ImageGenerationProfile,
): { ok: true; costMicros: number } | { ok: false } {
  if (state.modelCalls >= limits.maxModelCalls) return { ok: false };
  const costMicros = Math.ceil(profile.maxCostUsdPerCall * 1_000_000);
  const rows = Object.values(state.reservations).filter(
    (row) => row.image?.profileId === profile.profileId,
  );
  const charged = rows.reduce(
    (sum, row) => sum + (row.image?.actualMicros ?? row.image?.reservedMicros ?? 0),
    0,
  );
  return rows.length < profile.maxCallsPerRun &&
    charged + costMicros <= costMicros * profile.maxCallsPerRun
    ? { ok: true, costMicros }
    : { ok: false };
}

export function admitModelRequest(
  state: BudgetState,
  limits: RunLimits,
):
  | { ok: true; maxOutputTokens: number }
  | {
      ok: false;
      limitKind: 'model_calls' | 'output_tokens';
      used: number;
      reserved: number;
      max: number;
    } {
  if (state.modelCalls >= limits.maxModelCalls) {
    return {
      ok: false,
      limitKind: 'model_calls',
      used: state.modelCalls,
      reserved: 0,
      max: limits.maxModelCalls,
    };
  }
  const outstanding = state.reserved + state.unknownOutstanding;
  const remaining = limits.maxOutputTokens - state.spent - outstanding;
  if (remaining <= 0) {
    return {
      ok: false,
      limitKind: 'output_tokens',
      used: state.spent,
      reserved: outstanding,
      max: limits.maxOutputTokens,
    };
  }
  return { ok: true, maxOutputTokens: Math.min(limits.maxOutputTokensPerCall, remaining) };
}
