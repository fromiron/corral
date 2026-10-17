import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { launchFingerprint } from '../src/files/launch-fingerprint.ts';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'corral-fingerprint-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const command = { id: 'check', name: 'Check', argv: ['node', 'check.mjs'], timeoutMs: 1000 };
it('[TC-HAR-012-N] fingerprints scripts, lockfiles, executable contents and config revision while allowing a relocated frozen copy', async () => {
  const root = temp(); const copy = temp();
  for (const dir of [root,copy]) { writeFileSync(join(dir, 'check.mjs'), 'console.log(1)'); writeFileSync(join(dir,'package.json'), '{"scripts":{"check":"node check.mjs"}}'); }
  const first = await launchFingerprint(root, 1, command);
  expect((await launchFingerprint(copy,1,command)).fingerprint).toBe(first.fingerprint);
  expect(first.executable).toContain('node');
  writeFileSync(join(copy,'package-lock.json'), '{}');
  expect((await launchFingerprint(copy,1,command)).fingerprint).not.toBe(first.fingerprint);
  rmSync(join(copy,'package-lock.json'));
  writeFileSync(join(copy,'check.mjs'), 'console.log(2)');
  expect((await launchFingerprint(copy,1,command)).fingerprint).not.toBe(first.fingerprint);
  expect((await launchFingerprint(root,2,command)).fingerprint).not.toBe(first.fingerprint);
  const binary = join(temp(),'runner'); writeFileSync(binary,'one',{mode:0o700});
  const binCommand = { ...command, argv: [binary] };
  const before = await launchFingerprint(root,1,binCommand);
  writeFileSync(binary,'two');
  expect((await launchFingerprint(root,1,binCommand)).fingerprint).not.toBe(before.fingerprint);
});
it('[TC-HAR-012-N] refuses a package manifest linked outside the worktree', async () => {
  const root=temp(), outside=temp(); writeFileSync(join(outside,'secret.json'),'{}');
  symlinkSync(join(outside,'secret.json'),join(root,'package.json'));
  await expect(launchFingerprint(root,1,command)).rejects.toThrow(/scope|link/);
});
