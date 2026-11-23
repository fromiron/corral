import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { countCrossings, featureFolders } from './feature-folders.ts';
import { run } from './ratchet.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'corral-feature-folders-'));
  roots.push(root);
  for (const [path, text] of Object.entries({
    ...files,
    [featureFolders.baseline]: `${JSON.stringify({ packages: {}, studio: {} }, null, 2)}\n`,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return run([featureFolders], { root });
}

const pages = 'apps/studio/src/pages';
const part = 'export const part = 1;\n';

test("an import of another feature folder's part fails and names it", () => {
  const result = check({
    [`${pages}/run/RunTabs.tsx`]: part,
    [`${pages}/session/SessionPage.tsx`]:
      "import { part } from '../run/RunTabs.tsx';\nexport { part };\n",
  });
  assert.equal(result.code, 1);
  assert.match(
    result.output,
    /apps\/studio\/src\/pages\/session\/SessionPage\.tsx: 1 import crosses/,
  );
  assert.match(result.output, /'\.\.\/run\/RunTabs\.tsx' is not an entry of pages\/run/);
  assert.match(
    result.output,
    /import the folder's \*Page\.tsx entry and export what is needed from it/,
  );
});

test('the same import from inside the folder passes', () => {
  const result = check({
    [`${pages}/run/RunTabs.tsx`]: part,
    [`${pages}/run/RunPage.tsx`]: "import { part } from './RunTabs.tsx';\nexport { part };\n",
  });
  assert.deepEqual(result, { code: 0, output: '' });
});

test('workbench may import an entry, including the two of shell, by import() or as a type', () => {
  const result = check({
    'apps/studio/src/workbench/session/SessionPanels.tsx': [
      "import { RunDetail } from '../../pages/run/RunPage.tsx';",
      "import type { Props } from '../../pages/shell/RootLayout.tsx';",
      "export const lazy = () => import('../../pages/shell/StartupFailure.tsx');",
      'export { RunDetail, type Props };',
    ].join('\n'),
  });
  assert.deepEqual(result, { code: 0, output: '' });
});

test('static imports, re-exports, import() and type-only imports of a part all count', () => {
  const source = [
    "import { a } from '../../pages/run/RunTabs.tsx';",
    "import type { B } from '../../pages/run/types.ts';",
    "export { c } from '../../pages/run/c.ts';",
    "export const d = () => import('../../pages/run/d.tsx');",
    "export type E = import('../../pages/run/e.ts').E;",
    "import { f } from '../../pages/run/RunPage.tsx';",
    "import { g } from '../Elsewhere.tsx';",
    "import { h } from 'react';",
    'export { a, type B, f, g, h };',
  ].join('\n');
  assert.equal(countCrossings('apps/studio/src/workbench/session/X.tsx', source), 5);
});

test("a test or a story may import another feature's fixture, other code may not", () => {
  const fixture =
    "import { f } from '../../pages/session/sessionShell.fixture.tsx';\nexport { f };\n";
  const story =
    "import { s } from '../../../../apps/studio/src/pages/inbox/InboxPage.story-fixture.tsx';\nexport { s };\n";
  assert.deepEqual(
    check({
      'apps/studio/src/workbench/browser/BrowserMenuDialogs.test.tsx': fixture,
      'packages/react/src/components/NeedsYouAdvice.stories.tsx': story,
    }),
    { code: 0, output: '' },
  );
  const result = check({ 'apps/studio/src/workbench/browser/BrowserMenuDialogs.tsx': fixture });
  assert.equal(result.code, 1);
  assert.match(result.output, /only tests and stories import a fixture/);
});

test('a vi.mock path and a path a test reads as text are not imports', () => {
  const source = [
    "import { readFileSync } from 'node:fs';",
    "vi.mock('../../pages/run/RunTabs.tsx', () => ({}));",
    "vi.importActual('../../pages/run/RunTabs.tsx');",
    "readFileSync(new URL('../../pages/run/RunTabs.tsx', import.meta.url), 'utf8');",
  ].join('\n');
  assert.equal(countCrossings('apps/studio/src/workbench/session/X.test.tsx', source), 0);
});

test('a shared file at the top of pages may not import a feature folder, even its entry', () => {
  const result = check({
    [`${pages}/Workbench.tsx`]:
      "import { RunDetail } from './run/RunPage.tsx';\nexport { RunDetail };\n",
  });
  assert.equal(result.code, 1);
  assert.match(
    result.output,
    /'\.\/run\/RunPage\.tsx': a shared file at the top of pages\/ does not import a feature folder/,
  );
});

test('a feature folder imports the shared files, workbench and packages freely', () => {
  assert.equal(
    countCrossings(
      `${pages}/run/RunPage.tsx`,
      "import '../Workbench.tsx';\nimport '../../workbench/RunRow.tsx';\nimport '@corral/react';\n",
    ),
    0,
  );
});
