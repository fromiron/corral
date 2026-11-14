// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { CheckpointPanel } from './CheckpointPanel.tsx';

Element.prototype.getAnimations ??= () => [];

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../pages/FilesViews.tsx', () => ({ WORKSPACE_CHANGED: 'workspace-changed' }));

afterEach(() => vi.unstubAllGlobals());

const checkpoint = (n: number, overrides: Record<string, unknown> = {}) => ({
  checkpointId: `checkpoint${n}`,
  kind: 'manual',
  label: `Saved ${n}`,
  target: 'working_copy',
  state: 'ready',
  tree: String(n).repeat(40),
  manifestHash: String(n).repeat(64),
  runId: null,
  createdAt: `2026-11-10T0${n}:00:00Z`,
  pinned: false,
  ...overrides,
});

it('lists checkpoints on the kit lane; rewinding opens the restore preview and restores only once confirmed', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // The API answers newest first.
  const items = [checkpoint(2, { pinned: true }), checkpoint(1)];
  const plan = vi.fn(async (_session: string, checkpointId: string, manifestHash: string) => ({
    checkpointId,
    manifestHash,
    expectedTree: 'f'.repeat(40),
    targetTree: '1'.repeat(40),
    files: [{ path: 'notes.md', status: 'modified' }],
  }));
  const restore = vi.fn(async () => ({}));
  fixture.services = {
    mode: 'server',
    workspaces: {
      checkpoints: async () => ({ checkpoints: items, restores: [] }),
      planCheckpointRestore: plan,
      restoreCheckpoint: restore,
      pinCheckpoint: vi.fn(),
    },
    repository: { getSession: async () => ({ entries: [] }) },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <CheckpointPanel sessionId="session" />
        </IntlProvider>,
      ),
    );
    const lane = container.querySelector('[data-testid="checkpoint-lane"]');
    if (!lane) throw new Error('Missing checkpoint lane');
    const rows = [...lane.querySelectorAll('li')];
    // Oldest first on the lane; the pinned one says so.
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Saved 1'),
      expect.stringContaining('Saved 2 · Kept'),
    ]);
    const rewind = rows[0]?.querySelector('button');
    expect(rewind?.textContent).toBe('Preview restore');
    await act(async () => rewind?.click());

    expect(plan).toHaveBeenCalledWith('session', 'checkpoint1', '1'.repeat(64));
    const preview = container.querySelector('section[aria-label="Preview restore"]');
    expect(preview?.textContent).toContain('notes.md');
    expect(restore).not.toHaveBeenCalled();

    // Enter on a lane row asks for the same preview; it still does not restore.
    await act(async () =>
      rows[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(plan).toHaveBeenCalledTimes(2);
    expect(restore).not.toHaveBeenCalled();

    const confirm = [...(preview?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Restore Paddock',
    );
    await act(async () => confirm?.click());
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0]).toEqual([
      'session',
      expect.objectContaining({
        checkpointId: 'checkpoint1',
        manifestHash: '1'.repeat(64),
        expectedTree: 'f'.repeat(40),
      }),
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
