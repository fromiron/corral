import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './color.ts';
import type { Palette } from './palette.ts';
import { PALETTE_TOKENS, paletteTokens } from './tokens.ts';

const dark: Palette = {
  name: 'Night',
  base: 'dark',
  ui: {
    background: '#202020',
    foreground: '#f0f0f0',
    muted: '#b0b0b0',
    emphasis: '#7aa2f7',
    selection: '#404858',
    error: '#ff8080',
    success: '#80e080',
    warning: '#f0d060',
    info: '#80c0ff',
  },
  syntax: {
    comment: '#808080',
    keyword: '#ff79c6',
    string: '#f1fa8c',
    number: '#bd93f9',
    function: '#50fa7b',
    type: '#8be9fd',
    variable: '#f8f8f2',
    constant: '#bd93f9',
  },
  terminal: Array.from({ length: 16 }, (_, index) => `#${index.toString(16).repeat(6)}`),
};
const light: Palette = {
  ...dark,
  name: 'Day',
  base: 'light',
  ui: { ...dark.ui, background: '#f8f4e8', foreground: '#303030', muted: '#606060' },
};

const css = (path: string) =>
  readFileSync(join(import.meta.dirname, '../../../../../packages/react/src', path), 'utf8');
/** Every custom property the kit and Corral declare, with its declared value. */
function declared(): Map<string, string> {
  const values = new Map<string, string>();
  for (const body of [css('design-kit/tokens.css'), css('theme.css')])
    for (const match of body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
      values.set(match[1] as string, (match[2] as string).trim());
  return values;
}

describe('the one token function', () => {
  it('takes text, status and accent colors from the theme and the floor from its background', () => {
    const tokens = paletteTokens(dark);
    expect(tokens['--surface-1']).toBe('#202020');
    expect(tokens['--foreground']).toBe('#f0f0f0');
    expect(tokens['--card-foreground']).toBe('#f0f0f0');
    expect(tokens['--accent-foreground']).toBe('#f0f0f0');
    expect(tokens['--muted-foreground']).toBe('#b0b0b0');
    expect(tokens['--emphasis']).toBe('#7aa2f7');
    expect(tokens['--focus-ring']).toBe('#7aa2f7');
    expect(tokens['--selected']).toBe('#404858');
    expect(tokens['--destructive']).toBe('#ff8080');
    expect(tokens['--success']).toBe('#80e080');
    expect(tokens['--warning']).toBe('#f0d060');
    expect(tokens['--info']).toBe('#80c0ff');
    for (const [key, value] of Object.entries(dark.syntax))
      expect(tokens[`--syntax-${key}`]).toBe(value);
  });

  it('raises a dark surface ladder toward the text and a light one toward white', () => {
    for (const palette of [dark, light]) {
      const tokens = paletteTokens(palette);
      const ladder = [1, 2, 3, 4, 5, 6, 7, 8].map((step) => tokens[`--surface-${step}`] as string);
      for (const [index, surface] of ladder.entries()) {
        if (index === 0) continue;
        // Each step is at least as far from the floor as the one below it.
        expect(contrastRatio(surface, palette.ui.background)).toBeGreaterThanOrEqual(
          contrastRatio(ladder[index - 1] as string, palette.ui.background),
        );
      }
      expect(ladder[1]).not.toBe(ladder[0]);
    }
  });

  it('puts the text with the higher contrast on a filled error surface', () => {
    expect(paletteTokens(dark)['--destructive-contrast']).toBe('#202020');
    const pale = { ...light, ui: { ...light.ui, error: '#b00020' } };
    expect(paletteTokens(pale)['--destructive-contrast']).toBe('#f8f4e8');
  });

  it('writes only lower-case #rrggbb values, and only the tokens it lists', () => {
    for (const palette of [dark, light]) {
      const tokens = paletteTokens(palette);
      expect(Object.keys(tokens).sort()).toEqual([...PALETTE_TOKENS].sort());
      for (const value of Object.values(tokens)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('overrides only color tokens the kit or Corral declare, and every direct kit color', () => {
    const values = declared();
    for (const token of PALETTE_TOKENS) expect(values.has(token), token).toBe(true);
    // A kit or Corral color written as a literal (not a reference to another token) is either
    // computed from the theme or one of the recipes left to the kit on purpose.
    const leftToKit = new Set([
      // Surface-relative overlays and the shadow recipes follow the base through the scope class.
      '--hover',
      '--active',
      '--tint',
      '--tint-hover',
      '--overlay',
      '--shadow-color',
      '--dm-hi-base',
      '--dm-hi-mid',
      '--dm-hi-high',
      '--dm-hi-peak',
      '--dm-ring-base',
      '--dm-ring-mid',
      '--dm-ring-high',
      '--dm-drop',
      // The color picker's alpha checkerboard, the media control backing and the dialog scrim.
      '--checker-a',
      '--checker-b',
      '--media-control-background',
      '--dialog-scrim',
    ]);
    const literal = [...values]
      .filter(([, value]) => /#[0-9a-f]{3,8}\b|rgba?\(|light-dark\(/i.test(value))
      .filter(([name]) => !name.startsWith('--shadow-light') && !name.startsWith('--shadow-dark'))
      .map(([name]) => name);
    const uncovered = literal.filter(
      (name) => !PALETTE_TOKENS.includes(name) && !leftToKit.has(name),
    );
    expect(uncovered).toEqual([]);
  });
});
