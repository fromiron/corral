import { DEFAULT_LIMITS, type RunEvent } from '@corral/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { admitModelRequest, applyBudgetEvent, emptyBudget, settlementFor } from '../src/budget.ts';

const event = (type: string, payload: unknown): RunEvent => ({ type, payload }) as RunEvent;
const reserve = (id: string, outputTokens: number) =>
  event('budget.reserved', {
    reservationId: id,
    modelCallId: id,
    scope: 'exec_a',
    amount: { outputTokens, modelCalls: 1 },
  });

describe('output-token reservations (C-037)', () => {
  it('[TC-RUN-006-H] concurrent requests reserve only the remaining output budget', () => {
    const limits = { ...DEFAULT_LIMITS, maxOutputTokens: 5_000 };
    let budget = emptyBudget();
    expect(admitModelRequest(budget, limits)).toEqual({ ok: true, maxOutputTokens: 4_096 });
    budget = applyBudgetEvent(budget, reserve('first', 4_096));
    expect(admitModelRequest(budget, limits)).toEqual({ ok: true, maxOutputTokens: 904 });
    budget = applyBudgetEvent(budget, reserve('second', 904));
    expect(admitModelRequest(budget, limits)).toMatchObject({
      ok: false,
      limitKind: 'output_tokens',
    });
  });

  it('[TC-RUN-006-N] unknown usage keeps its reservation charged; late actual usage settles once', () => {
    let budget = applyBudgetEvent(emptyBudget(), reserve('first', 4_096));
    budget = applyBudgetEvent(
      budget,
      event('budget.settled', settlementFor(budget, 'first', null)),
    );
    expect(budget).toMatchObject({
      spent: 0,
      reserved: 0,
      unknownOutstanding: 4_096,
      modelCalls: 1,
    });
    expect(settlementFor(budget, 'first', null)).toBeNull();
    budget = applyBudgetEvent(budget, event('budget.settled', settlementFor(budget, 'first', 27)));
    expect(budget).toMatchObject({ spent: 27, reserved: 0, unknownOutstanding: 0, modelCalls: 1 });
    expect(settlementFor(budget, 'first', 27)).toBeNull();
    expect(settlementFor(budget, 'first', 0)).toBeNull();
    expect(settlementFor(budget, 'missing', 27)).toBeNull();
  });

  it('[TC-RNS-007-H] [TC-RNS-007-N] patches change future admission without refunding spent or reserved', () => {
    let budget = applyBudgetEvent(emptyBudget(), reserve('first', 100));
    budget = applyBudgetEvent(budget, event('budget.settled', settlementFor(budget, 'first', 80)));
    budget = applyBudgetEvent(budget, reserve('second', 100));
    const before = JSON.parse(JSON.stringify(budget));
    expect(admitModelRequest(budget, { ...DEFAULT_LIMITS, maxOutputTokens: 150 })).toMatchObject({
      ok: false,
    });
    expect(admitModelRequest(budget, { ...DEFAULT_LIMITS, maxOutputTokens: 200 })).toEqual({
      ok: true,
      maxOutputTokens: 20,
    });
    expect(admitModelRequest(budget, { ...DEFAULT_LIMITS, maxModelCalls: 2 })).toMatchObject({
      ok: false,
      limitKind: 'model_calls',
    });
    expect(budget).toEqual(before);
  });

  it('[TC-RACE-05] seeded reserve, settle, duplicate and late settlement preserve INV-08', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            slot: fc.integer({ min: 0, max: 4 }),
            amount: fc.integer({ min: 0, max: 4_096 }),
            action: fc.constantFrom('reserve', 'unknown', 'actual'),
          }),
          { minLength: 1, maxLength: 100 },
        ),
        (actions) => {
          let budget = emptyBudget();
          const reservedIds = new Set<string>();
          for (const step of actions) {
            const id = `call_${step.slot}`;
            if (step.action === 'reserve') {
              reservedIds.add(id);
              budget = applyBudgetEvent(budget, reserve(id, step.amount));
            } else {
              const payload = settlementFor(
                budget,
                id,
                step.action === 'unknown' ? null : step.amount,
              );
              if (payload) {
                const settled = event('budget.settled', payload);
                budget = applyBudgetEvent(budget, settled);
                expect(applyBudgetEvent(budget, settled)).toEqual(budget);
              }
            }
            const rows = Object.values(budget.reservations);
            expect(rows).toHaveLength(reservedIds.size);
            expect(budget.spent).toBe(rows.reduce((sum, row) => sum + (row.actual ?? 0), 0));
            expect(budget.reserved).toBe(
              rows.reduce((sum, row) => sum + (row.status === 'reserved' ? row.reserved : 0), 0),
            );
            expect(budget.unknownOutstanding).toBe(
              rows.reduce((sum, row) => sum + (row.status === 'unknown' ? row.reserved : 0), 0),
            );
            expect(
              [budget.spent, budget.reserved, budget.unknownOutstanding].every((n) => n >= 0),
            ).toBe(true);
            expect(budget.modelCalls).toBe(rows.length);
          }
        },
      ),
      { seed: 2026101507, numRuns: 200 },
    );
  });
});
