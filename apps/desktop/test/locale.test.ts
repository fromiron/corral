import { describe, expect, it } from 'vitest';
import { nativeLocale, parseDesktopLocale } from '../src/locale.ts';

describe('native surface language (#84)', () => {
  it('follows the language chosen in the app over the system', () => {
    expect(nativeLocale('en', 'ko-KR')).toBe('en');
    expect(nativeLocale('ko', 'en-US')).toBe('ko');
  });
  it('follows the system until the app chooses', () => {
    expect(nativeLocale(undefined, 'ko-KR')).toBe('ko');
    expect(nativeLocale(undefined, 'ja-JP')).toBe('en');
  });
  it('accepts only shipped languages from the page', () => {
    expect(parseDesktopLocale('ko')).toBe('ko');
    expect(parseDesktopLocale('fr')).toBeNull();
    expect(parseDesktopLocale({ toString: () => 'ko' })).toBeNull();
  });
});
