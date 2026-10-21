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
