// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { CheckpointPanel } from './CheckpointPanel.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../pages/FilesViews.tsx', () => ({ WORKSPACE_CHANGED: 'workspace-changed' }));

it('shows checkpoint timestamps and source requests without merging identical trees', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const checkpoints = [1, 2].map((n) => ({
    checkpointId: `checkpoint${n}`,
    kind: 'before_run',
    label: n === 1 ? 'Before Run' : 'Message branch baseline',
    target: 'working_copy',
    state: 'ready',
    tree: 'a'.repeat(40),
    runId: `run${n}`,
    createdAt: `2026-10-27T0${n}:00:00Z`,
    pinned: false,
  }));
  fixture.services = {
    mode: 'server',
    workspaces: { checkpoints: async () => ({ checkpoints, restores: [] }) },
    repository: {
      getSession: async () => ({
        entries: [
          { runId: 'run1', text: 'First request' },
          { runId: 'run2', text: 'Second request' },
        ],
      }),
    },
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <CheckpointPanel sessionId="session" />
        </IntlProvider>,
      ),
    );
    const rows = container.querySelectorAll('[data-testid="checkpoint-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('First request');
    expect(rows[0]?.textContent?.match(/Before Run/g)).toHaveLength(1);
    expect(rows[1]?.textContent).toContain('Second request');
    expect(rows[1]?.textContent).toContain('Message branch baseline');
    expect(rows[1]?.textContent).toContain('No changes since the previous checkpoint');
    expect([...container.querySelectorAll('time')].map((time) => time.dateTime)).toEqual(
      checkpoints.map((item) => item.createdAt),
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it('does not execute a restore whose preview has no changed files', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const restore = vi.fn();
  const item = {
    checkpointId: 'empty',
    kind: 'before_run',
    target: 'working_copy',
    state: 'ready',
    tree: 'a'.repeat(40),
    manifestHash: 'b'.repeat(64),
    createdAt: '2026-10-27T00:00:00Z',
    pinned: false,
  };
  fixture.services = {
    mode: 'server',
    workspaces: {
      checkpoints: async () => ({ checkpoints: [item], restores: [] }),
      planCheckpointRestore: async () => ({
        checkpointId: item.checkpointId,
        manifestHash: item.manifestHash,
        expectedTree: item.tree,
        targetTree: item.tree,
        files: [],
      }),
      restoreCheckpoint: restore,
    },
    repository: { getSession: async () => ({ entries: [] }) },
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <CheckpointPanel sessionId="session" />
        </IntlProvider>,
      ),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Preview restore')
        ?.click(),
    );
    const button = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Restore working copy',
    );
    expect(button?.disabled).toBe(true);
    await act(async () => button?.click());
    expect(restore).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Already matches this checkpoint');
  } finally {
    await act(async () => root.unmount());
  }
});
