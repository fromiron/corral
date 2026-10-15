import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDatabaseLock } from '@corral/storage-sqlite';

/** Acquire before opening or recovering the run database, and release after closing it. */
export function acquireWorkspaceOwnership(root: string): () => void {
  const directory = join(root, '.corral');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return acquireDatabaseLock(join(directory, 'server.lock.db'));
}
