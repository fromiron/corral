import { expect, it } from 'vitest';
import { resolveProfileContext } from '../src/profile-context.ts';

it('adaptive defaults fit small and large windows without a legacy warning', () => {
  for (const contextWindow of [1024, 8192, 32000, 128000, 1000000]) {
    const result = resolveProfileContext(
      {},
      { contextWindow, source: 'catalog' },
      'revision',
      4096,
    );
    expect(result.errors).toEqual([]);
    expect(result.policy?.version).toBe(2);
    expect(result.policy?.warnings).not.toContain('legacy_inconsistent');
    expect(result.policy!.reserveTokens).toBeLessThan(contextWindow);
    expect(result.policy!.keepRecentTokens).toBeLessThan(
      contextWindow - result.policy!.reserveTokens,
    );
  }
});
