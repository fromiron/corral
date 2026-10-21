import { expect, it } from 'vitest';
import {
  patchSessionSearch,
  resolveSessionSearch,
  sessionPanelDescriptor,
  validateEditorSearch,
  validateReviewSearch,
  validateRunSearch,
  validateSessionSearch,
} from './routes.ts';

it('[TC-WBD-007-H] composer links override remembered history without making composer focus sticky', () => {
  const remembered = { panel: 'run', run: 'run_old', view: 'run', execution: 'old_call' };
  const compose = validateSessionSearch({ compose: true });
  expect(compose).toEqual({ compose: true });
  expect(validateSessionSearch({ compose: false })).toEqual({});
  expect(resolveSessionSearch(compose, remembered)).toEqual({ compose: true });
  expect(resolveSessionSearch({}, { ...remembered, compose: true })).toEqual(remembered);
  expect(patchSessionSearch(compose, { panel: 'files' })).toEqual({ panel: 'files' });
  expect(patchSessionSearch(compose, { panel: undefined })).toEqual({});
  expect(patchSessionSearch(compose, { view: 'results' })).toEqual({ view: 'results' });
  expect(patchSessionSearch(compose, { message: 'entry' })).toEqual({
    compose: true,
    message: 'entry',
  });
});

it('[TC-WBD-007-N] an explicit target in a merged widget link takes precedence over composer focus', () => {
  const destination = { panel: 'run', run: 'run_target', view: 'run' };
  expect(validateSessionSearch({ compose: true, ...destination })).toEqual(destination);
  expect(
    resolveSessionSearch({ compose: true, panel: 'run', run: 'run_target', view: 'run' }, {}),
  ).toEqual(destination);
  for (const target of [
    { panel: 'files' },
    { run: 'run_target' },
    { view: 'results' },
    { execution: 'exec_target' },
    { artifact: 'artifact_target' },
    { result: 'result_target' },
  ])
    expect(validateSessionSearch({ compose: true, ...target })).toEqual(target);
  expect(validateSessionSearch({ compose: true, panel: 'unknown', run: '' })).toEqual({
    compose: true,
  });
});

it('[TC-WBD-005-H] existing session links and remembered views keep their current precedence', () => {
  const remembered = {
    panel: 'files',
    run: 'run_old',
    execution: 'old_call',
    artifact: 'old_artifact',
  };
  expect(
    validateSessionSearch({ tab: 'run', panel: 'files', run: 'run_a', settings: 'models' }),
  ).toEqual({ panel: 'run', run: 'run_a' });
  expect(resolveSessionSearch({ panel: 'run', run: 'run_a' }, remembered)).toEqual({
    panel: 'run',
    run: 'run_a',
  });
  expect(resolveSessionSearch({ panel: 'changes' }, remembered)).toEqual({
    ...remembered,
    panel: 'changes',
  });
  expect(
    resolveSessionSearch(validateSessionSearch({ panel: 'unknown', settings: 'general' }), null),
  ).toEqual({});
  expect(
    patchSessionSearch(
      { panel: 'run', run: 'run_a', artifact: 'version_a' },
      { view: 'results', result: 'answer' },
    ),
  ).toEqual({ panel: 'run', run: 'run_a', view: 'results', result: 'answer' });
});

it('[TC-WBD-005-N] settings and selection values do not become panel identity', () => {
  const first = validateSessionSearch({
    panel: 'run',
    run: 'run_a',
    result: 'v1',
    settings: 'models',
  });
  const next = validateSessionSearch({
    panel: 'run',
    run: 'run_a',
    result: 'v2',
    settings: 'general',
  });
  expect(sessionPanelDescriptor('project', 'session', first.panel, first.run)).toEqual(
    sessionPanelDescriptor('project', 'session', next.panel, next.run),
  );
  expect(sessionPanelDescriptor('project', 'session', 'files')).toEqual({
    kind: 'files',
    projectId: 'project',
    sessionId: 'session',
  });
  expect(sessionPanelDescriptor('project', 'session', 'run')).toBeNull();
  expect(sessionPanelDescriptor('project', 'session', undefined)).toBeNull();
});

it('[TC-WBD-005-F] existing graph, run and review validators preserve accepted values and reject invalid selectors', () => {
  expect(
    validateRunSearch({ execution: '', artifact: 'version', view: 'other', result: 4 }),
  ).toEqual({ execution: '', artifact: 'version' });
  expect(
    validateReviewSearch({ scope: 'run', runId: 'run_a', file: 'src/a.ts', settings: 'general' }),
  ).toEqual({ scope: 'run', runId: 'run_a', file: 'src/a.ts' });
  expect(validateReviewSearch({ scope: 'unknown', runId: false, file: [] })).toEqual({});
  expect(
    validateEditorSearch({ fromRun: 'run_a', fromVersion: 'v1', fromSession: 'session_a' }),
  ).toEqual({ fromRun: 'run_a', fromVersion: 'v1', fromSession: 'session_a' });
  expect(validateEditorSearch({ fromRun: 'run_a', fromSession: '/sessions/session_a' })).toEqual(
    {},
  );
});
