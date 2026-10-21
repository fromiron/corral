import { type PanelDescriptor, SESSION_PANELS, type SessionPanel } from './registry.ts';

export interface RunDetailSearch {
  execution?: string | undefined;
  artifact?: string | undefined;
  view?: 'results' | 'run' | undefined;
  result?: string | undefined;
}
export interface SessionSearch extends RunDetailSearch {
  message?: string | undefined;
  compose?: true | undefined;
  /** Old links only (`tab=run`); read into `panel`. */
  tab?: 'work' | 'team' | 'run' | undefined;
  panel?: SessionPanel | undefined;
  run?: string | undefined;
}
export interface ReviewSearch {
  scope?: 'session' | 'review' | 'run' | 'git';
  runId?: string;
  file?: string;
}
export interface EditorSearch {
  fromRun?: string;
  fromVersion?: string;
  fromSession?: string;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export function validateSessionSearch(search: Record<string, unknown>): SessionSearch {
  const out: SessionSearch = {};
  if (SESSION_PANELS.includes(search.panel as SessionPanel))
    out.panel = search.panel as SessionPanel;
  if (search.tab === 'run') out.panel = 'run';
  if (search.view === 'results' || search.view === 'run') out.view = search.view;
  for (const key of ['run', 'execution', 'artifact', 'result', 'message'] as const) {
    const value = text(search[key]);
    if (value) out[key] = value;
  }
  if (
    search.compose === true &&
    !(out.panel || out.run || out.view || out.execution || out.artifact || out.result)
  )
    out.compose = true;
  return out;
}

export function validateRunSearch(search: Record<string, unknown>): RunDetailSearch {
  return {
    ...(typeof search.execution === 'string' ? { execution: search.execution } : {}),
    ...(typeof search.artifact === 'string' ? { artifact: search.artifact } : {}),
    ...(search.view === 'results' || search.view === 'run' ? { view: search.view } : {}),
    ...(typeof search.result === 'string' ? { result: search.result } : {}),
  };
}

export function validateReviewSearch(search: Record<string, unknown>): ReviewSearch {
  return {
    ...(search.scope === 'session' ||
    search.scope === 'review' ||
    search.scope === 'run' ||
    search.scope === 'git'
      ? { scope: search.scope }
      : {}),
    ...(typeof search.runId === 'string' ? { runId: search.runId } : {}),
    ...(typeof search.file === 'string' ? { file: search.file } : {}),
  };
}

export function validateEditorSearch(search: Record<string, unknown>): EditorSearch {
  return {
    ...(typeof search.fromRun === 'string' && typeof search.fromVersion === 'string'
      ? { fromRun: search.fromRun, fromVersion: search.fromVersion }
      : {}),
    ...(typeof search.fromSession === 'string' &&
    /^session_[A-Za-z0-9_-]+$/.test(search.fromSession)
      ? { fromSession: search.fromSession }
      : {}),
  };
}

/** An explicit target cannot inherit another target's remembered selection. */
export function resolveSessionSearch(url: SessionSearch, remembered: unknown): SessionSearch {
  // TanStack merges validated fields with raw parent search; normalize that merged view.
  const selection = validateSessionSearch({ ...url });
  const explicitTarget = Boolean(
    selection.compose ||
      selection.run ||
      selection.view ||
      selection.artifact ||
      selection.result ||
      selection.execution,
  );
  const saved = validateSessionSearch(
    remembered && typeof remembered === 'object' ? (remembered as Record<string, unknown>) : {},
  );
  delete saved.compose;
  return {
    ...(!explicitTarget ? saved : {}),
    ...selection,
  };
}

export function patchSessionSearch(
  current: SessionSearch,
  patch: Partial<SessionSearch>,
): SessionSearch {
  return validateSessionSearch({
    ...current,
    ...patch,
    ...('panel' in patch || 'view' in patch ? { compose: undefined } : {}),
    ...(patch.view === 'results' ? { artifact: undefined } : {}),
  });
}

export function sessionPanelDescriptor(
  projectId: string,
  sessionId: string,
  panel: SessionPanel | undefined,
  runId?: string | null,
): PanelDescriptor | null {
  if (!panel) return null;
  if (panel === 'run') return runId ? { kind: 'run', runId } : null;
  return { kind: panel, projectId, sessionId };
}
