import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cn } from '@corral/react/ui';
import { describe, expect, it } from 'vitest';

// Workbench polish P0 guard (docs/plans/Workbench-Polish-Plan.md §3 P0, §7): one type scale,
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

/** CSS variables that base-ui, Tailwind, @pierre/diffs or a caller's style set at run time. */
const runtime =
  /^--(diffs-|label$|anchor-|popup-|available-|transform-origin|nested-dialogs|scroll-area-|positioner-|collapsible-|accordion-|tw-|spacing|radius-|color-(black|white)|tab-|active-tab-|indicator-|text-|font-|shadow-|default-|z-)/;

describe('design guard (Workbench polish P0)', () => {
  it('uses only the named type scale, never a pixel or rem font size', () => {
    const found = [...text].flatMap(([path, body]) =>
      [...body.matchAll(/\btext-\[[0-9.]+(?:px|rem)\]/g)].map((m) => `${where(path)}: ${m[0]}`),
    );
    expect(found).toEqual([]);
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
    const theme = readFileSync(join(root, 'packages/react/src/theme.css'), 'utf8');
    const missing = [...text].flatMap(([path, body]) =>
      [
        ...body.matchAll(
          /\b(?:bg|text|border)-((?:warning|destructive|success|danger|subtle)-[a-z]+)\b/g,
        ),
      ]
        .map((m) => m[1] as string)
        .filter((name) => !theme.includes(`--color-${name}:`))
        .map((name) => `${where(path)}: ${name}`),
    );
    expect([...new Set(missing)]).toEqual([]);
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

  it('merges the extra type steps as font sizes, not colors', () => {
    expect(cn('text-ui text-muted')).toBe('text-ui text-muted');
    expect(cn('text-xs text-ui')).toBe('text-ui');
  });
});
