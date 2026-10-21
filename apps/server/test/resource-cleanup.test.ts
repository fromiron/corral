import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { onceResourceCleanup } from '../src/resource-cleanup.ts';
import { acquireWorkspaceOwnership } from '../src/workspace-ownership.ts';

it('[TC-ABS-007-N] an incomplete cleanup retains the real workspace lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-cleanup-lock-'));
  const unlock = acquireWorkspaceOwnership(root);
  try {
    const resources = new AsyncDisposableStack();
    resources.defer(() => {
      throw new Error('child exit was not confirmed');
    });
    const close = onceResourceCleanup(() => resources.disposeAsync(), unlock);
    await expect(close()).rejects.toMatchObject({ code: 'RESOURCE_CLEANUP_FAILED' });
    expect(() => acquireWorkspaceOwnership(root)).toThrow();
    await expect(close()).rejects.toMatchObject({ code: 'RESOURCE_CLEANUP_FAILED' });
    expect(() => acquireWorkspaceOwnership(root)).toThrow();
  } finally {
    unlock();
    const reopened = acquireWorkspaceOwnership(root);
    reopened();
    rmSync(root, { recursive: true, force: true });
  }
});

it('[TC-ABS-007-N] failed resource disposal remains failed on every shutdown attempt', async () => {
  const resources = new AsyncDisposableStack();
  let attempts = 0;
  resources.defer(() => {
    attempts++;
    throw new Error('termination unconfirmed');
  });
  const close = onceResourceCleanup(() => resources.disposeAsync());
  const first = close();
  await expect(first).rejects.toMatchObject({ code: 'RESOURCE_CLEANUP_FAILED' });
  // The underlying stack now reports success, despite its earlier failed cleanup.
  await expect(resources.disposeAsync()).resolves.toBeUndefined();
  expect(close()).toBe(first);
  await expect(close()).rejects.toMatchObject({ code: 'RESOURCE_CLEANUP_FAILED' });
  expect(attempts).toBe(1);
});

it('[TC-ABS-007-H] concurrent and repeated successful shutdown share one completion', async () => {
  let attempts = 0;
  const close = onceResourceCleanup(async () => {
    attempts++;
  });
  const first = close();
  expect(close()).toBe(first);
  await first;
  await close();
  expect(attempts).toBe(1);
});
