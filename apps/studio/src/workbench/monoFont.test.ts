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

it('waits for every face of the families the token names, and goes on when one cannot be loaded', async () => {
  document.documentElement.style.setProperty(
    '--font-mono',
    '"JetBrains Mono", "Geist Mono", monospace',
  );
  const face = (family: string, load = vi.fn(async () => undefined)) => ({ family, load });
  const latin = face('"JetBrains Mono"');
  const greek = face(
    'JetBrains Mono',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  const box = face("'Geist Mono'");
  const sans = face('Inter');
  fonts(new Set([latin, greek, box, sans]));
  await expect(monoFontReady()).resolves.toBeUndefined();
  for (const wanted of [latin, greek, box]) expect(wanted.load).toHaveBeenCalledTimes(1);
  expect(sans.load).not.toHaveBeenCalled();

  fonts(undefined);
  await expect(monoFontReady()).resolves.toBeUndefined();
});
