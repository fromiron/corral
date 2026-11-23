// No new effect hooks: every file's count of useEffect, useLayoutEffect and useInsertionEffect
// calls is held in effects.baseline.json, and the ratchet fails when one rises.

import ts from 'typescript';
import type { Rule } from './ratchet.ts';

const HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);

/** The local names a hook can be called by: its own, an import alias, or a const set from one. */
function hookNames(source: ts.SourceFile) {
  const names = new Set(HOOKS);
  const namespaces = new Set(['React']);
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (node.moduleSpecifier.text === 'react' && clause) {
        if (clause.name) namespaces.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings))
          for (const element of bindings.elements)
            if (HOOKS.has((element.propertyName ?? element.name).text))
              names.add(element.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const refersToHook = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return names.has(node.text);
    if (ts.isPropertyAccessExpression(node))
      return (
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        HOOKS.has(node.name.text)
      );
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return refersToHook(node.expression);
    if (ts.isConditionalExpression(node))
      return refersToHook(node.whenTrue) || refersToHook(node.whenFalse);
    if (ts.isBinaryExpression(node)) return refersToHook(node.left) || refersToHook(node.right);
    return false;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const declaration of declarations) {
      const name = (declaration.name as ts.Identifier).text;
      if (!names.has(name) && refersToHook(declaration.initializer as ts.Expression)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return { names, namespaces };
}

export function countEffects(path: string, text: string): number {
  if (!/\b(useEffect|useLayoutEffect|useInsertionEffect)\b/.test(text)) return 0;
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const { names, namespaces } = hookNames(source);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && names.has(callee.text)) count++;
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text) &&
        HOOKS.has(callee.name.text)
      )
        count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

const instead =
  'Derive the value during render, do the work in the event handler that causes it, or key the component instead.';
const hooks = (count: number) => `${count} effect hook${count === 1 ? '' : 's'}`;

export const effects: Rule = {
  name: 'effects',
  baseline: 'tools/lint/effects.baseline.json',
  groups: [
    { name: 'design-kit', root: 'packages/react/src/design-kit' },
    { name: 'react', root: 'packages/react/src' },
    { name: 'studio', root: 'apps/studio/src' },
  ],
  includes: (path) =>
    /\.tsx?$/.test(path) &&
    !path.endsWith('.d.ts') &&
    !/\.test\.tsx?$/.test(path) &&
    !path.split('/').includes('test'),
  count: countEffects,
  messages: {
    rose: (path, count, allowed) =>
      `${path}: ${hooks(count)}, the baseline has ${allowed}. ${instead} If an effect is truly needed, raise this file's count by hand in tools/lint/effects.baseline.json in the same change.`,
    added: (path, count) =>
      `${path}: ${hooks(count)} and no entry in the baseline. ${instead} If an effect is truly needed, add this file with its count by hand to tools/lint/effects.baseline.json in the same change.`,
  },
};
