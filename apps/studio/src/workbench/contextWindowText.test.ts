import { expect, it } from 'vitest';
import { parseContextWindow } from './contextWindowText.ts';

it('reads a context window written in tokens, thousands or millions, within 1 to 10,000,000', () => {
  expect(parseContextWindow('200000')).toBe(200_000);
  expect(parseContextWindow('200k')).toBe(200_000);
  expect(parseContextWindow('200K')).toBe(200_000);
  expect(parseContextWindow('1m')).toBe(1_000_000);
  expect(parseContextWindow(' 1M ')).toBe(1_000_000);
  expect(parseContextWindow('10m')).toBe(10_000_000);
  expect(parseContextWindow('1')).toBe(1);
  for (const text of [
    '',
    'off',
    '200x',
    '1.5m',
    '-1',
    '200 k',
    '2e5',
    '200,000',
    'k',
    '0',
    '0k',
    '20m',
    '10000001',
  ])
    expect(parseContextWindow(text), text).toBe('invalid');
});
