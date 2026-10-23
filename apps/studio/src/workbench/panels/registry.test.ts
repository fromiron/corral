import { expect, it } from 'vitest';
import { panelKey } from './registry.ts';

it('[TC-WBD-005-N] view keys retain their target and isolate connected services and projects', () => {
  const host = {};
  const anotherConnection = {};
  const graph = { kind: 'graph', projectId: 'project_a', corralId: 'team' } as const;
  expect(panelKey(host, graph)).toBe(panelKey(host, { ...graph }));
  expect(panelKey(host, graph)).not.toBe(panelKey(anotherConnection, graph));
  expect(panelKey(host, graph)).not.toBe(panelKey(host, { ...graph, projectId: 'project_b' }));
  expect(panelKey(host, { kind: 'run', runId: 'run_a' })).not.toBe(
    panelKey(host, { kind: 'run', runId: 'run_b' }),
  );
  expect(panelKey(host, { kind: 'file-preview', sessionId: 'session', path: 'a,b' })).not.toBe(
    panelKey(host, { kind: 'file-preview', sessionId: 'session,a', path: 'b' }),
  );
});

it('#86 every dock pane is defined once, has a URL panel and a palette entry', async () => {
  const { DOCK_VIEWS, PANE_CATALOG, SESSION_PANELS } = await import('./registry.ts');
  expect([...DOCK_VIEWS].sort()).toEqual(['chat', ...SESSION_PANELS].sort());
  expect(PANE_CATALOG.map((entry) => entry.view).sort()).toEqual([...SESSION_PANELS].sort());
  const slashes = PANE_CATALOG.map((entry) => entry.slash);
  expect(new Set(slashes).size).toBe(slashes.length);
});

it('#70 a pane is found by the words other screens and languages use for it', async () => {
  const { PANE_CATALOG } = await import('./registry.ts');
  const { rankCommands } = await import('../../commands.ts');
  const commands = PANE_CATALOG.map((entry) => ({
    id: entry.view,
    title: `Open ${entry.view}`,
    group: 'Panel',
    keywords: [...entry.aliases, entry.slash],
    run: () => {},
  }));
  const found = (query: string) => rankCommands(query, commands)[0]?.id;
  expect(found('결과')).toBe('artifacts');
  expect(found('산출물')).toBe('artifacts');
  expect(found('results')).toBe('artifacts');
  expect(found('검사')).toBe('checks');
  expect(found('검증')).toBe('checks');
  expect(found('터미널')).toBe('terminal');
  expect(found('shell')).toBe('terminal');
  expect(found('미리보기')).toBe('tools');
  expect(found('git')).toBe('git');
  expect(found('staged')).toBe('git');
  expect(found('debug')).toBe('debug');
  expect(found('중단점')).toBe('debug');
});
