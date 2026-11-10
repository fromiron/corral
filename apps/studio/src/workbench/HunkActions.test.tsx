// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { HunkActions } from './HunkActions.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}));
afterEach(() => vi.unstubAllGlobals());

it('explicitly attaches only selected hunks with the frozen comparison, without applying them', async () => {
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
    // The part names its own button; no heading stands over that one control.
    expect(container.querySelector('h3')).toBeNull();
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Hunks.heading');
    await act(async () => button('Hunks.heading')?.click());
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

it('names each part by the lines the diff shows for it, keeps its hash for support and cuts a long path at the start', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const from = 'a'.repeat(40),
    to = 'b'.repeat(40);
  const path = 'src/components/conversation/conversation-measure-and-gutters.tsx';
  const workspaces = {
    hunks: vi.fn(async () => ({
      from,
      to,
      path,
      patchHash: 'c'.repeat(64),
      hunks: [
        // One added line after three lines of context: line 10 of the new file.
        { id: '0a0b57a8'.padEnd(64, '1'), patch: '@@ -7,6 +7,7 @@\n a\n b\n c\n+added\n d\n' },
        // A replaced line: the old line 19 and the new line 20, as the diff numbers them.
        {
          id: 'c6d067af'.padEnd(64, '2'),
          patch: '@@ -16,7 +17,7 @@ Next steps\n a\n b\n c\n-old\n+new\n d\n e\n',
        },
        // Removed lines only: named by the lines they had.
        {
          id: 'd00d'.padEnd(64, '3'),
          patch: '@@ -40,4 +41,2 @@\n a\n-gone\n-also gone\n\\ No newline at end of file\n b\n',
        },
      ],
    })),
    planHunks: vi.fn(),
    restoreCheckpoint: vi.fn(),
  };
  fixture.services = { mode: 'server', workspaceId: 'host', workspaces };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <HunkActions
          sessionId="session"
          projectId="project"
          from={from}
          to={to}
          path={path}
          active={false}
          onApplied={() => {}}
        />,
      ),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((item) => item.textContent === 'Hunks.heading')
        ?.click(),
    );
    const parts = [...container.querySelectorAll('li')];
    expect(
      parts.map((part) => part.querySelector('[role=checkbox]')?.getAttribute('aria-label')),
    ).toEqual([
      'Hunks.line:{"line":10}',
      'Hunks.lines:{"start":19,"end":20}',
      'Hunks.lines:{"start":41,"end":42}',
    ]);
    // No hash in the name; it stays on the part for support.
    expect(container.textContent).not.toContain('0a0b57a8');
    expect(parts[0]?.getAttribute('title')).toContain('0a0b57a8');
    const shown = container.querySelector('[dir="rtl"]');
    expect(shown?.textContent).toBe(path);
    expect(shown?.getAttribute('title')).toBe(path);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
