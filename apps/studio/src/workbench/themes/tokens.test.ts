import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, mix, relativeLuminance } from './color.ts';
import type { Palette } from './palette.ts';
import { legibleText, PALETTE_TOKENS, paletteTokens } from './tokens.ts';

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

  it('narrows a dark ladder until secondary text holds 4.5:1 on the top step, and never to nothing', () => {
    const top = (palette: Palette) => paletteTokens(palette)['--surface-8'] as string;
    const step = (palette: Palette) => paletteTokens(palette)['--surface-2'] as string;
    // Ample secondary text keeps the kit's own step: 3% of the text color per step.
    const ample: Palette = { ...dark, ui: { ...dark.ui, muted: '#d8d8d8' } };
    expect(top(ample)).toBe(mix(ample.ui.background, ample.ui.foreground, 0.21));
    // Secondary text tuned for the lower steps, as the built-in themes': the ladder narrows.
    const tuned: Palette = { ...dark, ui: { ...dark.ui, muted: '#a0a0a0' } };
    expect(top(tuned)).not.toBe(mix(tuned.ui.background, tuned.ui.foreground, 0.21));
    expect(contrastRatio(tuned.ui.muted, top(tuned))).toBeGreaterThanOrEqual(4.5);
    // Secondary text the theme puts under 4.5:1 on its own floor still gets a ladder that shows.
    const faint: Palette = { ...dark, ui: { ...dark.ui, muted: '#606060' } };
    expect(step(faint)).not.toBe(faint.ui.background);
    expect(top(faint)).not.toBe(step(faint));
  });

  it('fills buttons and rows with the most text color that keeps the text at 4.5:1, and never with none', () => {
    // Dim text, as One Dark Pro's, takes a lighter fill than the kit's white-over-dark tint.
    const dim: Palette = {
      ...dark,
      ui: { ...dark.ui, background: '#282c34', foreground: '#abb2bf' },
    };
    for (const palette of [dark, light, dim]) {
      const tokens = paletteTokens(palette);
      for (const fill of ['--accent', '--tint', '--tint-hover'])
        expect(
          contrastRatio(palette.ui.foreground, tokens[fill] as string),
          `${palette.name} ${fill}`,
        ).toBeGreaterThanOrEqual(4.5);
      // Hover sits between the floor and the resting fill, as the kit's pair does.
      expect(contrastRatio(tokens['--tint-hover'] as string, palette.ui.background)).toBeLessThan(
        contrastRatio(tokens['--tint'] as string, palette.ui.background),
      );
    }
    // Bright text keeps the kit's full step.
    expect(paletteTokens(dark)['--tint']).toBe(mix('#202020', '#f0f0f0', 0.25));
    expect(paletteTokens(dark)['--accent']).toBe(mix('#202020', '#f0f0f0', 0.22));
    // Text the theme itself puts under 4.5:1 (its owner's call) still gets a fill: the least step.
    const faint: Palette = { ...dark, ui: { ...dark.ui, foreground: '#505050' } };
    const tokens = paletteTokens(faint);
    expect(tokens['--tint']).toBe(mix('#202020', '#505050', 0.06));
    for (const fill of ['--accent', '--tint', '--tint-hover'])
      expect(tokens[fill]).not.toBe(faint.ui.background);
  });

  it('makes the quiet fill a little darker than the floor in both bases, so it shows on every surface step', () => {
    for (const palette of [dark, light]) {
      const tokens = paletteTokens(palette);
      const fill = tokens['--muted'] as string;
      for (const step of [1, 2, 3, 4, 5, 6, 7, 8])
        expect(fill, `${palette.name} step ${step}`).not.toBe(tokens[`--surface-${step}`]);
      expect(relativeLuminance(fill)).toBeLessThan(relativeLuminance(palette.ui.background));
      expect(contrastRatio(fill, palette.ui.background)).toBeLessThan(1.15);
    }
  });

  it('puts the text with the higher contrast on a filled error surface', () => {
    expect(paletteTokens(dark)['--destructive-contrast']).toBe('#202020');
    const pale = { ...light, ui: { ...light.ui, error: '#b00020' } };
    expect(paletteTokens(pale)['--destructive-contrast']).toBe('#f8f4e8');
  });

  it("lays the kit's overlay on a pointed-at and a chosen row, thinner only where the text needs it", () => {
    // Bright text keeps the kit's own strengths, as its token file declares them.
    const kit = declared();
    expect(kit.get('--hover')).toBe('light-dark(rgb(0 0 0 / 0.04), rgb(255 255 255 / 0.06))');
    expect(kit.get('--active')).toBe('light-dark(rgb(0 0 0 / 0.07), rgb(255 255 255 / 0.1))');
    expect(paletteTokens(dark)['--hover']).toBe('rgb(255 255 255 / 0.06)');
    expect(paletteTokens(dark)['--active']).toBe('rgb(255 255 255 / 0.1)');
    const bright = { ...light, ui: { ...light.ui, muted: '#505050' } };
    expect(paletteTokens(bright)['--hover']).toBe('rgb(0 0 0 / 0.04)');
    expect(paletteTokens(bright)['--active']).toBe('rgb(0 0 0 / 0.07)');
    // Secondary text close to the limit thins both, in the kit's proportion.
    const dim: Palette = {
      ...dark,
      ui: { ...dark.ui, background: '#282c34', foreground: '#abb2bf', muted: '#a2a6ad' },
    };
    const amount = (palette: Palette, name: string) =>
      Number(/\/ ([\d.]+)\)$/.exec(paletteTokens(palette)[name] as string)?.[1]);
    expect(amount(dim, '--active')).toBeLessThan(0.1);
    expect(amount(dim, '--hover') / amount(dim, '--active')).toBeCloseTo(0.6, 1);
    const tokens = paletteTokens(dim);
    for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const row = mix(tokens[`--surface-${step}`] as string, '#ffffff', amount(dim, '--active'));
      expect(contrastRatio(dim.ui.foreground, row), `text on step ${step}`).toBeGreaterThanOrEqual(
        4.5,
      );
      if (step <= 3)
        expect(
          contrastRatio(dim.ui.muted, row),
          `secondary text on step ${step}`,
        ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('never thins a row overlay past where a pointed-at row stops standing apart, and not at all in light', () => {
    const amount = (palette: Palette, name: string) =>
      Number(/\/ ([\d.]+)\)$/.exec(paletteTokens(palette)[name] as string)?.[1]);
    const pointedAtApart = (palette: Palette) => {
      const tokens = paletteTokens(palette);
      const over = palette.base === 'dark' ? '#ffffff' : '#000000';
      return [1, 2, 3].map((step) => {
        const surface = tokens[`--surface-${step}`] as string;
        return contrastRatio(mix(surface, over, amount(palette, '--hover')), surface);
      });
    };
    // Text the theme itself puts under 4.5:1 (its owner's call) still gets rows that show.
    const faint: Palette = { ...dark, ui: { ...dark.ui, foreground: '#505050', muted: '#484848' } };
    const tight: Palette = {
      ...dark,
      ui: { ...dark.ui, background: '#282c34', foreground: '#abb2bf', muted: '#8f939b' },
    };
    for (const palette of [faint, tight]) {
      expect(paletteTokens(palette)['--active']).toBe('rgb(255 255 255 / 0.045)');
      expect(paletteTokens(palette)['--hover']).toBe('rgb(255 255 255 / 0.027)');
      for (const apart of pointedAtApart(palette)) expect(apart).toBeGreaterThanOrEqual(1.07);
    }
    // In light the kit's own pointed-at row is already that faint, so nothing is thinned.
    const lightAndTight: Palette = {
      ...light,
      ui: { ...light.ui, background: '#fdf6e3', foreground: '#284b56', muted: '#616f6f' },
    };
    expect(paletteTokens(lightAndTight)['--hover']).toBe('rgb(0 0 0 / 0.04)');
    expect(paletteTokens(lightAndTight)['--active']).toBe('rgb(0 0 0 / 0.07)');
    for (const apart of pointedAtApart(lightAndTight)) expect(apart).toBeGreaterThanOrEqual(1.07);
  });

  it('writes lower-case #rrggbb values and the two row overlays, and only the tokens it lists', () => {
    for (const palette of [dark, light]) {
      const tokens = paletteTokens(palette);
      expect(Object.keys(tokens).sort()).toEqual([...PALETTE_TOKENS].sort());
      for (const [name, value] of Object.entries(tokens))
        if (name === '--hover' || name === '--active')
          expect(value).toMatch(/^rgb\((0 0 0|255 255 255) \/ 0\.\d+\)$/);
        else expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('overrides only color tokens the kit or Corral declare, and every direct kit color', () => {
    const values = declared();
    for (const token of PALETTE_TOKENS) expect(values.has(token), token).toBe(true);
    // A kit or Corral color written as a literal (not a reference to another token) is either
    // computed from the theme or one of the recipes left to the kit on purpose.
    const leftToKit = new Set([
      // The overlay's direction and the shadow recipes follow the base through the scope class.
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

describe('the default light and dark, which no theme function writes', () => {
  const values = declared();
  const pair = (name: string, base: 'light' | 'dark') => {
    const both = /^light-dark\((.+), (.+)\)$/.exec(values.get(name) ?? '');
    if (!both) throw new Error(`${name} is not a light-dark pair`);
    return (both[base === 'light' ? 1 : 2] as string).toLowerCase();
  };
  const overlay = (name: string, base: 'light' | 'dark') => {
    const parts = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(pair(name, base));
    if (!parts) throw new Error(`${name} is not an overlay`);
    const color = `#${parts
      .slice(1, 4)
      .map((channel) => Number(channel).toString(16).padStart(2, '0'))
      .join('')}`;
    return { color, amount: Number(parts[4]) };
  };

  it.each(['light', 'dark'] as const)(
    'keep the quiet fill a little darker than the floor in %s, apart from every surface step',
    (base) => {
      const fill = pair('--muted', base);
      for (const step of [1, 2, 3, 4, 5, 6, 7, 8])
        expect(fill, `step ${step}`).not.toBe(pair(`--surface-${step}`, base));
      expect(relativeLuminance(fill)).toBeLessThan(relativeLuminance(pair('--surface-1', base)));
    },
  );

  it.each(['light', 'dark'] as const)(
    'keep text and secondary text at 4.5:1 on a pointed-at or chosen row in %s, as a theme must',
    (base) => {
      const surfaces = [1, 2, 3, 4, 5, 6, 7, 8].map((step) => pair(`--surface-${step}`, base));
      for (const name of ['--hover', '--active']) {
        const { color, amount } = overlay(name, base);
        for (const [index, surface] of surfaces.entries()) {
          const row = mix(surface, color, amount);
          expect(
            contrastRatio(pair('--foreground', base), row),
            `text, ${name} on step ${index + 1}`,
          ).toBeGreaterThanOrEqual(4.5);
          if (index < 3)
            expect(
              contrastRatio(pair('--muted-foreground', base), row),
              `secondary text, ${name} on step ${index + 1}`,
            ).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );
});

describe('text that stays legible on a draft', () => {
  const surfaces = (palette: Palette) =>
    [1, 2, 3, 4, 5, 6, 7, 8].map((step) => paletteTokens(palette)[`--surface-${step}`] as string);
  const leastContrast = (text: string, palette: Palette) =>
    Math.min(...surfaces(palette).map((surface) => contrastRatio(text, surface)));

  it("is the theme's own text while it reads at 4.5:1 on every surface", () => {
    expect(legibleText(dark)).toBe(dark.ui.foreground);
    expect(legibleText(light)).toBe(light.ui.foreground);
  });

  it('turns black or white when the text color itself is too faint', () => {
    const faintDark = { ...dark, ui: { ...dark.ui, foreground: '#3a3a3a' } };
    expect(legibleText(faintDark)).toBe('#ffffff');
    const faintLight = { ...light, ui: { ...light.ui, foreground: '#e0dccf' } };
    expect(legibleText(faintLight)).toBe('#000000');
    for (const palette of [faintDark, faintLight])
      expect(leastContrast(legibleText(palette), palette)).toBeGreaterThanOrEqual(4.5);
  });
});
