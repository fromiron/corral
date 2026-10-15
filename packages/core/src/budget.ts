import type { EventPayload, RunEvent, RunLimits } from '@corral/contracts';

export interface BudgetReservation {
  modelCallId: string | null;
  scope: string;
  reserved: number;
  actual: number | null;
  status: 'reserved' | 'unknown' | 'settled';
}

export interface BudgetState {
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
      reservations: {
        ...state.reservations,
        [reservationId]: {
          modelCallId,
          scope,
          reserved: amount.outputTokens,
          actual: null,
          status: 'reserved',
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
    (row.status === 'unknown' && actual.outputTokens === null)
  )
    return state;
  const unknown = actual.outputTokens === null;
  return {
    ...state,
    spent: state.spent + (actual.outputTokens ?? 0),
    reserved: state.reserved - (row.status === 'reserved' ? row.reserved : 0),
    unknownOutstanding:
      state.unknownOutstanding +
      (unknown ? row.reserved : 0) -
      (row.status === 'unknown' ? row.reserved : 0),
    reservations: {
      ...state.reservations,
      [reservationId]: {
        ...row,
        actual: actual.outputTokens,
        status: unknown ? 'unknown' : 'settled',
      },
    },
  };
}

export function settlementFor(
  state: BudgetState,
  reservationId: string,
  actual: number | null,
): EventPayload<'budget.settled'> | null {
  if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0))
    throw new RangeError('output usage must be a non-negative integer or null');
  const row = state.reservations[reservationId];
  if (!row || row.status === 'settled' || (row.status === 'unknown' && actual === null))
    return null;
  return {
    reservationId,
    actual: { outputTokens: actual },
    unknownOutstanding: actual === null ? row.reserved : 0,
  };
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
