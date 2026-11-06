import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { cn } from '@corral/react/design-kit';
import { describe, expect, it } from 'vitest';

// Workbench polish guard: one type scale,
// no references to tokens nobody defines, and one control vocabulary on the workbench.

const root = join(import.meta.dirname, '..', '..', '..');
const sources = [join(root, 'apps/studio/src'), join(root, 'packages/react/src')];

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(path, ext);
    return ext.test(entry.name) && !/\.(test|stories)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const code = sources.flatMap((dir) => files(dir, /\.(tsx?|css)$/));
const text = new Map(code.map((path) => [path, readFileSync(path, 'utf8')]));
const where = (path: string) => relative(root, path);

function unnamedTypeSizes(path: string, source: string): string[] {
  // The copied kit's editable-field role prevents iOS focus zoom on touch screens.
  // Only this exact shared declaration is exempt; local pixel sizes still fail.
  const body =
    where(path) === 'packages/react/src/design-kit/lib/type-scale.ts'
      ? source.replace(/^const fieldTouchClass = 'pointer-coarse:text-\[16px\]';$/m, '')
      : source;
  return [...body.matchAll(/\btext-\[[0-9.]+(?:px|rem)\]/g)].map((match) => match[0]);
}

function themeColorTokens(
  entry: string,
  readSource: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Set<string> {
  const visited = new Set<string>();
  const tokens = new Set<string>();
  const visit = (path: string) => {
    const absolute = resolve(path);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const css = readSource(absolute).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) tokens.add(match[1] as string);
    for (const match of css.matchAll(/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?/g)) {
      const specifier = match[2] as string;
      // Follow the theme's local imports, not unrelated CSS files in the source tree.
      if (specifier.startsWith('.')) visit(resolve(dirname(absolute), specifier));
    }
  };
  visit(entry);
  return tokens;
}

/** CSS variables that base-ui, Tailwind, @pierre/diffs or a caller's style set at run time. */
const runtime =
  /^--(diffs-|label$|anchor-|popup-|available-|transform-origin|nested-dialogs|scroll-area-|positioner-|collapsible-|accordion-|tw-|spacing|radius-|color-(black|white)|tab-|active-tab-|indicator-|text-|font-|shadow-|default-|z-)/;

describe('design guard (Workbench polish P0)', () => {
  it('uses the named type scale apart from the shared touch-field role', () => {
    const found = [...text].flatMap(([path, body]) =>
      unnamedTypeSizes(path, body).map((size) => `${where(path)}: ${size}`),
    );
    expect(found).toEqual([]);
  });

  it('does not extend the touch-field exception to local or other pixel sizes', () => {
    const shared = join(root, 'packages/react/src/design-kit/lib/type-scale.ts');
    const touchRole = "const fieldTouchClass = 'pointer-coarse:text-[16px]';";
    expect(unnamedTypeSizes(shared, touchRole)).toEqual([]);
    expect(unnamedTypeSizes(join(root, 'apps/studio/src/Local.tsx'), touchRole)).toEqual([
      'text-[16px]',
    ]);
    expect(
      unnamedTypeSizes(shared, `${touchRole}\nconst local = 'text-[16px] text-[1rem]';`),
    ).toEqual(['text-[16px]', 'text-[1rem]']);
    expect(unnamedTypeSizes(shared, touchRole.replace('16px', '15px'))).toEqual(['text-[15px]']);
    expect(unnamedTypeSizes(shared, touchRole.replace('pointer-coarse:', ''))).toEqual([
      'text-[16px]',
    ]);
  });

  it('defines every CSS variable it reads', () => {
    const defined = new Set<string>();
    for (const body of text.values())
      for (const m of body.matchAll(/(?:^|[\s[{;'"(])(--[a-z0-9-]+)\s*[:'"]/g))
        defined.add(m[1] as string);
    const missing = [...text].flatMap(([path, body]) =>
      // A reference with a fallback (`var(--x,y)`) is defined by its fallback.
      [...body.matchAll(/var\((--[a-z0-9-]+)\)/g)]
        .map((m) => m[1] as string)
        .filter((name) => !defined.has(name) && !runtime.test(name))
        .map((name) => `${where(path)}: ${name}`),
    );
    expect([...new Set(missing)]).toEqual([]);
  });

  it('has a color token for every semantic color utility', () => {
    const tokens = themeColorTokens(join(root, 'packages/react/src/theme.css'));
    const missing = [...text].flatMap(([path, body]) =>
      [
        ...body.matchAll(
          /\b(?:bg|text|border)-((?:warning|destructive|success|danger|subtle)-[a-z]+)\b/g,
        ),
      ]
        .map((m) => m[1] as string)
        .filter((name) => !tokens.has(name))
        .map((name) => `${where(path)}: ${name}`),
    );
    expect([...new Set(missing)]).toEqual([]);
  });

  it('counts only color declarations reachable through the theme import graph', () => {
    const fixture = join(root, 'theme-fixture');
    const sources = new Map([
      [
        join(fixture, 'theme.css'),
        '@import "./kit/tokens.css"; @theme { --color-warning-surface: gold; }',
      ],
      [
        join(fixture, 'kit/tokens.css'),
        '@import url("../shared.css"); @theme { --color-destructive-light: pink; }',
      ],
      [
        join(fixture, 'shared.css'),
        '@import "./theme.css"; /* @import "./unused.css"; --color-danger-fake: red; */',
      ],
      [join(fixture, 'unused.css'), '@theme { --color-danger-missing: red; }'],
    ]);
    const tokens = themeColorTokens(join(fixture, 'theme.css'), (path) => {
      const source = sources.get(path);
      if (source === undefined) throw new Error(`Unexpected CSS import: ${path}`);
      return source;
    });
    expect([...tokens].sort()).toEqual(['destructive-light', 'warning-surface']);
    expect(tokens.has('danger-missing')).toBe(false);
    expect(tokens.has('danger-fake')).toBe(false);
  });

  it('keeps the brand accent off neutral hover and highlight states in shared controls', () => {
    const ui = files(join(root, 'packages/react/src/ui'), /\.tsx$/);
    const found = ui.flatMap((path) =>
      [
        ...readFileSync(path, 'utf8').matchAll(
          /(?:hover|highlighted|pressed)[^\s'"]*:bg-accent\b|text-accent-foreground/g,
        ),
      ].map((m) => `${where(path)}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  it('uses one select on the workbench screens, never a native one', () => {
    const workbench = [
      ...files(join(root, 'apps/studio/src/workbench'), /\.tsx$/),
      join(root, 'apps/studio/src/pages/SessionPage.tsx'),
      join(root, 'apps/studio/src/pages/RootLayout.tsx'),
      join(root, 'apps/studio/src/pages/Workbench.tsx'),
    ];
    const found = workbench.flatMap((path) =>
      (readFileSync(path, 'utf8').match(/<select\b/g) ?? []).map(() => where(path)),
    );
    expect(found).toEqual([]);
  });

  it('builds text fields and toggles from the kit, never a native input with local styling', () => {
    // The request composer and the command palette own their editing surface and caret behavior;
    // schema question choices keep native fieldset, name/value and option descriptions (DESIGN.md).
    const own = /(ComposerInput|RequestInput|CommandPalette|InteractionPanel)\.tsx$/;
    const found = [...text].flatMap(([path, body]) =>
      own.test(path) || path.includes('design-kit')
        ? []
        : [...body.matchAll(/<(input|textarea)\b((?:[^>{]|\{[^}]*\})*)>/g)]
            .filter((m) => !/type="(?:radio|file|hidden)"/.test(m[2] as string))
            .map((m) => `${where(path)}: <${m[1]}>`),
    );
    expect(found).toEqual([]);
    const local = [...text].flatMap(([path, body]) =>
      /\bsettings-field\b/.test(body) ? [where(path)] : [],
    );
    expect(local).toEqual([]);
  });

  it('shows status messages with the kit Banner, never a hand-tinted warning box', () => {
    const found = [...text].flatMap(([path, body]) =>
      path.includes('design-kit')
        ? []
        : // The banner tint; approval cards and graph nodes keep their own (DESIGN.md exceptions).
          [...body.matchAll(/\bbg-warning\/10\b/g)].map((m) => `${where(path)}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  it('merges the extra type steps as font sizes, not colors', () => {
    expect(cn('text-ui text-muted')).toBe('text-ui text-muted');
    expect(cn('text-xs text-ui')).toBe('text-ui');
  });
});
