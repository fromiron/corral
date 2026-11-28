import { contrastRatio, mix } from './color.ts';
import { type Palette, SYNTAX_COLORS } from './palette.ts';

const WHITE = '#ffffff';
const BLACK = '#000000';

/**
 * How much of the text color goes into a fill that carries text (a secondary button, the open
 * file's row, a gray badge): the kit's own step, in hundredths, less where the theme's text is
 * too dim to stay at 4.5:1 on it, and never under a step that still shows.
 */
function textFillAmount(
  background: string,
  foreground: string,
  most: number,
  text = foreground,
  least = 6,
): number {
  for (let amount = most; amount > least; amount--)
    if (contrastRatio(text, mix(background, foreground, amount / 100)) >= 4.5) return amount / 100;
  return least / 100;
}

const RAISED_STEPS = 7;

const KIT_ROW_OVERLAY = {
  light: { rgb: '0 0 0', color: BLACK, hover: 0.04, active: 0.07, leastActive: 0.07 },
  dark: { rgb: '255 255 255', color: WHITE, hover: 0.06, active: 0.1, leastActive: 0.045 },
} as const;
const STEPS_WITH_SECONDARY_TEXT_ROWS = 3;

function chosenRowOverlayAmount(
  surfaces: readonly string[],
  over: string,
  text: string,
  secondary: string,
  most: number,
  least: number,
): number {
  const holds = (amount: number) =>
    surfaces.every((surface, index) => {
      const row = mix(surface, over, amount);
      return (
        contrastRatio(text, row) >= 4.5 &&
        (index >= STEPS_WITH_SECONDARY_TEXT_ROWS || contrastRatio(secondary, row) >= 4.5)
      );
    });
  for (let step = Math.round(most * 200); step > Math.round(least * 200); step--)
    if (holds(step / 200)) return step / 200;
  return least;
}

/**
 * The one function from a theme's values to the root's color tokens (DESIGN.md, Colors). Built-in
 * and personal themes both go through it. Tokens it does not write keep the kit's own values,
 * which either derive from these (border, scrollbar, `background`, `card`, `primary` and the
 * other aliases) or follow the base through the `.light`/`.dark` scope (shadows, scrim,
 * checkerboard). Values are lower-case `#rrggbb`; the two row overlays keep the kit's `rgb()`.
 */
export function paletteTokens(palette: Palette): Readonly<Record<string, string>> {
  const { ui, base } = palette;
  const dark = base === 'dark';
  const textFill = (most: number) =>
    mix(ui.background, ui.foreground, textFillAmount(ui.background, ui.foreground, most));
  const tint = textFillAmount(ui.background, ui.foreground, dark ? 25 : 8);
  const topStep = textFillAmount(
    ui.background,
    ui.foreground,
    3 * RAISED_STEPS,
    ui.muted,
    RAISED_STEPS,
  );
  // Dark: each elevation adds a little of the text color, as the kit's additive white ladder.
  // Light: the floor, a sunken step, then raised surfaces nearer white (the kit's flat white).
  const surface = (step: number) =>
    step === 1
      ? ui.background
      : dark
        ? mix(ui.background, ui.foreground, (topStep * (step - 1)) / RAISED_STEPS)
        : mix(ui.background, WHITE, step === 2 ? 0.4 : 0.7);
  const tokens: Record<string, string> = {};
  for (let step = 1; step <= 8; step++) tokens[`--surface-${step}`] = surface(step);
  const overlay = KIT_ROW_OVERLAY[base];
  const active = chosenRowOverlayAmount(
    [1, 2, 3, 4, 5, 6, 7, 8].map(surface),
    overlay.color,
    ui.foreground,
    ui.muted,
    overlay.active,
    overlay.leastActive,
  );
  const hover = Math.round((overlay.hover * active * 1000) / overlay.active) / 1000;
  Object.assign(tokens, {
    '--foreground': ui.foreground,
    '--card-foreground': ui.foreground,
    '--accent-foreground': ui.foreground,
    // Quiet fill: a little darker than the floor in both bases, so it shows on every step.
    '--muted': mix(ui.background, dark ? BLACK : ui.foreground, dark ? 0.22 : 0.045),
    '--muted-foreground': ui.muted,
    '--accent': textFill(dark ? 22 : 9),
    // The kit's tint pair is white (or black) over the surface; here an opaque fill, with hover
    // nearer the floor than rest, as the kit's.
    '--tint': mix(ui.background, ui.foreground, tint),
    '--tint-hover': mix(ui.background, ui.foreground, tint * 0.8),
    '--selected': ui.selection,
    '--hover': `rgb(${overlay.rgb} / ${hover})`,
    '--active': `rgb(${overlay.rgb} / ${active})`,
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
  '--tint',
  '--tint-hover',
  '--selected',
  '--hover',
  '--active',
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

/**
 * A text color that reads on every surface of a draft, for marks that must stay legible however
 * the draft's own colors turn out (the editor's low-contrast mark): the theme's text while it
 * reaches 4.5:1 on each surface step, otherwise black or white, whichever reads better.
 */
export function legibleText(palette: Palette): string {
  const tokens = paletteTokens(palette);
  const surfaces = [1, 2, 3, 4, 5, 6, 7, 8].map((step) => tokens[`--surface-${step}`] as string);
  const least = (text: string) =>
    Math.min(...surfaces.map((surface) => contrastRatio(text, surface)));
  if (least(palette.ui.foreground) >= 4.5) return palette.ui.foreground;
  return least(BLACK) >= least(WHITE) ? BLACK : WHITE;
}
