import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { classifyComments, comments, countComments } from './comments.ts';
import { run } from './ratchet.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>, baseline: Record<string, Record<string, number>>) {
  const root = mkdtempSync(join(tmpdir(), 'corral-comments-'));
  roots.push(root);
  for (const [path, text] of Object.entries({
    ...files,
    [comments.baseline]: `${JSON.stringify(baseline, null, 2)}\n`,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const file = 'packages/core/src/a.ts';
const plain = 'export const a = 1;\n';

test('a new plain comment fails and names the file', () => {
  const root = tree({ [file]: `// Says what the code says.\n${plain}` }, { core: {} });
  const result = run([comments], { root });
  assert.equal(result.code, 1);
  assert.match(
    result.output,
    /packages\/core\/src\/a\.ts: 1 comment line and no entry in the baseline\./,
  );
  assert.match(result.output, /Delete the comment and let names, types and tests carry it\./);
});

test('a comment that rose fails, and one that fell passes with the update note', () => {
  const two = `// One.\n// Two.\n${plain}`;
  const rose = run([comments], { root: tree({ [file]: two }, { core: { [file]: 1 } }) });
  assert.equal(rose.code, 1);
  assert.match(rose.output, /a\.ts: 2 comment lines, the baseline has 1\./);
  assert.match(
    rose.output,
    /raise this file's count by hand in tools\/lint\/comments\.baseline\.json/,
  );
  const fell = run([comments], { root: tree({ [file]: plain }, { core: { [file]: 2 } }) });
  assert.equal(fell.code, 0);
  assert.equal(
    fell.output,
    'comments: 1 file is under the baseline; `pnpm lint:update` locks the gain in.',
  );
});

test('tool directives and a licence header do not count', () => {
  const source = [
    '#!/usr/bin/env node',
    '// SPDX-License-Identifier: MIT',
    '// Copyright (c) 2024 Someone',
    '',
    '/// <reference types="vite/client" />',
    '// @vitest-environment jsdom',
    '// biome-ignore lint/suspicious/noExplicitAny: the upstream type is any',
    'export const a: any = 1;',
    '// @ts-expect-error the value is checked below',
    'export const b: number = "x";',
    "export const c = () => import(/* @vite-ignore */ 'x');",
    '/* istanbul ignore next */',
    'export const d = /* @__PURE__ */ Symbol();',
    '// c8 ignore next',
    'export const e = 1;',
  ].join('\n');
  assert.equal(countComments('a.ts', source), 0);
});

test('a licence marker counts only in the leading comments before the first statement', () => {
  const source = '// Heading.\nexport const a = 1;\n// Copyright is shown in the footer.\n';
  assert.equal(countComments('a.ts', source), 2);
  assert.equal(
    countComments('a.ts', '/**\n * @license MIT\n * Copyright Someone\n */\nexport const a = 1;\n'),
    0,
  );
});

test('a JSDoc block counts each of its lines', () => {
  const source = '/**\n * The answer.\n */\nexport const a = 42;\n';
  assert.equal(countComments('a.ts', source), 3);
  assert.deepEqual(classifyComments('a.ts', source), {
    directive: 0,
    licence: 0,
    jsdocExport: 3,
    jsx: 0,
    other: 0,
  });
});

test('a trailing comment and a JSX comment each count their line', () => {
  const source = [
    'export const a = 1; // why one',
    'export function B() {',
    '  return (',
    '    <div>',
    '      {/* the gap is the grid gap */}',
    "      <span>it's fine</span>",
    '    </div>',
    '  );',
    '}',
  ].join('\n');
  assert.equal(countComments('a.tsx', source), 2);
  assert.equal(classifyComments('a.tsx', source).jsx, 1);
});

test('JSX text that looks like a comment is not counted', () => {
  const source = [
    'export const A = () => (',
    '  <p>',
    '    <code>// x</code>',
    '    // not a comment',
    '    <code>/*.ts</code> and <code>*/</code>',
    '  </p>',
    ');',
  ].join('\n');
  assert.equal(countComments('a.tsx', source), 0);
});

test('test files, generated code, built-in resources and ported code are not counted', () => {
  const noisy = `// noise\n${plain}`;
  const root = tree(
    {
      'packages/core/src/a.test.ts': noisy,
      'packages/core/test/b.ts': noisy,
      'apps/studio/e2e/c.spec.ts': noisy,
      'packages/core/src/generated/d.ts': noisy,
      'apps/server/resources/builtin/e.ts': noisy,
      'packages/adapter-pi/src/ported/dsh/f.ts': noisy,
      'packages/pi-runtime-port/src/g.ts': noisy,
    },
    {},
  );
  assert.equal(run([comments], { root }).code, 0);
});

test('--update refuses a rise in a group total', () => {
  const baseline = { core: { [file]: 1 } };
  const root = tree({ [file]: `// One.\n// Two.\n${plain}` }, baseline);
  const result = run([comments], { root, update: true });
  assert.equal(result.code, 1);
  assert.match(result.output, /the core total would rise from 1 to 2/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, comments.baseline), 'utf8')), baseline);
});

test('the design-kit is its own group, apart from the rest of packages/react', () => {
  const noisy = `// noise\n${plain}`;
  const root = tree(
    { 'packages/react/src/design-kit/a.ts': noisy, 'packages/react/src/b.ts': noisy },
    {
      'design-kit': { 'packages/react/src/design-kit/a.ts': 1 },
      react: { 'packages/react/src/b.ts': 1 },
    },
  );
  assert.equal(run([comments], { root }).code, 0);
});
