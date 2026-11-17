import { type PanelDescriptor, SESSION_PANELS, type SessionPanel } from './registry.ts';

export interface RunDetailSearch {
  atSeq?: number | undefined;
  execution?: string | undefined;
  artifact?: string | undefined;
  view?: 'results' | 'run' | undefined;
  result?: string | undefined;
  /**
   * An explicit request to answer this run (the conversation's notice, the waiting run control,
   * a notification): the run page opens its response area and consumes the request once.
   */
  respond?: true | undefined;
}
export interface SessionSearch extends RunDetailSearch, ReviewSearch {
  review?: true | undefined;
  message?: string | undefined;
  /** A run whose row's unread advice the conversation opens (features/inbox.md `advice`). */
  advice?: string | undefined;
  compose?: true | undefined;
  /** Old links only (`tab=run`); read into `panel`. */
  tab?: 'work' | 'team' | 'run' | undefined;
  panel?: SessionPanel | undefined;
  run?: string | undefined;
  terminal?: string | undefined;
  /** With `panel=document`: the file is in the project's source folder, not the Paddock. */
  target?: 'original' | undefined;
  /** With `panel=graph`: the team. */
  corral?: string | undefined;
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

const sequence = (value: unknown): number | undefined => {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};

export function validateSessionSearch(search: Record<string, unknown>): SessionSearch {
  const out: SessionSearch = {};
  const atSeq = sequence(search.atSeq);
  if (atSeq !== undefined) out.atSeq = atSeq;
  if (SESSION_PANELS.includes(search.panel as SessionPanel))
    out.panel = search.panel as SessionPanel;
  if (search.tab === 'run') out.panel = 'run';
  if (out.panel === 'terminal' && text(search.terminal)) out.terminal = text(search.terminal);
  if (out.panel === 'document' && text(search.file)) {
    out.file = text(search.file);
    if (search.target === 'original') out.target = 'original';
  }
  if (out.panel === 'graph' && text(search.corral)) out.corral = text(search.corral);
  if (out.panel === 'run' && search.respond === true) out.respond = true;
  if (search.view === 'results' || search.view === 'run') out.view = search.view;
  for (const key of ['run', 'execution', 'artifact', 'result', 'message', 'advice'] as const) {
    const value = text(search[key]);
    if (value) out[key] = value;
  }
  if (out.panel === 'changes' && search.review === true) {
    out.review = true;
    Object.assign(out, validateReviewSearch(search));
  }
  // `panel` wins over `compose` (features/session-panel.md 주소와 기억).
  if (search.compose === true && !out.panel) out.compose = true;
  return out;
}

export function validateRunSearch(search: Record<string, unknown>): RunDetailSearch {
  const atSeq = sequence(search.atSeq);
  return {
    ...(atSeq !== undefined ? { atSeq } : {}),
    ...(typeof search.execution === 'string' ? { execution: search.execution } : {}),
    ...(typeof search.artifact === 'string' ? { artifact: search.artifact } : {}),
    ...(search.view === 'results' || search.view === 'run' ? { view: search.view } : {}),
    ...(typeof search.result === 'string' ? { result: search.result } : {}),
    ...(search.respond === true ? { respond: true as const } : {}),
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

/**
 * A session run's own address opens its session's run history on the same run, keeping the
 * view, the result or artifact being read and the inspected execution.
 */
export function runSessionSearch(runId: string, search: RunDetailSearch): SessionSearch {
  return validateSessionSearch({
    panel: 'run',
    run: runId,
    ...validateRunSearch({ ...search }),
  });
}

/** Legacy review links select the same Changes view as in-session review. */
export function reviewSessionSearch(search: ReviewSearch): SessionSearch {
  return search.scope === 'git'
    ? { panel: 'git' }
    : { panel: 'changes', review: true, ...validateReviewSearch({ ...search }) };
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

export function patchSessionSearch(
  current: SessionSearch,
  patch: Partial<SessionSearch>,
): SessionSearch {
  return validateSessionSearch({
    ...current,
    // Only the change that asks to respond, or to read an advice, carries the request.
    respond: undefined,
    advice: undefined,
    ...('run' in patch && patch.run !== current.run
      ? {
          execution: undefined,
          artifact: undefined,
          result: undefined,
          view: undefined,
          atSeq: undefined,
        }
      : {}),
    ...patch,
    ...('panel' in patch && patch.panel !== 'run' ? { atSeq: undefined } : {}),
    ...(patch.panel !== undefined ? { compose: undefined } : {}),
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
  // Terminals and running commands are keyed by their own owners, not by the pane.
  if (panel === 'terminal' || panel === 'tools' || panel === 'document' || panel === 'graph')
    return null;
  return { kind: panel, projectId, sessionId };
}
