import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from './builtin.ts';
import {
  DEFAULT_DIFF_THEMES,
  diffThemeRegistration,
  diffThemes,
  EDITOR_COLOR_TOKENS,
  editorThemeData,
  NAMED_DIFF_THEMES,
  TERMINAL_COLOR_TOKENS,
  terminalTheme,
} from './code.ts';
import type { Palette } from './palette.ts';

const monokai = BUILTIN_THEMES.find((theme) => theme.id === 'monokai')?.palette as Palette;
const resolved = <K extends string>(names: readonly K[]) =>
  Object.fromEntries(
    names.map((name, index) => [name, `#0000${index.toString(16).padStart(2, '0')}`]),
  ) as Record<K, string>;
const editorColors = resolved(EDITOR_COLOR_TOKENS);

/** Tokens the editor's own vs and vs-dark rules give a color (monaco-editor's themes.js). */
const monacoRoot = realpathSync(
  join(import.meta.dirname, '..', '..', '..', 'node_modules', 'monaco-editor'),
);
const baseTokens = [
  ...readFileSync(join(monacoRoot, 'esm/vs/editor/standalone/common/themes.js'), 'utf8').matchAll(
    /\{ token: '([^']*)', foreground: '/g,
  ),
].map((match) => match[1] as string);

describe('editor (Monaco) theme', () => {
  it('keeps today’s theme under system, light and dark: no rules, the same ten colors', () => {
    for (const dark of [false, true])
      expect(editorThemeData(editorColors, null, dark)).toEqual({
        base: dark ? 'vs-dark' : 'vs',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': editorColors.surface,
          'editor.foreground': editorColors.text,
          'editorLineNumber.foreground': editorColors['muted-foreground'],
          'editorLineNumber.activeForeground': editorColors.text,
          'editorCursor.foreground': editorColors.primary,
          'editorWidget.background': editorColors.raised,
          'editorWidget.border': editorColors.line,
          'editorError.foreground': editorColors.danger,
          'editorWarning.foreground': editorColors.warning,
          focusBorder: editorColors['focus-ring'],
        },
      });
  });

  it('colors code with the theme’s eight syntax colors and its selection under a named theme', () => {
    const data = editorThemeData(editorColors, monokai, true);
    const rule = (token: string) => data.rules.find((each) => each.token === token)?.foreground;
    const bare = (hex: string) => hex.slice(1);
    expect(rule('comment')).toBe(bare(monokai.syntax.comment));
    expect(rule('keyword')).toBe(bare(monokai.syntax.keyword));
    expect(rule('string')).toBe(bare(monokai.syntax.string));
    expect(rule('number')).toBe(bare(monokai.syntax.number));
    expect(rule('type')).toBe(bare(monokai.syntax.type));
    expect(rule('variable')).toBe(bare(monokai.syntax.variable));
    expect(rule('constant')).toBe(bare(monokai.syntax.constant));
    expect(rule('annotation')).toBe(bare(monokai.syntax.function));
    expect(rule('')).toBe(bare(monokai.ui.foreground));
    expect(data.colors['editor.selectionBackground']).toBe(monokai.ui.selection);
    expect(data.base).toBe('vs-dark');
  });

  it('overrides every token the built-in rules color, so none of their colors shows through', () => {
    expect(baseTokens.length).toBeGreaterThan(40);
    const data = editorThemeData(editorColors, monokai, true);
    const covered = new Set(data.rules.filter((each) => each.foreground).map((each) => each.token));
    expect(baseTokens.filter((token) => !covered.has(token))).toEqual([]);
    const theme = new Set(
      [...Object.values(monokai.syntax), ...Object.values(monokai.ui)].map((hex) => hex.slice(1)),
    );
    for (const each of data.rules) if (each.foreground) expect(theme).toContain(each.foreground);
  });
});

describe('terminal (xterm) theme', () => {
  const colors = resolved(TERMINAL_COLOR_TOKENS);

  it('keeps today’s four colors and xterm’s own sixteen under system, light and dark', () => {
    expect(terminalTheme(colors, null)).toEqual({
      background: colors.surface,
      foreground: colors.text,
      cursor: colors.primary,
      cursorAccent: colors.surface,
    });
  });

  it('sets the sixteen ANSI colors and the selection from a named theme', () => {
    const theme = terminalTheme(colors, monokai);
    expect([
      theme.black,
      theme.red,
      theme.green,
      theme.yellow,
      theme.blue,
      theme.magenta,
      theme.cyan,
      theme.white,
      theme.brightBlack,
      theme.brightRed,
      theme.brightGreen,
      theme.brightYellow,
      theme.brightBlue,
      theme.brightMagenta,
      theme.brightCyan,
      theme.brightWhite,
    ]).toEqual(monokai.terminal);
    expect(theme.selectionBackground).toBe(monokai.ui.selection);
    expect(theme.background).toBe(colors.surface);
    expect(theme.foreground).toBe(colors.text);
    expect(theme.cursor).toBe(colors.primary);
  });
});

describe('diff and source view theme', () => {
  it('keeps GitHub light and dark without a named theme', () => {
    expect(DEFAULT_DIFF_THEMES).toEqual({ dark: 'github-dark', light: 'github-light' });
    expect(diffThemes(null)).toBe(DEFAULT_DIFF_THEMES);
    expect(diffThemes(monokai)).toBe(NAMED_DIFF_THEMES);
  });

  it('reads every syntax color from the root tokens, so a change needs no new highlight', () => {
    for (const type of ['light', 'dark'] as const) {
      const theme = diffThemeRegistration(type);
      expect(theme.name).toBe(NAMED_DIFF_THEMES[type]);
      expect(theme.type).toBe(type);
      const painted = (scope: string) =>
        theme.tokenColors?.find((rule) =>
          (Array.isArray(rule.scope) ? rule.scope : [rule.scope]).includes(scope),
        )?.settings?.foreground;
      for (const [key, scope] of [
        ['comment', 'comment'],
        ['keyword', 'keyword'],
        ['string', 'string'],
        ['number', 'constant.numeric'],
        ['function', 'entity.name.function'],
        ['type', 'entity.name.type'],
        ['variable', 'variable'],
        ['constant', 'constant.language'],
      ])
        expect(painted(scope as string), key).toBe(`var(--syntax-${key})`);
      expect(theme.colors?.['editor.foreground']).toBe('var(--foreground)');
      expect(theme.colors?.['gitDecoration.addedResourceForeground']).toBe('var(--success)');
      expect(theme.colors?.['gitDecoration.deletedResourceForeground']).toBe('var(--destructive)');
      // Only token references: no color is written into the highlighted code itself.
      expect(JSON.stringify(theme)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });
});
