// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkspaceFiles } from './useWorkspaceFiles.ts';

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../pages/FilesViews.tsx', () => ({ WORKSPACE_CHANGED: 'workspace-changed' }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

const offline = async () => {
  throw new Error('offline');
};
const folder = async () => ({ projectId: 'project' });
const noCopy = async () => null;
const listing = async () => ({ files: [], truncated: false });

async function read(workspaces: Record<string, unknown>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.services = { workspaces };
  let state!: ReturnType<typeof useWorkspaceFiles>;
  function Harness() {
    state = useWorkspaceFiles('project', 'session');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  cleanups.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(<Harness />));
  await act(async () => {});
  return state;
}

// docs/specs/workbench.md: the Files tab says which read failed.
it.each([
  ['folder', { binding: offline, worktree: noCopy, listFiles: listing }],
  ['copy', { binding: folder, worktree: offline, listFiles: listing }],
  ['list', { binding: folder, worktree: noCopy, listFiles: offline }],
  ['folder', { binding: offline, worktree: offline, listFiles: offline }],
])('names the read that failed: %s', async (what, workspaces) => {
  const state = await read(workspaces);
  expect(state.error).toEqual({ what, message: 'offline' });
  expect(state.scope).toBeNull();
  expect(state.loading).toBe(false);
});
