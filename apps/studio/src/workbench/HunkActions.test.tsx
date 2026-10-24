// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { HunkActions } from './HunkActions.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
afterEach(() => vi.unstubAllGlobals());

it('[TC-WBD-007-H] explicitly attaches only selected hunks with the frozen comparison, without applying them', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const from = 'a'.repeat(40),
    to = 'b'.repeat(40),
    patchHash = 'c'.repeat(64);
  const selectedId = 'd'.repeat(64),
    ignoredId = 'e'.repeat(64);
  const workspaces = {
    hunks: vi.fn(async () => ({
      from,
      to,
      path: 'src/file.ts',
      patchHash,
      hunks: [
        { id: selectedId, patch: '@@ selected @@\n+selected' },
        { id: ignoredId, patch: '@@ ignored @@\n+ignored' },
      ],
    })),
    planHunks: vi.fn(),
    restoreCheckpoint: vi.fn(),
  };
  fixture.services = { mode: 'server', workspaceId: 'host', workspaces };
  const onAttach = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === label);
  try {
    await act(async () =>
      root.render(
        <HunkActions
          sessionId="session"
          projectId="project"
          from={from}
          to={to}
          path="src/file.ts"
          active={false}
          onApplied={() => {}}
          onAttach={onAttach}
        />,
      ),
    );
    await act(async () => button('Hunks.load')?.click());
    const attach = button('Hunks.attachSelected');
    expect(attach).toBeDefined();
    expect(attach?.disabled).toBe(true);
    expect(onAttach).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLElement>('[role=checkbox]')?.click());
    await act(async () => button('Hunks.attachSelected')?.click());
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(onAttach.mock.calls[0]?.[0]).toMatchObject({
      text: '@@ selected @@\n+selected',
      provenance: {
        kind: 'hunk',
        hostId: 'host',
        projectId: 'project',
        sessionId: 'session',
        from,
        to,
        path: 'src/file.ts',
        patchHash,
        hunkIds: [selectedId],
      },
    });
    expect(onAttach.mock.calls[0]?.[1]).toMatchObject({
      target: { hostId: 'host', projectId: 'project', sessionId: 'session' },
    });
    expect(workspaces.planHunks).not.toHaveBeenCalled();
    expect(workspaces.restoreCheckpoint).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
