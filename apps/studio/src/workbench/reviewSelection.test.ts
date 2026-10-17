import { describe, expect, it } from 'vitest';
import { reviewSelection } from './reviewSelection.ts';

describe('DW-06 review line identity', () => {
  it('keeps side, line range and exact quote tied to the supplied file versions', () => {
    expect(
      reviewSelection({ start: 3, end: 2, side: 'deletions' }, 'one\ntwo\nthree\n', 'new\n'),
    ).toEqual({ side: 'before', startLine: 2, endLine: 3, quote: 'two\nthree' });
    expect(reviewSelection({ start: 1, end: 1, side: 'additions' }, 'old\n', 'new\n')).toEqual({
      side: 'after',
      startLine: 1,
      endLine: 1,
      quote: 'new',
    });
    for (const range of [
      { start: 0, end: 1 },
      { start: 1, end: 99 },
      { start: 1.5, end: 2 },
      { start: 1, end: 2, side: 'deletions' as const, endSide: 'additions' as const },
    ]) {
      expect(reviewSelection(range, 'one\ntwo', 'three')).toBeNull();
    }
  });
});
