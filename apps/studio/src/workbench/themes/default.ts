import { resolvedThemeColors } from '../theme-colors.ts';
import type { Palette, PaletteBase } from './palette.ts';

/**
 * xterm's own sixteen ANSI colors, which the terminal keeps under the default palette
 * (`DEFAULT_ANSI_COLORS` in @xterm/xterm's src/browser/Types.ts; a test reads them from there).
 */
export const XTERM_DEFAULT_TERMINAL = [
  '#2e3436',
  '#cc0000',
  '#4e9a06',
  '#c4a000',
  '#3465a4',
  '#75507b',
  '#06989a',
  '#d3d7cf',
  '#555753',
  '#ef2929',
  '#8ae234',
  '#fce94f',
  '#729fcf',
  '#ad7fa8',
  '#34e2e2',
  '#eeeeec',
] as const;

/** The kit tokens a copy of the default palette reads: the UI colors, then the code block's. */
export const DEFAULT_PALETTE_TOKENS = [
  'surface-1',
  'foreground',
  'muted-foreground',
  'emphasis',
  'selected',
  'destructive',
  'success',
  'warning',
  'info',
  'syntax-comment',
  'syntax-keyword',
  'syntax-string',
  'syntax-number',
  'syntax-function',
  'syntax-type',
  'syntax-variable',
  'syntax-constant',
] as const;
type DefaultToken = (typeof DEFAULT_PALETTE_TOKENS)[number];

/** `#rrggbb` from what the canvas hands back (it adds an alpha byte for a translucent token). */
const opaque = (color: string) => color.slice(0, 7).toLowerCase();

/**
 * The default light or dark as a theme, for a new personal theme made while system, light or
 * dark is applied (docs/specs/features/themes.md, 개인 테마). It starts from the colors on screen:
 * the kit tokens resolved now, the code block's syntax defaults and xterm's sixteen colors. Its
 * computed surface steps follow the theme function, so they may differ slightly from the kit's.
 */
export function defaultPalette(
  name: string,
  base: PaletteBase,
  resolve: (names: readonly DefaultToken[]) => Record<DefaultToken, string> = resolvedThemeColors,
): Palette {
  const screen = resolve(DEFAULT_PALETTE_TOKENS);
  const color = (token: DefaultToken) => opaque(screen[token]);
  return {
    name,
    base,
    ui: {
      background: color('surface-1'),
      foreground: color('foreground'),
      muted: color('muted-foreground'),
      emphasis: color('emphasis'),
      selection: color('selected'),
      error: color('destructive'),
      success: color('success'),
      warning: color('warning'),
      info: color('info'),
    },
    syntax: {
      comment: color('syntax-comment'),
      keyword: color('syntax-keyword'),
      string: color('syntax-string'),
      number: color('syntax-number'),
      function: color('syntax-function'),
      type: color('syntax-type'),
      variable: color('syntax-variable'),
      constant: color('syntax-constant'),
    },
    terminal: [...XTERM_DEFAULT_TERMINAL],
  };
}
