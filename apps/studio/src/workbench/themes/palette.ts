/**
 * A named theme: a base, nine UI colors, eight syntax colors and sixteen terminal colors
 * (docs/specs/features/themes.md). Every other color token is computed from these values
 * (tokens.ts), so a built-in theme and a personal theme with the same values look the same.
 */

export type PaletteBase = 'light' | 'dark';
export const PALETTE_BASES: readonly PaletteBase[] = ['light', 'dark'];

/** Background, text, secondary text, the one accent, selected rows and the four status hues. */
export const UI_COLORS = [
  'background',
  'foreground',
  'muted',
  'emphasis',
  'selection',
  'error',
  'success',
  'warning',
  'info',
] as const;
export type UiColor = (typeof UI_COLORS)[number];

export const SYNTAX_COLORS = [
  'comment',
  'keyword',
  'string',
  'number',
  'function',
  'type',
  'variable',
  'constant',
] as const;
export type SyntaxColor = (typeof SYNTAX_COLORS)[number];

/** ANSI 0–15: black, red, green, yellow, blue, magenta, cyan, white, then the bright eight. */
export const TERMINAL_COLOR_COUNT = 16;

export const PALETTE_NAME_MAX = 40;

export interface Palette {
  /** Trimmed, 1–40 characters. Shown as text only. */
  readonly name: string;
  readonly base: PaletteBase;
  /** Lower-case `#rrggbb`. */
  readonly ui: Readonly<Record<UiColor, string>>;
  readonly syntax: Readonly<Record<SyntaxColor, string>>;
  readonly terminal: readonly string[];
}

/** The preference value of a named theme (glossary: `builtin:<id>`, `custom:<id>`). */
export type PaletteId = `builtin:${string}` | `custom:${string}`;

const PALETTE_ID = /^(?:builtin|custom):[a-z0-9-]{1,64}$/;

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && PALETTE_ID.test(value);
}

export const builtinPaletteId = (id: string): PaletteId => `builtin:${id}`;
export const personalPaletteId = (id: string): PaletteId => `custom:${id}`;
