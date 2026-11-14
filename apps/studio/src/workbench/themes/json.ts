import { isHexColor } from './color.ts';
import {
  PALETTE_BASES,
  PALETTE_NAME_MAX,
  type Palette,
  type PaletteBase,
  SYNTAX_COLORS,
  TERMINAL_COLOR_COUNT,
  UI_COLORS,
} from './palette.ts';

/** The Corral theme file (docs/specs/features/themes.md, 테마 JSON). */
export const THEME_FILE_VERSION = 1;
export const THEME_FILE_MAX_BYTES = 64 * 1024;

export type ThemeFileError =
  | 'too-large'
  | 'not-json'
  | 'not-object'
  | 'version'
  | 'fields'
  | 'name'
  | 'base'
  | 'color'
  | 'terminal';
export type ThemeParse = { ok: true; palette: Palette } | { ok: false; error: ThemeFileError };

const FILE_FIELDS = ['corralTheme', 'name', 'base', 'ui', 'syntax', 'terminal'] as const;
const PALETTE_FIELDS = ['name', 'base', 'ui', 'syntax', 'terminal'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

class Rejected extends Error {
  readonly reason: ThemeFileError;
  constructor(reason: ThemeFileError) {
    super(reason);
    this.reason = reason;
  }
}
const reject = (reason: ThemeFileError): never => {
  throw new Rejected(reason);
};

function colors<K extends string>(value: unknown, keys: readonly K[]): Record<K, string> {
  if (!isRecord(value) || !hasExactly(value, keys)) reject('fields');
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.map((key) => {
      const color = record[key];
      return [key, isHexColor(color) ? color.toLowerCase() : reject('color')];
    }),
  ) as Record<K, string>;
}

function palette(value: Record<string, unknown>): Palette {
  const name = typeof value.name === 'string' ? value.name.trim() : reject('name');
  const length = [...name].length;
  if (length < 1 || length > PALETTE_NAME_MAX) reject('name');
  if (!PALETTE_BASES.includes(value.base as PaletteBase)) reject('base');
  const ui = colors(value.ui, UI_COLORS);
  const syntax = colors(value.syntax, SYNTAX_COLORS);
  const terminal = value.terminal;
  if (!Array.isArray(terminal) || terminal.length !== TERMINAL_COLOR_COUNT) reject('terminal');
  return {
    name,
    base: value.base as PaletteBase,
    ui,
    syntax,
    terminal: (terminal as unknown[]).map((color) =>
      isHexColor(color) ? color.toLowerCase() : reject('color'),
    ),
  };
}

function attempt(read: () => Palette): ThemeParse {
  try {
    return { ok: true, palette: read() };
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, error: error.reason };
    throw error;
  }
}

/**
 * Reads a theme the same strict way wherever it comes from (an imported file, this device's
 * storage, the editor): exactly the theme's fields, `#rrggbb` colors, 16 terminal colors and a
 * 1–40 character name. Anything else rejects the whole theme; nothing is kept from it.
 */
export function checkPalette(value: unknown): ThemeParse {
  return attempt(() => {
    if (!isRecord(value)) reject('not-object');
    const record = value as Record<string, unknown>;
    if (!hasExactly(record, PALETTE_FIELDS)) reject('fields');
    return palette(record);
  });
}

/** Parses the text of a Corral theme file. */
export function parseTheme(text: string): ThemeParse {
  if (new TextEncoder().encode(text).length > THEME_FILE_MAX_BYTES)
    return { ok: false, error: 'too-large' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not-json' };
  }
  return attempt(() => {
    if (!isRecord(value)) reject('not-object');
    const record = value as Record<string, unknown>;
    if (!hasExactly(record, FILE_FIELDS)) reject('fields');
    if (record.corralTheme !== THEME_FILE_VERSION) reject('version');
    return palette(record);
  });
}

/** Reads a chosen file; one over the size limit is refused without reading its contents. */
export async function readThemeFile(file: Blob): Promise<ThemeParse> {
  if (file.size > THEME_FILE_MAX_BYTES) return { ok: false, error: 'too-large' };
  return parseTheme(await file.text());
}

// Characters no common file system takes in a name, control characters included.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
const UNSAFE_FILE_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;
const RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;

/** The exported file's name: the theme name made safe for a file name, then `.json`. */
export function themeFileName(name: string): string {
  const safe = name
    .replace(UNSAFE_FILE_CHARACTERS, '-')
    .trim()
    .replace(/^[-.\s]+|[-.\s]+$/g, '');
  if (!safe) return 'theme.json';
  return `${RESERVED_FILE_NAME.test(safe) ? `${safe}-theme` : safe}.json`;
}

/** The exported file: only the theme's own fields, in a fixed order, colors lower-cased. */
export function serializeTheme(value: Palette): string {
  const pick = <K extends string>(record: Readonly<Record<K, string>>, keys: readonly K[]) =>
    Object.fromEntries(keys.map((key) => [key, record[key].toLowerCase()]));
  return `${JSON.stringify(
    {
      corralTheme: THEME_FILE_VERSION,
      name: value.name.trim(),
      base: value.base,
      ui: pick(value.ui, UI_COLORS),
      syntax: pick(value.syntax, SYNTAX_COLORS),
      terminal: value.terminal.map((color) => color.toLowerCase()),
    },
    null,
    2,
  )}\n`;
}
