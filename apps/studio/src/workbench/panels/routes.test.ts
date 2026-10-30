import { expect, it } from 'vitest';
import {
  patchSessionSearch,
  resolveSessionSearch,
  reviewSessionSearch,
  sessionPanelDescriptor,
  validateEditorSearch,
  validateReviewSearch,
  validateRunSearch,
  validateSessionSearch,
} from './routes.ts';

it('Git is a separate session pane and keeps its project/session identity', () => {
  expect(validateSessionSearch({ panel: 'git' })).toEqual({ panel: 'git' });
  expect(sessionPanelDescriptor('project', 'session', 'git')).toEqual({
    kind: 'git',
    projectId: 'project',
    sessionId: 'session',
  });
});

it('composer links override remembered history without making composer focus sticky', () => {
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

it('an explicit target in a merged widget link takes precedence over composer focus', () => {
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

it('existing session links and remembered views keep their current precedence', () => {
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

it('settings and selection values do not become panel identity', () => {
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

it('existing graph, run and review validators preserve accepted values and reject invalid selectors', () => {
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

it.each([
  { search: {}, expected: { panel: 'changes', review: true } },
  {
    search: { scope: 'run' as const, runId: 'run_selected', file: 'src/a.ts' },
    expected: {
      panel: 'changes',
      review: true,
      scope: 'run',
      runId: 'run_selected',
      file: 'src/a.ts',
    },
  },
  {
    search: { scope: 'review' as const, file: 'README.md' },
    expected: { panel: 'changes', review: true, scope: 'review', file: 'README.md' },
  },
  { search: { scope: 'git' as const, file: 'README.md' }, expected: { panel: 'git' } },
])('preserves a legacy review destination inside Changes: $search', ({ search, expected }) => {
  expect(reviewSessionSearch(search)).toEqual(expected);
  expect(validateSessionSearch(expected)).toEqual(expected);
});

it('review selectors belong only to the Changes review view and clear when leaving it', () => {
  const review = {
    panel: 'changes' as const,
    review: true as const,
    scope: 'run' as const,
    runId: 'run_selected',
    file: 'src/a.ts',
  };
  expect(validateSessionSearch(review)).toEqual(review);
  expect(validateSessionSearch({ ...review, review: false })).toEqual({ panel: 'changes' });
  expect(validateSessionSearch({ ...review, panel: undefined })).toEqual({});
  expect(patchSessionSearch(review, { panel: 'files' })).toEqual({ panel: 'files' });
  expect(
    patchSessionSearch(review, {
      panel: 'run',
      run: 'run_result',
      view: 'results',
      result: 'version',
    }),
  ).toEqual({ panel: 'run', run: 'run_result', view: 'results', result: 'version' });
  expect(patchSessionSearch(review, { panel: undefined })).toEqual({});
  expect(patchSessionSearch(review, { review: undefined })).toEqual({ panel: 'changes' });
  expect(
    patchSessionSearch(review, { scope: 'session', runId: undefined, file: undefined }),
  ).toEqual({ panel: 'changes', review: true, scope: 'session' });
});

it('an explicit review target cannot inherit old run/result or review selections', () => {
  const review = { panel: 'changes' as const, review: true as const, scope: 'session' as const };
  expect(
    resolveSessionSearch(review, {
      panel: 'run',
      run: 'old_run',
      result: 'old_version',
      view: 'results',
      file: 'old.ts',
    }),
  ).toEqual(review);
  expect(
    resolveSessionSearch(review, {
      panel: 'changes',
      review: true,
      scope: 'run',
      runId: 'old_run',
      file: 'old.ts',
    }),
  ).toEqual(review);
  expect(
    resolveSessionSearch(
      { panel: 'files' },
      { panel: 'changes', review: true, scope: 'run', runId: 'old_run', file: 'old.ts' },
    ),
  ).toEqual({ panel: 'files' });
});

it('persists exact historical sequences in both Run routes and isolates explicit cursors from remembered targets', () => {
  for (const atSeq of [0, 7, '7']) {
    expect(validateRunSearch({ atSeq })).toEqual({ atSeq: Number(atSeq) });
    expect(validateSessionSearch({ run: 'run_history', atSeq, compose: true })).toEqual({
      run: 'run_history',
      atSeq: Number(atSeq),
    });
  }
  expect(resolveSessionSearch({ atSeq: 0 }, { run: 'old', execution: 'old_exec' })).toEqual({
    atSeq: 0,
  });
  for (const atSeq of [-1, 1.5, '1.5', '', 'no', Number.MAX_SAFE_INTEGER + 1]) {
    expect(validateRunSearch({ atSeq })).toEqual({});
  }
  expect(patchSessionSearch({ run: 'a', atSeq: 3 }, { run: 'b', atSeq: undefined })).toEqual({
    run: 'b',
  });
});

it('switching Runs clears implicit old targets and cursor while preserving explicit historical links', () => {
  const current = {
    run: 'run_old',
    atSeq: 9,
    execution: 'exec_old',
    artifact: 'art_old',
    result: 'result_old',
    view: 'results' as const,
    panel: 'run' as const,
  };
  expect(patchSessionSearch(current, { run: 'run_new', view: 'run' })).toEqual({
    panel: 'run',
    run: 'run_new',
    view: 'run',
  });
  expect(
    patchSessionSearch(current, { run: 'run_new', atSeq: 4, execution: 'exec_new', view: 'run' }),
  ).toEqual({ panel: 'run', run: 'run_new', atSeq: 4, execution: 'exec_new', view: 'run' });
  expect(patchSessionSearch(current, { run: 'run_old', view: 'run' }).atSeq).toBe(9);
});

it('a terminal recovery link overrides remembered terminal and run selections', () => {
  expect(
    resolveSessionSearch(
      { panel: 'terminal', terminal: 'terminal_owner' },
      { panel: 'run', run: 'old', terminal: 'terminal_other' },
    ),
  ).toEqual({ panel: 'terminal', terminal: 'terminal_owner' });
  expect(validateSessionSearch({ panel: 'files', terminal: 'terminal_owner' })).toEqual({
    panel: 'files',
  });
});

it('leaving run history clears its cursor while selecting another detail preserves it', () => {
  const history = { panel: 'run' as const, run: 'run_old', atSeq: 9, view: 'run' as const };
  expect(patchSessionSearch(history, { panel: undefined }).atSeq).toBeUndefined();
  expect(patchSessionSearch(history, { panel: 'files' }).atSeq).toBeUndefined();
  expect(patchSessionSearch(history, { execution: 'exec_old' }).atSeq).toBe(9);
});

it('message search opens its exact conversation without inheriting a saved run or panel', () => {
  expect(
    resolveSessionSearch(
      { message: 'entry_found' },
      { panel: 'changes', run: 'run_old', atSeq: 4, view: 'results', result: 'old' },
    ),
  ).toEqual({ message: 'entry_found' });
  expect(
    resolveSessionSearch({ message: 'entry_found' }, { panel: 'run', run: 'run_old' }),
  ).toEqual({ message: 'entry_found' });
});
