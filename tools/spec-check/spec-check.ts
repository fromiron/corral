// pnpm spec:check — requirement/task/test traceability gate (C-051, CRL-DEV-003).
// 1. tools/validate_pack.py: IDs, references, acyclic backlog, traceability, schemas, Markdown links.
// 2. Every `[TC-…]` tag in a test file must name a scenario from tests/test-catalog.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { checkTcTags, extractTcTags, type TaggedFile } from './tc-tags.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SKIP = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'storybook-static',
  'test-results',
]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
// Reusable suites (e.g. the transport contract) live in src/testing/ and carry tags too.
const isSharedSuite = (path: string) => /[\\/]testing[\\/][^\\/]+\.tsx?$/.test(path);

function runPackValidator(): boolean {
  const python = process.env.CORRAL_PYTHON ?? 'python3';
  const outDir = mkdtempSync(join(tmpdir(), 'corral-spec-check-'));
  try {
    const result = spawnSync(
      python,
      ['-I', join(ROOT, 'tools/validate_pack.py'), '--report', join(outDir, 'report.json')],
      { encoding: 'utf-8' },
    );
    if (result.error) {
      console.error(`spec:check: cannot run ${python}: ${result.error.message}`);
      return false;
    }
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout);
      if (result.stderr.includes("No module named 'jsonschema'")) {
        console.error(
          'spec:check: install the validator dependency: pip install -r tools/requirements.txt',
        );
      }
      return false;
    }
    const summary = JSON.parse(result.stdout) as { checksPassed: number; result: string };
    console.log(`pack validation: ${summary.result} (${summary.checksPassed} checks)`);
    return summary.result === 'PASS';
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function findTestFiles(dir: string): string[] {
  const found: string[] = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTestFiles(path));
    else if (TEST_FILE.test(entry.name) || isSharedSuite(path)) found.push(path);
  }
  return found;
}

function checkTags(): boolean {
  const catalog = JSON.parse(readFileSync(join(ROOT, 'tests/test-catalog.json'), 'utf-8')) as {
    id: string;
  }[];
  // Product tests only; tools/ holds fixtures that look like tags on purpose.
  const roots = ['apps', 'packages', 'tests', 'tools/release'].map((dir) => join(ROOT, dir));
  const files: TaggedFile[] = roots.flatMap(findTestFiles).map((path) => ({
    file: relative(ROOT, path),
    tags: extractTcTags(readFileSync(path, 'utf-8')),
  }));
  const { errors, covered } = checkTcTags(files, new Set(catalog.map((t) => t.id)));
  for (const error of errors) console.error(error);
  console.log(
    `test scenario tags: ${covered.length}/${catalog.length} scenarios have tagged tests`,
  );
  return errors.length === 0;
}

const ok = [runPackValidator(), checkTags()].every(Boolean);
process.exit(ok ? 0 : 1);
