import type { ThemeRegistration } from '@pierre/diffs';
import type { ITheme } from '@xterm/xterm';
import type { editor } from 'monaco-editor/editor';
import type { Palette, SyntaxColor } from './palette.ts';

/**
 * How code surfaces take a theme. Monaco and xterm parse their own colors, so they receive
 * resolved sRGB values; the diff renderer reads the root's syntax tokens through CSS variables.
 * Without a named theme each keeps its behavior from before themes existed.
 */

/** The CSS tokens the editor resolves (theme-colors.ts) for its own colors. */
export const EDITOR_COLOR_TOKENS = [
  'surface',
  'text',
  'muted-foreground',
  'primary',
  'raised',
  'line',
  'danger',
  'warning',
  'focus-ring',
] as const;
export type EditorColors = Record<(typeof EDITOR_COLOR_TOKENS)[number], string>;

type Role = SyntaxColor | 'foreground' | 'error';
/**
 * Every token Monaco's own vs and vs-dark rules color, given a theme role, so no color of theirs
 * shows through under a named theme. Monarch tokens are prefix-matched: `string` also covers
 * `string.escape.ts`, while a more specific base rule (such as `string.key.json`) needs its own.
 */
const EDITOR_RULES: readonly (readonly [token: string, role: Role])[] = [
  ['', 'foreground'],
  ['invalid', 'error'],
  ['comment', 'comment'],
  ['keyword', 'keyword'],
  ['keyword.flow', 'keyword'],
  ['keyword.flow.scss', 'keyword'],
  ['keyword.json', 'constant'],
  ['string', 'string'],
  ['string.html', 'string'],
  ['string.sql', 'string'],
  ['string.yaml', 'string'],
  ['string.value', 'string'],
  ['string.value.json', 'string'],
  ['string.key', 'variable'],
  ['string.key.json', 'variable'],
  ['meta', 'foreground'],
  ['regexp', 'string'],
  ['number', 'number'],
  ['number.hex', 'number'],
  ['type', 'type'],
  ['variable', 'variable'],
  ['variable.parameter', 'variable'],
  ['variable.predefined', 'constant'],
  ['constant', 'constant'],
  ['predefined.sql', 'constant'],
  ['annotation', 'function'],
  ['key', 'variable'],
  ['attribute.name', 'variable'],
  ['attribute.value', 'string'],
  ['attribute.value.html', 'string'],
  ['attribute.value.xml', 'string'],
  ['attribute.value.number', 'number'],
  ['attribute.value.unit', 'number'],
  ['attribute.value.number.css', 'number'],
  ['attribute.value.unit.css', 'number'],
  ['attribute.value.hex.css', 'foreground'],
  ['tag', 'keyword'],
  ['tag.id.pug', 'keyword'],
  ['tag.class.pug', 'keyword'],
  ['meta.scss', 'keyword'],
  ['meta.tag', 'string'],
  ['metatag', 'keyword'],
  ['metatag.html', 'keyword'],
  ['metatag.xml', 'keyword'],
  ['metatag.content.html', 'string'],
  ['delimiter', 'foreground'],
  ['delimiter.html', 'foreground'],
  ['delimiter.xml', 'foreground'],
  ['operator.scss', 'foreground'],
  ['operator.sql', 'foreground'],
  ['operator.swift', 'foreground'],
];

function roleColor(palette: Palette, role: Role): string {
  if (role === 'foreground') return palette.ui.foreground;
  if (role === 'error') return palette.ui.error;
  return palette.syntax[role];
}

/** The `corral` Monaco theme. */
export function editorThemeData(
  colors: EditorColors,
  palette: Palette | null,
  dark: boolean,
): editor.IStandaloneThemeData {
  const base: editor.IStandaloneThemeData = {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': colors.surface,
      'editor.foreground': colors.text,
      'editorLineNumber.foreground': colors['muted-foreground'],
      'editorLineNumber.activeForeground': colors.text,
      'editorCursor.foreground': colors.primary,
      'editorWidget.background': colors.raised,
      'editorWidget.border': colors.line,
      'editorError.foreground': colors.danger,
      'editorWarning.foreground': colors.warning,
      focusBorder: colors['focus-ring'],
    },
  };
  if (!palette) return base;
  return {
    ...base,
    // Monaco takes rule colors without the leading '#'.
    rules: EDITOR_RULES.map(([token, role]) => ({
      token,
      foreground: roleColor(palette, role).slice(1),
    })),
    colors: { ...base.colors, 'editor.selectionBackground': palette.ui.selection },
  };
}

/** The CSS tokens the terminal resolves for its own four colors. */
export const TERMINAL_COLOR_TOKENS = ['surface', 'text', 'primary'] as const;
export type TerminalColors = Record<(typeof TERMINAL_COLOR_TOKENS)[number], string>;

const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

/** Without a named theme xterm keeps its own sixteen colors. */
export function terminalTheme(colors: TerminalColors, palette: Palette | null): ITheme {
  const theme: ITheme = {
    background: colors.surface,
    foreground: colors.text,
    cursor: colors.primary,
    cursorAccent: colors.surface,
  };
  if (!palette) return theme;
  return {
    ...theme,
    selectionBackground: palette.ui.selection,
    ...Object.fromEntries(ANSI.map((name, index) => [name, palette.terminal[index]])),
  };
}

export const DEFAULT_DIFF_THEMES = { dark: 'github-dark', light: 'github-light' } as const;
export const NAMED_DIFF_THEMES = { dark: 'corral-dark', light: 'corral-light' } as const;
export type DiffThemes = typeof DEFAULT_DIFF_THEMES | typeof NAMED_DIFF_THEMES;

export function diffThemes(palette: Palette | null): DiffThemes {
  return palette ? NAMED_DIFF_THEMES : DEFAULT_DIFF_THEMES;
}

const variable = (name: string) => `var(--${name})`;
const DIFF_SCOPES: readonly (readonly [scopes: string[], color: string])[] = [
  [['comment', 'punctuation.definition.comment', 'string.comment'], variable('syntax-comment')],
  [
    [
      'keyword',
      'keyword.control',
      'keyword.operator',
      'storage',
      'storage.type',
      'storage.modifier',
    ],
    variable('syntax-keyword'),
  ],
  [
    [
      'string',
      'string.template',
      'string.regexp',
      'punctuation.definition.string',
      'markup.inline.raw',
    ],
    variable('syntax-string'),
  ],
  [['constant.numeric'], variable('syntax-number')],
  [
    [
      'entity.name.function',
      'support.function',
      'variable.function',
      'entity.other.attribute-name',
    ],
    variable('syntax-function'),
  ],
  [
    [
      'entity.name.type',
      'entity.name.class',
      'entity.other.inherited-class',
      'support.type',
      'support.class',
    ],
    variable('syntax-type'),
  ],
  [
    [
      'variable',
      'variable.other',
      'variable.parameter',
      'support.variable',
      'meta.definition.variable',
    ],
    variable('syntax-variable'),
  ],
  [
    [
      'constant',
      'constant.language',
      'constant.character',
      'constant.other',
      'variable.other.constant',
      'variable.language',
      'support.constant',
    ],
    variable('syntax-constant'),
  ],
  [['entity.name.tag', 'markup.heading'], variable('syntax-keyword')],
  [['markup.inserted'], variable('success')],
  [['markup.deleted', 'invalid'], variable('destructive')],
];

/**
 * A highlighting theme whose colors are the root's syntax tokens, registered once per base.
 * Switching or previewing a named theme then changes the code's colors without a new highlight.
 */
export function diffThemeRegistration(type: 'light' | 'dark'): ThemeRegistration {
  return {
    name: NAMED_DIFF_THEMES[type],
    type,
    colors: {
      'editor.background': variable('background'),
      'editor.foreground': variable('foreground'),
      'gitDecoration.addedResourceForeground': variable('success'),
      'gitDecoration.deletedResourceForeground': variable('destructive'),
      'gitDecoration.modifiedResourceForeground': variable('info'),
    },
    tokenColors: DIFF_SCOPES.map(([scope, foreground]) => ({ scope, settings: { foreground } })),
  };
}
