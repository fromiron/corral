import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireDatabaseLock } from '../src/ownership.ts';

it('a former owner cannot release or replace the current owner lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-sqlite-owner-'));
  const path = join(root, 'server.lock.db');
  const first = acquireDatabaseLock(path);
  let second = () => {};
  try {
    const inode = statSync(path).ino;
    expect(() => acquireDatabaseLock(path)).toThrow('workspace is already owned');
    first();
    second = acquireDatabaseLock(path);
    first();
    expect(() => acquireDatabaseLock(path)).toThrow('workspace is already owned');
    expect(statSync(path).ino).toBe(inode);
  } finally {
    first();
    second();
    rmSync(root, { recursive: true, force: true });
  }
});
