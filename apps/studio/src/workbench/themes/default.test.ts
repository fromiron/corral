import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE_TOKENS, defaultPalette, XTERM_DEFAULT_TERMINAL } from './default.ts';
import { checkPalette } from './json.ts';

/** A resolver that answers like the screen would: a distinct value per token. */
const screen: Record<(typeof DEFAULT_PALETTE_TOKENS)[number], string> = {
  'surface-1': '#171717',
  foreground: '#f5f5f5',
  'muted-foreground': '#b8b8b8',
  emphasis: '#6b97ff',
  selected: '#525252',
  destructive: '#fca5a5',
  success: '#86efac',
  warning: '#fcd34d',
  info: '#93c5fd',
  'syntax-comment': '#b8b8b9',
  'syntax-keyword': '#f5f5f6',
  'syntax-string': '#86efad',
  'syntax-number': '#fcd34e',
  'syntax-function': '#f5f5f7',
  'syntax-type': '#f5f5f8',
  'syntax-variable': '#f5f5f9',
  'syntax-constant': '#f5f5fa',
};

describe('the default light or dark as a theme', () => {
  it('takes the UI colors and the code block colors resolved on screen', () => {
    const asked: string[][] = [];
    const palette = defaultPalette('Dark', 'dark', (names) => {
      asked.push([...names]);
      return screen;
    });
    expect(asked).toEqual([[...DEFAULT_PALETTE_TOKENS]]);
    expect(palette).toEqual({
      name: 'Dark',
      base: 'dark',
      ui: {
        background: '#171717',
        foreground: '#f5f5f5',
        muted: '#b8b8b8',
        emphasis: '#6b97ff',
        selection: '#525252',
        error: '#fca5a5',
        success: '#86efac',
        warning: '#fcd34d',
        info: '#93c5fd',
      },
      syntax: {
        comment: '#b8b8b9',
        keyword: '#f5f5f6',
        string: '#86efad',
        number: '#fcd34e',
        function: '#f5f5f7',
        type: '#f5f5f8',
        variable: '#f5f5f9',
        constant: '#f5f5fa',
      },
      terminal: [...XTERM_DEFAULT_TERMINAL],
    });
    expect(checkPalette(palette)).toEqual({ ok: true, palette });
  });

  it('keeps every color an opaque lower-case #rrggbb whatever the canvas hands back', () => {
    const palette = defaultPalette('Light', 'light', () => ({
      ...screen,
      'surface-1': '#FAFAFA',
      selected: '#d4d4d480',
    }));
    expect(palette.base).toBe('light');
    expect(palette.ui.background).toBe('#fafafa');
    expect(palette.ui.selection).toBe('#d4d4d4');
    expect(checkPalette(palette).ok).toBe(true);
  });

  it("uses xterm's own sixteen colors, as the installed @xterm/xterm defines them", () => {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('@xterm/xterm/package.json'));
    const source = readFileSync(join(root, 'src/browser/Types.ts'), 'utf8');
    const table = source.slice(source.indexOf('DEFAULT_ANSI_COLORS'));
    const defined = [...table.matchAll(/css\.toColor\('(#[0-9a-f]{6})'\)/gi)]
      .slice(0, 16)
      .map((match) => (match[1] as string).toLowerCase());
    expect(defined).toHaveLength(16);
    expect([...XTERM_DEFAULT_TERMINAL]).toEqual(defined);
  });
});
