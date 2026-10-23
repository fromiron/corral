import { expect, it } from 'vitest';
import { parseProblems } from './problems.ts';

it('[TC-WBD-011-H] reads tsc, vitest and path:line:col locations from check and task output', () => {
  const text = [
    'src/app.ts(12,5): error TS2322: Type string is not assignable to type number.',
    ' FAIL  test/sum.test.ts > adds',
    ' ❯ test/sum.test.ts:8:17',
    'src/util/format.ts:3:1: warning Unexpected console statement  no-console',
    'plain text without a location',
  ].join('\n');
  expect(parseProblems(text)).toEqual([
    {
      path: 'src/app.ts',
      line: 12,
      column: 5,
      severity: 'error',
      message: 'error TS2322: Type string is not assignable to type number.',
    },
    {
      path: 'test/sum.test.ts',
      line: 8,
      column: 17,
      severity: 'error',
      message: 'test/sum.test.ts:8:17',
    },
    {
      path: 'src/util/format.ts',
      line: 3,
      column: 1,
      severity: 'warning',
      message: 'warning Unexpected console statement  no-console',
    },
  ]);
});

it('[TC-WBD-011-N] keeps only locations inside the copy, once each', () => {
  const text = [
    '/etc/passwd:1:1: error not ours',
    '../outside/file.ts:2:3: error not ours',
    'node_modules/pkg/index.js:4:5: error a dependency',
    '.git/config:1:1: error internal',
    'src/a.ts:1:1: error first',
    'src/a.ts:1:1: error first',
  ].join('\n');
  expect(parseProblems(text).map((problem) => problem.path)).toEqual(['src/a.ts']);
});
