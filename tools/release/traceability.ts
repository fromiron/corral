import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractTcTags } from '../spec-check/tc-tags.ts';
import { ROOT } from './candidate.ts';

export function checkReleaseTraceability(): void {
  const ids = (
    JSON.parse(readFileSync(join(ROOT, 'tests/test-catalog.json'), 'utf8')) as { id: string }[]
  ).map((test) => test.id);
  const tags = new Set<string>();
  function readTests(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (
        [
          'node_modules',
          'dist',
          'dist-performance',
          'test-results',
          'storybook-static',
          '.vite',
        ].includes(entry.name)
      )
        continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) readTests(file);
      else if (/\.(test|spec|stories)\.tsx?$/.test(file) || /\/testing\/[^/]+\.tsx?$/.test(file)) {
        for (const tag of extractTcTags(readFileSync(file, 'utf8'))) tags.add(tag);
      }
    }
  }
  for (const path of ['apps', 'packages', 'tests', 'tools/release']) readTests(join(ROOT, path));
  const missing = ids.filter((id) => !tags.has(id));
  if (missing.length)
    throw new Error(`Scenarios without executable test tags: ${missing.join(', ')}`);
  console.log(
    `Release traceability: ${ids.length}/${ids.length} scenarios have executable test tags`,
  );
}
if (import.meta.main) checkReleaseTraceability();
