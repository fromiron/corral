import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from './builtin.ts';
import { contrastRatio } from './color.ts';
import { checkPalette, parseTheme, serializeTheme } from './json.ts';
import { paletteTokens } from './tokens.ts';

const root = join(import.meta.dirname, '..', '..', '..', '..', '..');

/**
 * The installed source palettes, reached through the studio's own dependency chain
 * (@pierre/diffs → shiki → @shikijs/themes) instead of a new dependency.
 */
const pierre = realpathSync(join(root, 'apps/studio/node_modules/@pierre/diffs/package.json'));
const shiki = createRequire(pierre).resolve('shiki');
const themes = createRequire(shiki);
const themesPackage = JSON.parse(
  readFileSync(
    join(dirname(themes.resolve('@shikijs/themes/monokai')), '..', 'package.json'),
    'utf8',
  ),
) as { version: string };

interface SourceTheme {
  colors: Record<string, string>;
  tokenColors: { scope?: string | string[]; settings?: { foreground?: string } }[];
}
async function source(name: string): Promise<SourceTheme> {
  return (
    await import(/* @vite-ignore */ pathToFileURL(themes.resolve(`@shikijs/themes/${name}`)).href)
  ).default as SourceTheme;
}

/**
 * The TextMate scope each syntax color is read from (THIRD-PARTY-NOTICES/themes.md): the
 * foreground of the rule whose plain selector is the longest dotted prefix of the scope (the
 * later rule on a tie), or the editor foreground when no rule matches.
 */
const SCOPES = {
  comment: 'comment.line.double-slash',
  keyword: 'keyword.control',
  string: 'string.quoted.double',
  number: 'constant.numeric',
  function: 'entity.name.function',
  type: 'entity.name.type.class',
  variable: 'variable.other.readwrite',
  constant: 'constant.language',
} as const;
function painted(theme: SourceTheme, scope: string): string {
  let best: { depth: number; color: string } | null = null;
  for (const rule of theme.tokenColors) {
    const color = rule.settings?.foreground;
    if (!rule.scope || !color) continue;
    for (const selector of (Array.isArray(rule.scope) ? rule.scope : rule.scope.split(',')).map(
      (part) => part.trim(),
    )) {
      if (!selector || /\s/.test(selector)) continue;
      if (scope !== selector && !scope.startsWith(`${selector}.`)) continue;
      const depth = selector.split('.').length;
      if (!best || depth >= best.depth) best = { depth, color };
    }
  }
  return (best?.color ?? (theme.colors['editor.foreground'] as string)).toLowerCase();
}
const ANSI = [
  'Black',
  'Red',
  'Green',
  'Yellow',
  'Blue',
  'Magenta',
  'Cyan',
  'White',
  'BrightBlack',
  'BrightRed',
  'BrightGreen',
  'BrightYellow',
  'BrightBlue',
  'BrightMagenta',
  'BrightCyan',
  'BrightWhite',
];

const notice = readFileSync(join(root, 'THIRD-PARTY-NOTICES/themes.md'), 'utf8');

describe('built-in themes', () => {
  it('ships six to nine distinct, valid themes', () => {
    expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(6);
    expect(BUILTIN_THEMES.length).toBeLessThanOrEqual(9);
    expect(new Set(BUILTIN_THEMES.map((theme) => theme.id)).size).toBe(BUILTIN_THEMES.length);
    expect(new Set(BUILTIN_THEMES.map((theme) => theme.palette.name)).size).toBe(
      BUILTIN_THEMES.length,
    );
    for (const theme of BUILTIN_THEMES) {
      expect(theme.id).toMatch(/^[a-z0-9-]+$/);
      expect(checkPalette(theme.palette)).toEqual({ ok: true, palette: theme.palette });
    }
  });

  it('reads its source palettes from @shikijs/themes 4.5.0', () => {
    expect(themesPackage.version).toBe('4.5.0');
  });

  describe.each(BUILTIN_THEMES.map((theme) => [theme.palette.name, theme] as const))(
    '%s',
    (_name, theme) => {
      const tokens = paletteTokens(theme.palette);
      // Text sits on the floor up to the step dialogs and menus use.
      const surfaces = [1, 2, 3, 4, 5].map((step) => tokens[`--surface-${step}`] as string);

      it.each(['foreground', 'muted', 'emphasis', 'error', 'success', 'warning', 'info'] as const)(
        'keeps %s at 4.5:1 or more on surfaces 1 to 5',
        (key) => {
          for (const surface of surfaces)
            expect(contrastRatio(theme.palette.ui[key], surface)).toBeGreaterThanOrEqual(4.5);
        },
      );

      it('keeps text at 4.5:1 on the selected row and the focus ring at 3:1 on the floor', () => {
        expect(
          contrastRatio(tokens['--foreground'] as string, tokens['--selected'] as string),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(tokens['--focus-ring'] as string, tokens['--surface-1'] as string),
        ).toBeGreaterThanOrEqual(3);
      });

      it.each(['--accent', '--tint', '--tint-hover'])(
        'keeps text at 4.5:1 on the %s fill of buttons and rows',
        (fill) => {
          expect(
            contrastRatio(tokens['--foreground'] as string, tokens[fill] as string),
          ).toBeGreaterThanOrEqual(4.5);
        },
      );

      it('takes syntax and terminal colors unchanged from its source file', async () => {
        const original = await source(theme.source);
        for (const [key, scope] of Object.entries(SCOPES))
          expect(theme.palette.syntax[key as keyof typeof SCOPES], key).toBe(
            painted(original, scope),
          );
        expect(theme.palette.terminal).toEqual(
          ANSI.map((name) => original.colors[`terminal.ansi${name}`]?.toLowerCase()),
        );
      });

      it('is recorded in the theme notice', () => {
        expect(notice).toContain(`\`builtin:${theme.id}\``);
        expect(notice).toContain(`\`${theme.source}.mjs\``);
      });

      it('computes the same tokens once saved as a personal theme with the same values', () => {
        const copied = parseTheme(serializeTheme(theme.palette));
        if (!copied.ok) throw new Error(copied.error);
        expect(paletteTokens(copied.palette)).toEqual(tokens);
      });
    },
  );
});
