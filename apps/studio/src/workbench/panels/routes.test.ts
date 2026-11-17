import { expect, it } from 'vitest';
import {
  patchSessionSearch,
  reviewSessionSearch,
  runSessionSearch,
  sessionPanelDescriptor,
  validateEditorSearch,
  validateReviewSearch,
  validateRunSearch,
  validateSessionSearch,
} from './routes.ts';

it('an advice arrival is read from the address and carried by no other change', () => {
  // The route keeps the run a person came to read advice in.
  expect(validateSessionSearch({ advice: 'run_a' })).toEqual({ advice: 'run_a' });
  expect(validateSessionSearch({ advice: '' })).toEqual({});
  // Another change of the view does not arrive again.
  expect(patchSessionSearch({ advice: 'run_a' }, { panel: 'files' })).toEqual({ panel: 'files' });
  expect(patchSessionSearch({ panel: 'files' }, { advice: 'run_b' })).toEqual({
    panel: 'files',
    advice: 'run_b',
  });
});

it('Git is a separate session pane and keeps its project/session identity', () => {
  expect(validateSessionSearch({ panel: 'git' })).toEqual({ panel: 'git' });
  expect(sessionPanelDescriptor('project', 'session', 'git')).toEqual({
    kind: 'git',
    projectId: 'project',
    sessionId: 'session',
  });
});

it('panel wins over compose; compose keeps the closed panel and whatever else the address says', () => {
  const compose = validateSessionSearch({ compose: true });
  expect(compose).toEqual({ compose: true });
  expect(validateSessionSearch({ compose: false })).toEqual({});
  // Both present: the address follows `panel` (features/session-panel.md 주소와 기억).
  const destination = { panel: 'run', run: 'run_target', view: 'run' };
  expect(validateSessionSearch({ compose: true, ...destination })).toEqual(destination);
  expect(validateSessionSearch({ compose: true, panel: 'files' })).toEqual({ panel: 'files' });
  // Without `panel` the panel is closed, whatever tab state the address carries along.
  for (const rest of [
    { run: 'run_target' },
    { view: 'results' },
    { execution: 'exec_target' },
    { artifact: 'artifact_target' },
    { result: 'result_target' },
  ])
    expect(validateSessionSearch({ compose: true, ...rest })).toEqual({ compose: true, ...rest });
  expect(validateSessionSearch({ compose: true, panel: 'unknown', run: '' })).toEqual({
    compose: true,
  });
  // A patch that names a panel opens it; any other patch leaves the panel closed.
  expect(patchSessionSearch(compose, { panel: 'files' })).toEqual({ panel: 'files' });
  expect(patchSessionSearch(compose, { panel: undefined })).toEqual({ compose: true });
  expect(patchSessionSearch(compose, { message: 'entry' })).toEqual({
    compose: true,
    message: 'entry',
  });
  expect(patchSessionSearch({ panel: 'files' }, { panel: undefined, compose: true })).toEqual({
    compose: true,
  });
});

it('a legacy tab link reads as its panel and a patch keeps the run it names', () => {
  expect(
    validateSessionSearch({ tab: 'run', panel: 'files', run: 'run_a', settings: 'models' }),
  ).toEqual({ panel: 'run', run: 'run_a' });
  expect(validateSessionSearch({ panel: 'unknown', settings: 'general' })).toEqual({});
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

it('persists exact historical sequences in both Run routes', () => {
  for (const atSeq of [0, 7, '7']) {
    expect(validateRunSearch({ atSeq })).toEqual({ atSeq: Number(atSeq) });
    expect(validateSessionSearch({ panel: 'run', run: 'run_history', atSeq })).toEqual({
      panel: 'run',
      run: 'run_history',
      atSeq: Number(atSeq),
    });
  }
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

it('a terminal link keeps its terminal only on the terminal pane', () => {
  expect(validateSessionSearch({ panel: 'terminal', terminal: 'terminal_owner' })).toEqual({
    panel: 'terminal',
    terminal: 'terminal_owner',
  });
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

it('a request to respond reaches the run history once and no later change carries it', () => {
  const respond = { panel: 'run', run: 'run_waiting', view: 'run', respond: true } as const;
  expect(validateSessionSearch(respond)).toEqual(respond);
  expect(validateRunSearch({ view: 'run', respond: true })).toEqual({ view: 'run', respond: true });
  // Only the literal request counts, and only for run history.
  expect(validateSessionSearch({ ...respond, respond: 'yes' })).not.toHaveProperty('respond');
  expect(validateRunSearch({ respond: 1 })).toEqual({});
  expect(validateSessionSearch({ panel: 'files', respond: true })).toEqual({ panel: 'files' });
  // A run's own address carries it into its session's run history.
  expect(runSessionSearch('run_waiting', { respond: true })).toEqual({
    panel: 'run',
    run: 'run_waiting',
    respond: true,
  });
  // Any later change of the view drops it; only an explicit request keeps it.
  expect(patchSessionSearch(respond, { execution: 'exec_a' })).toEqual({
    panel: 'run',
    run: 'run_waiting',
    view: 'run',
    execution: 'exec_a',
  });
  expect(patchSessionSearch(respond, { respond: undefined })).not.toHaveProperty('respond');
  expect(patchSessionSearch({ panel: 'run', run: 'run_waiting' }, { respond: true })).toEqual({
    panel: 'run',
    run: 'run_waiting',
    respond: true,
  });
});

it('reads a document’s file and source and a team graph’s team only with their panel', () => {
  expect(validateSessionSearch({ panel: 'document', file: 'src/a.ts' })).toEqual({
    panel: 'document',
    file: 'src/a.ts',
  });
  expect(
    validateSessionSearch({ panel: 'document', file: 'README.md', target: 'original' }),
  ).toEqual({ panel: 'document', file: 'README.md', target: 'original' });
  // Any other source is the conversation's Paddock.
  expect(validateSessionSearch({ panel: 'document', file: 'a.ts', target: 'other' })).toEqual({
    panel: 'document',
    file: 'a.ts',
  });
  expect(validateSessionSearch({ panel: 'graph', corral: 'team_a' })).toEqual({
    panel: 'graph',
    corral: 'team_a',
  });
  expect(validateSessionSearch({ panel: 'files', target: 'original', corral: 'team_a' })).toEqual({
    panel: 'files',
  });
  expect(validateSessionSearch({ panel: 'graph', corral: '' })).toEqual({ panel: 'graph' });
  // Neither has a pane descriptor of its own: their tabs are keyed by their file or team.
  expect(sessionPanelDescriptor('project', 'session', 'document')).toBeNull();
  expect(sessionPanelDescriptor('project', 'session', 'graph')).toBeNull();
});
