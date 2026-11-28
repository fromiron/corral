// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { monoFontFamily, monoFontReady } from './monoFont.ts';

const fonts = (value: unknown) =>
  Object.defineProperty(document, 'fonts', { configurable: true, value });

afterEach(() => {
  document.documentElement.style.removeProperty('--font-mono');
  fonts(undefined);
});

it('reads the monospace family from the token, and uses the generic family where there is none', () => {
  expect(monoFontFamily()).toBe('monospace');
  document.documentElement.style.setProperty(
    '--font-mono',
    ' "JetBrains Mono", ui-monospace, monospace ',
  );
  expect(monoFontFamily()).toBe('"JetBrains Mono", ui-monospace, monospace');
});

it('waits for the face at the size asked for, and goes on when it cannot be loaded', async () => {
  document.documentElement.style.setProperty('--font-mono', '"JetBrains Mono", monospace');
  const load = vi.fn(async (_font: string) => []);
  fonts({ load });
  await monoFontReady(14);
  expect(load).toHaveBeenCalledWith('14px "JetBrains Mono", monospace');

  load.mockRejectedValueOnce(new Error('offline'));
  await expect(monoFontReady(14)).resolves.toBeUndefined();
  fonts(undefined);
  await expect(monoFontReady(14)).resolves.toBeUndefined();
});
