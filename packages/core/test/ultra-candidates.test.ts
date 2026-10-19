import { DEFAULT_LIMITS } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { emptyBudget } from '../src/budget.ts';
import { candidateAllowance } from '../src/candidate-budget.ts';

describe('candidate comparison admission (CR-031)', () => {
  it('[TC-ULTRA-002-H] [TC-ULTRA-002-N] counts reserved and unknown usage, stops new work at 80 percent and protects final verification', () => {
    const limits = {
      ...DEFAULT_LIMITS,
      maxModelCalls: 10,
      maxOutputTokens: 10000,
      maxOutputTokensPerCall: 1000,
    };
    const state = emptyBudget();
    expect(candidateAllowance(state, limits, 'start')).toBe(1000);
    state.spent = 6000;
    state.reserved = 1000;
    state.unknownOutstanding = 1000;
    expect(candidateAllowance(state, limits, 'start')).toBe(0);
    expect(candidateAllowance(state, limits, 'revise')).toBe(0);
    expect(candidateAllowance(state, limits, 'work')).toBe(0);
    expect(candidateAllowance(state, limits, 'finish')).toBe(1000);
    state.spent = 5000;
    state.reserved = 0;
    state.unknownOutstanding = 0;
    state.modelCalls = 8;
    expect(candidateAllowance(state, limits, 'start')).toBe(0);
    expect(candidateAllowance(state, limits, 'work')).toBe(0);
    expect(candidateAllowance(state, limits, 'finish')).toBe(1000);
    state.spent = 5000;
    state.modelCalls = 0;
    expect(candidateAllowance(state, limits, 'start')).toBe(0);
    expect(candidateAllowance(state, limits, 'work')).toBe(1000);
    state.modelCalls = 10;
    expect(candidateAllowance(state, limits, 'finish')).toBe(0);
  });
});
