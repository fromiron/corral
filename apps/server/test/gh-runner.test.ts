import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ghRunner } from '../src/pull-requests/gh.ts';

// docs/specs/features/pull-requests.md 계약: gh runs outside any repository with prompts off.

const dirs: string[] = [];
const path = process.env.PATH;
afterEach(() => {
  process.env.PATH = path;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-gh-'));
  dirs.push(dir);
  return dir;
};

function stub(script: string) {
  const bin = temp();
  const file = join(bin, 'gh');
  writeFileSync(file, `#!/bin/sh\nPATH=/usr/bin:/bin\n${script}\n`);
  chmodSync(file, 0o755);
  process.env.PATH = bin;
}

it('runs in the given folder with prompts, colour, paging and update notices off', async () => {
  stub('pwd; echo "$GH_PROMPT_DISABLED $GH_NO_UPDATE_NOTIFIER $NO_COLOR $GH_PAGER"; echo "$@"');
  const cwd = temp();
  const result = await ghRunner({ cwd })(['pr', 'list', '--repo', 'acme/widgets']);
  expect(result.code).toBe(0);
  expect(result.stdout.split('\n')).toEqual([cwd, '1 1 1 cat', 'pr list --repo acme/widgets', '']);
});

it('passes the exit code through, so 4 means signed out', async () => {
  stub('echo "authentication required" >&2; exit 4');
  expect(await ghRunner({ cwd: temp() })(['pr', 'list'])).toMatchObject({
    code: 4,
    stderr: 'authentication required\n',
  });
});

it('says gh is missing when it is not on PATH', async () => {
  process.env.PATH = temp();
  expect((await ghRunner({ cwd: temp() })(['pr', 'list'])).code).toBe('missing');
});

it('ends a gh that does not finish in time and leaves the outcome unknown', async () => {
  stub('sleep 5');
  expect((await ghRunner({ cwd: temp(), timeoutMs: 200 })(['pr', 'create'])).code).toBe('timeout');
});
