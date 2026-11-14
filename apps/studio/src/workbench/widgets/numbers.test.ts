import { describe, expect, it } from 'vitest';
import { compactNumber } from './ChatWidgets.tsx';
import { formatCount } from './numbers.ts';

const intlCompact = (value: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

describe('formatCount', () => {
  it('writes a Korean count in full with grouping, never in a short form', () => {
    expect(formatCount(2400, 'ko', intlCompact)).toBe('2,400');
    expect(formatCount(1_234_567, 'ko', intlCompact)).toBe('1,234,567');
    expect(formatCount(999, 'ko', intlCompact)).toBe('999');
    expect(formatCount(2400, 'ko-KR', intlCompact)).toBe('2,400');
  });

  it('keeps the short form it is given in English', () => {
    expect(formatCount(2500, 'en', intlCompact)).toBe('2.5K');
    expect(formatCount(1_234_567, 'en', intlCompact)).toBe('1.2M');
    expect(formatCount(999, 'en', intlCompact)).toBe('999');
  });
});

describe('compactNumber', () => {
  it('is the full grouped count in Korean', () => {
    expect(compactNumber(2400, 'ko')).toBe('2,400');
    expect(compactNumber(12_345, 'ko')).toBe('12,345');
  });

  it('keeps the short English form', () => {
    expect(compactNumber(2400, 'en')).toBe('2.4k');
    expect(compactNumber(12_345, 'en')).toBe('12k');
    expect(compactNumber(640, 'en')).toBe('640');
  });
});
