import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { ROOT } from './candidate.ts';

test('Linux isolation rejects host access and cleans up owned descendants', {
  skip: process.env.CORRAL_SANDBOX_PROBE !== '1',
}, () => {
  const result = execFileSync(process.execPath, ['tools/sandbox/probe.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(JSON.parse(result).status, 'passed');
});
