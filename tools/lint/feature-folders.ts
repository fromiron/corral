// Studio's feature folders stay closed: a file outside apps/studio/src/pages/<feature>/ imports
// only that folder's entry, and tests and stories may also import its fixtures. The rules are in
// docs/plans/studio-feature-folders.md (경계 규칙). Each file's count of crossing imports is held
// in feature-folders.baseline.json, and the ratchet fails when one rises.

import { posix } from 'node:path';
import ts from 'typescript';
import type { Rule } from './ratchet.ts';

const PAGES = 'apps/studio/src/pages/';
const SHELL_ENTRIES = /^(RootLayout|StartupFailure)(\.tsx?)?$/;
const PAGE_ENTRY = /^[A-Za-z0-9]+Page(\.tsx?)?$/;
const FIXTURE = /\.(fixture|story-fixture)(\.[cm]?[jt]sx?)?$/;
const TEST_OR_STORY = /\.(test|stories)\.[cm]?[jt]sx?$/;

interface Crossing {
  specifier: string;
  reason: string;
}

/** The module specifiers a file imports: static imports, re-exports, import() and import types. vi.mock and paths read as text are not among them. */
function specifiers(path: string, text: string): string[] {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const found: string[] = [];
  const literal = (node: ts.Node | undefined) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
      found.push(node.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      literal(node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      literal(node.argument.literal);
    else if (ts.isExternalModuleReference(node)) literal(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The feature folder a repository-relative path sits in, or null at the top of pages/ or outside it. */
function featureOf(path: string): { feature: string; inside: string[] } | null {
  if (!path.startsWith(PAGES)) return null;
  const [feature, ...inside] = path.slice(PAGES.length).split('/');
  if (!feature) return null;
  // A specifier without an extension that names a folder of pages/ points into that folder.
  if (inside.length === 0 && posix.extname(feature) !== '') return null;
  return { feature, inside };
}

function isEntry(feature: string, inside: string[]): boolean {
  if (inside.length !== 1) return false;
  return (feature === 'shell' ? SHELL_ENTRIES : PAGE_ENTRY).test(inside[0] as string);
}

export function crossings(path: string, text: string): Crossing[] {
  const importer = featureOf(path);
  const sharedImporter = path.startsWith(PAGES) && !importer;
  if (!path.startsWith(PAGES) && !text.includes('pages')) return [];
  const found: Crossing[] = [];
  for (const specifier of specifiers(path, text)) {
    if (!specifier.startsWith('.')) continue;
    const target = posix.normalize(
      posix.join(posix.dirname(path), specifier.replace(/[?#].*$/, '')),
    );
    const folder = featureOf(target);
    if (!folder || folder.feature === importer?.feature) continue;
    const name = `pages/${folder.feature}`;
    if (sharedImporter)
      found.push({
        specifier,
        reason: `a shared file at the top of pages/ does not import a feature folder; move what it needs to workbench/ or the top of pages/ instead`,
      });
    else if (isEntry(folder.feature, folder.inside)) continue;
    else if (FIXTURE.test(target)) {
      if (!TEST_OR_STORY.test(path))
        found.push({
          specifier,
          reason: `is a fixture of ${name}, and only tests and stories import a fixture`,
        });
    } else
      found.push({
        specifier,
        reason: `is not an entry of ${name}; import the folder's *Page.tsx entry and export what is needed from it`,
      });
  }
  return found;
}

export function countCrossings(path: string, text: string): number {
  return crossings(path, text).length;
}

const imports = (count: number) => `${count} import${count === 1 ? ' crosses' : 's cross'}`;
const instead =
  "Instead, import the folder's *Page.tsx entry and export what is needed from it; if two features need the part, move it to the workbench/ folder it belongs to. If the crossing must stay, raise this file's count by hand in tools/lint/feature-folders.baseline.json in the same change.";

export const featureFolders: Rule = {
  name: 'feature-folders',
  baseline: 'tools/lint/feature-folders.baseline.json',
  groups: [
    { name: 'studio', root: 'apps/studio' },
    { name: 'packages', root: 'packages' },
  ],
  includes: (path) => /\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('.d.ts'),
  count: countCrossings,
  details: (path, text) =>
    crossings(path, text).map(({ specifier, reason }) =>
      reason.startsWith('a shared') ? `'${specifier}': ${reason}` : `'${specifier}' ${reason}`,
    ),
  messages: {
    rose: (path, count, allowed) =>
      `${path}: ${imports(count)} a feature folder's boundary, the baseline has ${allowed}. ${instead}`,
    added: (path, count) =>
      `${path}: ${imports(count)} a feature folder's boundary and has no entry in the baseline. ${instead}`,
  },
};
