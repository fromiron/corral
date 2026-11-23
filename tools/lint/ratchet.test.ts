import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { countEffects, effects } from './effects.ts';
import { run, scan } from './ratchet.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>, baseline?: Record<string, Record<string, number>>) {
  const root = mkdtempSync(join(tmpdir(), 'corral-ratchet-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  if (baseline) write(root, effects.baseline, `${JSON.stringify(baseline, null, 2)}\n`);
  return root;
}

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function readBaseline(root: string) {
  return JSON.parse(readFileSync(join(root, effects.baseline), 'utf8'));
}

const one =
  "import { useEffect } from 'react';\nexport function A() {\n  useEffect(() => {}, []);\n}\n";
const two =
  "import { useEffect } from 'react';\nexport function A() {\n  useEffect(() => {}, []);\n  useEffect(() => {});\n}\n";
const page = 'apps/studio/src/pages/Page.tsx';

test('a file whose count rose fails and names the file', () => {
  const root = tree({ [page]: two }, { studio: { [page]: 1 } });
  const result = run([effects], { root });
  assert.equal(result.code, 1);
  assert.match(
    result.output,
    /apps\/studio\/src\/pages\/Page\.tsx: 2 effect hooks, the baseline has 1\./,
  );
  assert.match(result.output, /raise this file's count by hand/);
});

test('a file with an effect and no baseline entry fails', () => {
  const root = tree({ [page]: one }, {});
  const result = run([effects], { root });
  assert.equal(result.code, 1);
  assert.match(
    result.output,
    /apps\/studio\/src\/pages\/Page\.tsx: 1 effect hook and no entry in the baseline\./,
  );
});

test('a file whose count fell passes with one note for the rule', () => {
  const root = tree({ [page]: one }, { studio: { [page]: 2 } });
  const result = run([effects], { root });
  assert.equal(result.code, 0);
  assert.equal(
    result.output,
    'effects: 1 file is under the baseline; `pnpm lint:update` locks the gain in.',
  );
});

test('an entry whose file is gone passes with the note', () => {
  const root = tree(
    { [page]: one },
    { studio: { [page]: 2, 'apps/studio/src/A.tsx': 1, 'apps/studio/src/B.tsx': 1 } },
  );
  const result = run([effects], { root });
  assert.equal(result.code, 0);
  assert.equal(
    result.output,
    'effects: 1 file is under the baseline and 2 entries have no file; `pnpm lint:update` locks the gain in.',
  );
});

test('a file under its baseline may rise back to it, but not above it', () => {
  const root = tree({ [page]: one }, { studio: { [page]: 2 } });
  assert.equal(run([effects], { root }).code, 0);
  writeFileSync(join(root, page), two);
  assert.deepEqual(run([effects], { root }), { code: 0, output: '' });
  writeFileSync(join(root, page), two.replace('}\n', '  useEffect(() => {});\n}\n'));
  const result = run([effects], { root });
  assert.equal(result.code, 1);
  assert.match(result.output, /Page\.tsx: 3 effect hooks, the baseline has 2\./);
});

test('a tree that matches its baseline passes', () => {
  const root = tree(
    { [page]: two, 'packages/react/src/design-kit/ui/a.tsx': one },
    {
      'design-kit': { 'packages/react/src/design-kit/ui/a.tsx': 1 },
      studio: { [page]: 2 },
    },
  );
  assert.equal(run([effects], { root }).code, 0);
});

test('calls through React, an import alias or a const alias are counted', () => {
  const source = [
    "import * as R from 'react';",
    "import React, { useEffect, useLayoutEffect as useLE } from 'react';",
    "const useIso = typeof window !== 'undefined' ? useLayoutEffect : useEffect;",
    'export function A() {',
    '  R.useEffect(() => {});',
    '  React.useInsertionEffect(() => {});',
    '  useLE(() => {});',
    '  useIso(() => {});',
    '  useIso(() => {});',
    '  useEffect(() => {});',
    '}',
  ].join('\n');
  assert.equal(countEffects('a.tsx', source), 6);
  assert.equal(countEffects('a.ts', 'export const useEffect = 1;\nconsole.log(useEffect);\n'), 0);
});

test('test files are not counted', () => {
  const root = tree(
    {
      'apps/studio/src/pages/Page.test.tsx': two,
      'apps/studio/src/pages/Page.test.ts': two,
      'packages/react/src/test/helper.ts': two,
    },
    {},
  );
  assert.equal(run([effects], { root }).code, 0);
});

test('the design-kit is its own group and the rest of packages/react is another', () => {
  const root = tree({
    'packages/react/src/design-kit/a.tsx': one,
    'packages/react/src/b.tsx': one,
  });
  assert.deepEqual(scan(effects, root), {
    'design-kit': { 'packages/react/src/design-kit/a.tsx': 1 },
    react: { 'packages/react/src/b.tsx': 1 },
    studio: {},
  });
});

test('--update lowers the baseline to the tree as it is', () => {
  const root = tree({ [page]: one }, { studio: { [page]: 2, 'apps/studio/src/Gone.tsx': 1 } });
  const result = run([effects], { root, update: true });
  assert.equal(result.code, 0);
  assert.deepEqual(readBaseline(root).studio, { [page]: 1 });
  assert.equal(run([effects], { root }).code, 0);
});

test('--update refuses when a group total would rise and names the files that rose', () => {
  const baseline = { studio: { [page]: 1 } };
  const root = tree({ [page]: two, 'apps/studio/src/New.tsx': one }, baseline);
  const result = run([effects], { root, update: true });
  assert.equal(result.code, 1);
  assert.match(result.output, /the studio total would rise from 1 to 3/);
  assert.match(result.output, /apps\/studio\/src\/pages\/Page\.tsx: 1 → 2/);
  assert.match(result.output, /apps\/studio\/src\/New\.tsx: 0 → 1/);
  assert.deepEqual(readBaseline(root), baseline);
});

test('a move with the same group total passes after --update', () => {
  const moved = 'apps/studio/src/pages/runs/Page.tsx';
  const root = tree({ [moved]: two }, { studio: { [page]: 2 } });
  assert.equal(run([effects], { root }).code, 1);
  assert.equal(run([effects], { root, update: true }).code, 0);
  assert.deepEqual(readBaseline(root).studio, { [moved]: 2 });
  assert.equal(run([effects], { root }).code, 0);
});
