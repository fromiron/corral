// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readSeenMemory, seenMemoryKey } from '../../workbench/panel/memory.ts';
import {
  createShellWorld,
  type MountedShell,
  mountShell,
  type ShellWorld,
  settle,
  stubBrowser,
  WIDE,
} from './sessionShell.fixture.tsx';

// features/session-panel.md 주소와 기억: what this device keeps of when a conversation was entered
// and which ended run was seen there, apart from its tabs.

vi.setConfig({ testTimeout: 20_000 });

const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  cleanups.push(stubBrowser());
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(world: ShellWorld, address: string): Promise<MountedShell> {
  const shell = await mountShell(world, [address], { width: WIDE });
  cleanups.push(() => shell.unmount());
  await settle();
  return shell;
}

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
}

const seen = (sessionId: string) => readSeenMemory(window.localStorage, sessionId);

it('entering a conversation writes when, and a run that ends while it is open becomes the seen run', async () => {
  const world = await createShellWorld();
  const runId = await world.startRun();
  await world.working(runId, 1);
  const before = Date.now();
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => seen(world.sessionId)?.openedAt != null);
  const entered = seen(world.sessionId);
  expect(Date.parse(entered?.openedAt ?? '')).toBeGreaterThanOrEqual(before - 1000);
  // Still running: nothing is seen yet (counterexample).
  expect(entered?.seenRun ?? null).toBeNull();

  await world.releaseReplies();
  await world.runReaches(runId, ['succeeded']);
  await until(() => seen(world.sessionId)?.seenRun === runId);
  expect(seen(world.sessionId)?.seenRun).toBe(runId);
});

it('a run that ended before the entry is seen once the run list answers', async () => {
  const world = await createShellWorld({ holds: () => false });
  const runId = await world.startRun();
  await world.runReaches(runId, ['succeeded']);
  window.localStorage.setItem(
    seenMemoryKey(world.sessionId),
    JSON.stringify({ v: 1, openedAt: null, seenRun: 'run_older' }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => seen(world.sessionId)?.seenRun === runId);
  expect(seen(world.sessionId)?.seenRun).toBe(runId);
});

it('a run that ends while open is seen from its live record, before the run list says so', async () => {
  const world = await createShellWorld();
  const runId = await world.startRun();
  await world.working(runId, 1);
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => seen(world.sessionId)?.openedAt != null);
  const release = world.holdListings();
  try {
    await world.releaseReplies();
    await world.runReaches(runId, ['succeeded']);
    await until(() => seen(world.sessionId)?.seenRun === runId);
    expect(seen(world.sessionId)?.seenRun).toBe(runId);
  } finally {
    release();
  }
});
