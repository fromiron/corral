// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { resolvedThemeColors } from './theme-colors.ts';

afterEach(() => vi.restoreAllMocks());

it('resolves CSS tokens to sRGB hex, preserves alpha, and removes the probe', () => {
  const pixels = [
    [23, 23, 23, 255],
    [245, 245, 245, 31],
  ];
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
    getImageData: () => ({ data: pixels.shift() }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  const computed = vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    expect(element.isConnected).toBe(true);
    return { color: 'rgb(23, 23, 23)' } as CSSStyleDeclaration;
  });
  const before = document.body.childElementCount;
  expect(resolvedThemeColors(['surface', 'line'])).toEqual({
    surface: '#171717',
    line: '#f5f5f51f',
  });
  expect(computed).toHaveBeenCalledTimes(2);
  expect(document.body.childElementCount).toBe(before);
});
