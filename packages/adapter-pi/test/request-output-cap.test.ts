import { describe, expect, it } from 'vitest';
import { requestOutputCap } from '../src/reasoning.ts';

describe('request output cap (CR-052)', () => {
  it('[TC-LLM-005-N] lowers an unlimited permit to the model maximum and keeps smaller permits', () => {
    expect(requestOutputCap({ maxTokens: 128_000 }, 1_000_000)).toBe(128_000);
    expect(requestOutputCap({ maxTokens: 128_000 }, 4096)).toBe(4096);
    expect(requestOutputCap({}, 4096)).toBe(4096);
  });
});
