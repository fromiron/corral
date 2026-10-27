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
    expect(rows[1]?.textContent).toContain('Second request');
    expect([...container.querySelectorAll('time')].map((time) => time.dateTime)).toEqual(
      checkpoints.map((item) => item.createdAt),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
