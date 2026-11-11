import { contrastRatio, mix } from './color.ts';
import { type Palette, SYNTAX_COLORS } from './palette.ts';

const WHITE = '#ffffff';

/**
 * The one function from a theme's values to the root's color tokens (DESIGN.md, Colors). Built-in
 * and personal themes both go through it. Tokens it does not write keep the kit's own values,
 * which either derive from these (border, scrollbar, `background`, `card`, `primary` and the
 * other aliases) or follow the base through the `.light`/`.dark` scope (overlays, shadows,
 * scrim, checkerboard). Every value is a lower-case `#rrggbb`.
 */
export function paletteTokens(palette: Palette): Readonly<Record<string, string>> {
  const { ui, base } = palette;
  const dark = base === 'dark';
  // Dark: each elevation adds a little of the text color, as the kit's additive white ladder.
  // Light: the floor, a sunken step, then raised surfaces nearer white (the kit's flat white).
  const surface = (step: number) =>
    step === 1
      ? ui.background
      : dark
        ? mix(ui.background, ui.foreground, 0.03 * (step - 1))
        : mix(ui.background, WHITE, step === 2 ? 0.4 : 0.7);
  const tokens: Record<string, string> = {};
  for (let step = 1; step <= 8; step++) tokens[`--surface-${step}`] = surface(step);
  Object.assign(tokens, {
    '--foreground': ui.foreground,
    '--card-foreground': ui.foreground,
    '--accent-foreground': ui.foreground,
    // Quiet fill: the sunken step in dark; a little darker than the floor in light (as the kit).
    '--muted': dark ? surface(2) : mix(ui.background, ui.foreground, 0.045),
    '--muted-foreground': ui.muted,
    '--accent': mix(ui.background, ui.foreground, dark ? 0.22 : 0.09),
    '--selected': ui.selection,
    '--ring': mix(ui.background, ui.foreground, dark ? 0.16 : 0.1),
    '--input': mix(ui.background, ui.foreground, dark ? 0.16 : 0.1),
    '--destructive': ui.error,
    '--destructive-light': mix(dark ? ui.background : surface(3), ui.error, dark ? 0.16 : 0.07),
    '--destructive-contrast':
      contrastRatio(ui.background, ui.error) >= contrastRatio(ui.foreground, ui.error)
        ? ui.background
        : ui.foreground,
    '--success': ui.success,
    '--warning': ui.warning,
    '--info': ui.info,
    '--focus-ring': ui.emphasis,
    '--emphasis': ui.emphasis,
    // Hover darkens the accent in both bases, as the kit's own pair does.
    '--emphasis-hover': mix(ui.emphasis, dark ? ui.background : ui.foreground, 0.12),
  });
  for (const key of SYNTAX_COLORS) tokens[`--syntax-${key}`] = palette.syntax[key];
  return tokens;
}

/** Every custom property a theme writes on the root; going back to the default removes them. */
export const PALETTE_TOKENS: readonly string[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((step) => `--surface-${step}`),
  '--foreground',
  '--card-foreground',
  '--accent-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--selected',
  '--ring',
  '--input',
  '--destructive',
  '--destructive-light',
  '--destructive-contrast',
  '--success',
  '--warning',
  '--info',
  '--focus-ring',
  '--emphasis',
  '--emphasis-hover',
  ...SYNTAX_COLORS.map((key) => `--syntax-${key}`),
];
