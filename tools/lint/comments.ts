// Comment lines per file are held in comments.baseline.json, and the ratchet fails when one
// rises. Tool directives and licence headers are never counted. Any other comment counts every
// line it touches, so a line of code with a trailing comment is a comment line.

import ts from 'typescript';
import type { Group, Rule } from './ratchet.ts';

export interface CommentLines {
  directive: number;
  licence: number;
  /** A JSDoc block that is the last comment before an exported top-level declaration. */
  jsdocExport: number;
  /** A comment alone inside JSX braces. */
  jsx: number;
  other: number;
}

type Kind = keyof CommentLines;

const DIRECTIVE =
  /^(biome-ignore|@ts-(expect-error|ignore|nocheck|check)\b|@(vitest|jest)-environment|@jsx(ImportSource|Runtime|Frag)?\b|@vite-ignore|webpack[A-Z]|[@#]__(PURE|NO_SIDE_EFFECTS)__|(istanbul|c8|v8)\s+ignore|eslint-(disable|enable)|prettier-ignore|@refresh\b)/;
export const LICENCE_MARKERS = /SPDX-License-Identifier|\bCopyright\b|©|@license\b/i;

function body(text: string): string {
  return text
    .replace(/^\/\/+|^\/\*+|\*+\/$/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, ''))
    .join('\n')
    .trim();
}

function isDirective(text: string): boolean {
  return /^\/\/\/\s*</.test(text) || DIRECTIVE.test(body(text));
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

const exported = (statement: ts.Statement) =>
  ts.isExportAssignment(statement) ||
  ts.isExportDeclaration(statement) ||
  (ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword));

export function classifyComments(path: string, text: string): CommentLines {
  const lines: CommentLines = { directive: 0, licence: 0, jsdocExport: 0, jsx: 0, other: 0 };
  if (!text.includes('//') && !text.includes('/*')) return lines;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
  const ranges = new Map<number, ts.CommentRange>();
  const jsxBraces: [number, number][] = [];
  // JSX text such as <code>// x</code> reads as a comment to the trivia scanner; it is text.
  const jsxText: [number, number][] = [];
  const add = (found: ts.CommentRange[] | undefined) => {
    for (const range of found ?? []) ranges.set(range.pos, range);
  };
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    if (ts.isJsxExpression(node) && !node.expression) jsxBraces.push([node.pos, node.end]);
    if (ts.isJsxText(node)) {
      jsxText.push([node.pos, node.end]);
      return;
    }
    const children = node.getChildren(source);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
  };
  visit(source);

  const kinds = new Map<number, Kind>();
  const first = source.statements[0];
  const leading = ts.getLeadingCommentRanges(text, 0) ?? [];
  const header = leading.filter((range) => !first || range.end <= first.getStart(source));
  // Leading comments split into blocks at blank lines; a block with a licence marker is a header.
  let block: ts.CommentRange[] = [];
  const closeBlock = () => {
    if (block.some((range) => LICENCE_MARKERS.test(text.slice(range.pos, range.end))))
      for (const range of block) kinds.set(range.pos, 'licence');
    block = [];
  };
  for (const range of header) {
    const previous = block.at(-1);
    if (previous && /\n\s*\n/.test(text.slice(previous.end, range.pos))) closeBlock();
    block.push(range);
  }
  closeBlock();
  for (const statement of source.statements) {
    if (!exported(statement)) continue;
    const last = (ts.getLeadingCommentRanges(text, statement.pos) ?? []).at(-1);
    if (last && text.startsWith('/**', last.pos) && !kinds.has(last.pos))
      kinds.set(last.pos, 'jsdocExport');
  }

  const counted = new Map<number, Kind>();
  const excluded = new Map<number, Kind>();
  for (const range of ranges.values()) {
    if (jsxText.some(([start, end]) => range.pos >= start && range.pos < end)) continue;
    const comment = text.slice(range.pos, range.end);
    let kind = kinds.get(range.pos) ?? 'other';
    if (kind !== 'licence' && isDirective(comment)) kind = 'directive';
    if (
      kind === 'other' &&
      jsxBraces.some(([start, end]) => range.pos >= start && range.end <= end)
    )
      kind = 'jsx';
    const from = source.getLineAndCharacterOfPosition(range.pos).line;
    const to = source.getLineAndCharacterOfPosition(range.end).line;
    for (let line = from; line <= to; line++) {
      const target = kind === 'directive' || kind === 'licence' ? excluded : counted;
      if (!target.has(line) || kind === 'jsx') target.set(line, kind);
    }
  }
  for (const kind of counted.values()) lines[kind]++;
  for (const [line, kind] of excluded) if (!counted.has(line)) lines[kind]++;
  return lines;
}

export function countComments(path: string, text: string): number {
  const lines = classifyComments(path, text);
  return lines.jsdocExport + lines.jsx + lines.other;
}

const PACKAGES = [
  'adapter-pi',
  'cli',
  'client',
  'contracts',
  'core',
  'local-intelligence',
  'runner-langgraph',
  'storage-sqlite',
  'testkit',
];

export const COMMENT_GROUPS: Group[] = [
  ...['desktop', 'server', 'studio'].map((name) => ({ name, root: `apps/${name}` })),
  { name: 'design-kit', root: 'packages/react/src/design-kit' },
  { name: 'react', root: 'packages/react' },
  ...PACKAGES.map((name) => ({ name, root: `packages/${name}` })),
];

/** Generated code, the built-in resources and code ported under a NOTICE. packages/pi-runtime-port
 * has no group at all: the whole package is ported under its NOTICE. */
const LEFT_OUT = [
  'packages/core/src/generated/',
  'packages/contracts/generated/',
  'apps/server/resources/builtin/',
  'packages/adapter-pi/src/ported/dsh/',
  'packages/adapter-pi/src/ported/thinking-loop.ts',
];

export function isCountedSource(path: string): boolean {
  const parts = path.split('/');
  return (
    /\.[cm]?[jt]sx?$/.test(path) &&
    !path.endsWith('.d.ts') &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) &&
    !parts.includes('test') &&
    !parts.includes('e2e') &&
    !LEFT_OUT.some((prefix) => path.startsWith(prefix))
  );
}

const lines = (count: number) => `${count} comment line${count === 1 ? '' : 's'}`;
const instead =
  'Delete the comment and let names, types and tests carry it. If it says what the code cannot (a constraint from outside, a reason that would otherwise be lost),';
const counting =
  '(Every line a comment touches counts, trailing comments and JSX comments included; tool directives and licence headers do not.)';

export const comments: Rule = {
  name: 'comments',
  baseline: 'tools/lint/comments.baseline.json',
  groups: COMMENT_GROUPS,
  includes: isCountedSource,
  count: countComments,
  messages: {
    rose: (path, count, allowed) =>
      `${path}: ${lines(count)}, the baseline has ${allowed}. ${instead} raise this file's count by hand in tools/lint/comments.baseline.json in the same change. ${counting}`,
    added: (path, count) =>
      `${path}: ${lines(count)} and no entry in the baseline. ${instead} add this file with its count by hand to tools/lint/comments.baseline.json in the same change. ${counting}`,
  },
};
