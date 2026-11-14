import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

// Feature previews never reach the server (docs/specs/features/feature-preview.md): their code
// does not import the services, the client or a transport, and calls no network API. Their store
// is read only by the previews, so badges, the inbox and notifications cannot count sample values.

const studio = join(import.meta.dirname, '..');
const previewDir = join(studio, 'feature-preview');
const page = join(studio, 'pages', 'PreviewPage.tsx');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function specifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
  ].map((match) => match[1] as string);
}

const forbiddenImport = /services|@corral\/client|transport/i;
const forbiddenCall = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/;

it('has one fixture, one store and the preview screens in their own folder', () => {
  const files = sources(previewDir).map((path) => relative(previewDir, path));
  expect(files).toContain('fixture.ts');
  expect(files).toContain('store.ts');
  expect(files.length).toBeGreaterThan(2);
});

it('imports no services, client or transport, and calls no network API', () => {
  const found = [...sources(previewDir), page].flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    return [
      ...specifiers(source)
        .filter((specifier) => forbiddenImport.test(specifier))
        .map((specifier) => `${relative(studio, path)} imports ${specifier}`),
      ...[...source.matchAll(new RegExp(forbiddenCall, 'g'))].map(
        (match) => `${relative(studio, path)} calls ${match[0]}`,
      ),
    ];
  });
  expect(found).toEqual([]);
});

it('catches each kind of forbidden reach in the checks themselves', () => {
  const bad = [
    "import { useServices } from '../services.tsx';",
    "import type { WorkspacePreview } from '@corral/client';",
    "const t = await import('../runtime/transport.ts');",
  ];
  for (const line of bad) expect(specifiers(line).some((s) => forbiddenImport.test(s))).toBe(true);
  for (const call of ['fetch(url)', 'new XMLHttpRequest()', 'new WebSocket(u)'])
    expect(forbiddenCall.test(call)).toBe(true);
  expect(specifiers("import { useNow } from '@corral/react/design-kit';")).toEqual([
    '@corral/react/design-kit',
  ]);
});

it('keeps the preview store away from every real screen, badge and count', () => {
  const readers = sources(studio).flatMap((path) => {
    if (path.startsWith(previewDir) || path === page) return [];
    const source = readFileSync(path, 'utf8');
    return specifiers(source).some((specifier) => /feature-preview\//.test(specifier))
      ? [relative(studio, path)]
      : [];
  });
  expect(readers).toEqual([]);
});
