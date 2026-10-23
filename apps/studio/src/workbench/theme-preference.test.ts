// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { applyTheme } from './preferences.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
});

it('pins the light scope on a dark OS and updates both scopes when switching back', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  expect(applyTheme('light')).toBe(false);
  expect(document.documentElement.classList.contains('light')).toBe(true);
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  expect(applyTheme('system')).toBe(true);
  expect(document.documentElement.classList.contains('light')).toBe(false);
  expect(document.documentElement.classList.contains('dark')).toBe(true);
});
