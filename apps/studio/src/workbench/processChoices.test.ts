import { expect, it } from 'vitest';
import { chooseProcess, keepRowHeight, processChoice, rowHeight } from './processChoices.ts';

// Both memories keep the newest 200 entries; one used again counts as new.

it('keeps the heights of the 200 most recently measured rows', () => {
  for (let index = 0; index <= 200; index += 1) keepRowHeight(`run_${index}`, 100 + index);
  expect(rowHeight('run_0')).toBeNull();
  expect(rowHeight('run_1')).toBe(101);
  expect(rowHeight('run_200')).toBe(300);
});

it('a height measured again counts as the newest', () => {
  for (let index = 0; index < 200; index += 1) keepRowHeight(`run_${index}`, 100 + index);
  keepRowHeight('run_0', 50);
  keepRowHeight('run_200', 300);
  expect(rowHeight('run_0')).toBe(50);
  expect(rowHeight('run_1')).toBeNull();
});

it('keeps the 200 most recent log choices', () => {
  for (let index = 0; index <= 200; index += 1) chooseProcess(`run_${index}`, 'basic', true);
  expect(processChoice('run_0', 'basic')).toBeNull();
  expect(processChoice('run_1', 'basic')).toBe(true);
});
