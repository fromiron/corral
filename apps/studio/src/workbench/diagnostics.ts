import type { LocalAiView, ModelProfileView, ProviderAuthView } from '@corral/client';
import { profileReady } from './modelReadiness.ts';

// Settings › Diagnostics: what each part of Corral is doing, why, and where to fix it. The page and
// the copied summary read the same rows; the summary prints only their codes and counts.

/** Why path search runs on the built-in engine although FFF was wanted. */
export type PathEngineFallback = 'moduleUnavailable' | 'noBinary' | 'indexLimit' | 'callFailed';
export type PathEngineStatus =
  | { engine: 'built-in'; fallback?: PathEngineFallback }
  | { engine: 'fff' };

/** The path engine this build searches with. FFF reports itself here once it is wired in. */
export const CURRENT_PATH_ENGINE: PathEngineStatus = { engine: 'built-in' };

type EndpointTest = NonNullable<ProviderAuthView['connectionTest']>['kind'];

export interface DiagnosticsReport {
  runtime: { mode: 'server' | 'browser'; version: string | null; live: boolean };
  models:
    | { state: 'server-only' | 'simulated' | 'loading' | 'failed' }
    | { state: 'ready'; providers: ProviderAuthView[]; profiles: ModelProfileView[] };
  /** The settings target project's source folder. */
  folder:
    | { state: 'server-only' | 'no-project' | 'loading' | 'unbound' }
    | { state: 'bound'; path: string; trusted: boolean; missing: boolean; isGit: boolean };
  pathEngine: PathEngineStatus;
  localAi: { state: 'server-only' | 'loading' | 'failed' } | { state: 'loaded'; view: LocalAiView };
}

export type DiagnosticId = 'models' | 'server' | 'folder' | 'pathEngine' | 'localAi';
export type DiagnosticTone = 'ok' | 'attention' | 'error' | 'neutral';
export type DiagnosticCause =
  | { kind: 'noModel' }
  | { kind: 'modelsFailed' }
  | { kind: 'endpoint'; test: EndpointTest }
  | { kind: 'endpointChanged' }
  | { kind: 'folderMissing' }
  | { kind: 'notGit' }
  | { kind: 'pathFallback'; reason: PathEngineFallback }
  | { kind: 'localAiFailed' }
  | { kind: 'localAiError' };
/** Where an existing screen recovers the problem, or a fresh check. */
export type DiagnosticAction = 'models' | 'workspace' | 'retry';

export interface DiagnosticRow {
  id: DiagnosticId;
  tone: DiagnosticTone;
  /**
   * A stable code. Shared: serverOnly, loading, failed. models: connected, noModel, simulated.
   * server: server, browser. folder: noProject, unbound, trusted, untrusted, missing.
   * pathEngine: builtIn, fff. localAi: the server's install state.
   */
  status: string;
  counts?: { ready: number; total: number; signedIn: number; providers: number };
  causes: DiagnosticCause[];
  action?: DiagnosticAction;
}

const RELEASE = /^(\d{1,4}\.\d{1,4}\.\d{1,6})(?:[-+]\S{1,256})?$/;
/**
 * A release's major.minor.patch, a development build, or nothing that is not a version. A
 * pre-release or build suffix is dropped: it is free text that could carry a secret.
 */
export function displayVersion(version: string | null): 'development' | string | null {
  if (!version) return null;
  if (version === '0.0.0') return 'development';
  return RELEASE.exec(version)?.[1] ?? null;
}

/** A part that is not checked yet, not checked here, or only simulated. */
const PENDING = {
  'server-only': 'serverOnly',
  loading: 'loading',
  simulated: 'simulated',
} as const;

function modelsRow(models: DiagnosticsReport['models']): DiagnosticRow {
  const id = 'models';
  if (models.state !== 'ready')
    return models.state === 'failed'
      ? { id, tone: 'error', status: 'failed', causes: [{ kind: 'modelsFailed' }], action: 'retry' }
      : { id, tone: 'neutral', status: PENDING[models.state], causes: [] };
  const counts = {
    ready: models.profiles.filter(profileReady).length,
    total: models.profiles.length,
    signedIn: models.providers.filter((provider) => provider.signedIn).length,
    providers: models.providers.length,
  };
  const tests = [
    ...new Set(
      models.providers.flatMap((provider) =>
        provider.connectionTest && provider.connectionTest.kind !== 'connected'
          ? [provider.connectionTest.kind]
          : [],
      ),
    ),
  ];
  const causes: DiagnosticCause[] = [
    ...tests.map((test) => ({ kind: 'endpoint' as const, test })),
    ...(models.providers.some((provider) => provider.endpointChanged)
      ? [{ kind: 'endpointChanged' as const }]
      : []),
  ];
  if (!counts.ready)
    return {
      id,
      tone: 'attention',
      status: 'noModel',
      counts,
      causes: [{ kind: 'noModel' }, ...causes],
      action: 'models',
    };
  return {
    id,
    tone: causes.length ? 'attention' : 'ok',
    status: 'connected',
    counts,
    causes,
    ...(causes.length ? { action: 'models' as const } : {}),
  };
}

function folderRow(folder: DiagnosticsReport['folder']): DiagnosticRow {
  const id = 'folder';
  switch (folder.state) {
    case 'server-only':
      return { id, tone: 'neutral', status: 'serverOnly', causes: [] };
    case 'no-project':
      return { id, tone: 'neutral', status: 'noProject', causes: [] };
    case 'loading':
      return { id, tone: 'neutral', status: 'loading', causes: [] };
    case 'unbound':
      return { id, tone: 'attention', status: 'unbound', causes: [], action: 'workspace' };
  }
  if (folder.missing)
    return {
      id,
      tone: 'error',
      status: 'missing',
      causes: [{ kind: 'folderMissing' }],
      action: 'workspace',
    };
  const causes: DiagnosticCause[] = folder.isGit ? [] : [{ kind: 'notGit' }];
  return {
    id,
    tone: causes.length ? 'attention' : folder.trusted ? 'ok' : 'neutral',
    status: folder.trusted ? 'trusted' : 'untrusted',
    causes,
    ...(folder.trusted ? {} : { action: 'workspace' as const }),
  };
}

function pathEngineRow(engine: PathEngineStatus): DiagnosticRow {
  if (engine.engine === 'fff') return { id: 'pathEngine', tone: 'ok', status: 'fff', causes: [] };
  return engine.fallback
    ? {
        id: 'pathEngine',
        tone: 'attention',
        status: 'builtIn',
        causes: [{ kind: 'pathFallback', reason: engine.fallback }],
      }
    : { id: 'pathEngine', tone: 'ok', status: 'builtIn', causes: [] };
}

const LOCAL_AI_TONE: Record<LocalAiView['state'], DiagnosticTone> = {
  unsupported: 'neutral',
  missing: 'neutral',
  stale: 'attention',
  installing: 'neutral',
  idle: 'ok',
  starting: 'neutral',
  ready: 'ok',
  error: 'error',
};

function localAiRow(localAi: DiagnosticsReport['localAi']): DiagnosticRow {
  const id = 'localAi';
  if (localAi.state !== 'loaded')
    return localAi.state === 'failed'
      ? {
          id,
          tone: 'error',
          status: 'failed',
          causes: [{ kind: 'localAiFailed' }],
          action: 'retry',
        }
      : { id, tone: 'neutral', status: PENDING[localAi.state], causes: [] };
  const { state, error } = localAi.view;
  return {
    id,
    tone: LOCAL_AI_TONE[state],
    status: state,
    causes: error && state === 'error' ? [{ kind: 'localAiError' }] : [],
    ...(state === 'missing' || state === 'stale' || state === 'error'
      ? { action: 'models' as const }
      : {}),
  };
}

export function diagnosticRows(report: DiagnosticsReport): DiagnosticRow[] {
  return [
    modelsRow(report.models),
    {
      id: 'server',
      tone: report.runtime.mode === 'server' ? 'ok' : 'neutral',
      status: report.runtime.mode === 'server' ? 'server' : 'browser',
      causes: [],
    },
    folderRow(report.folder),
    pathEngineRow(report.pathEngine),
    localAiRow(report.localAi),
  ];
}

const LABELS: Record<DiagnosticId, string> = {
  models: 'model connection',
  server: 'runtime',
  folder: 'project source folder',
  pathEngine: 'file path engine',
  localAi: 'local AI',
};
/** Stands where a local path would be; the summary never names one. */
export const LOCAL_PATH = '<local path>';

const STATUS: Record<string, string> = {
  serverOnly: 'available with the local server',
  loading: 'checking',
  failed: 'could not check',
  noModel: 'no model connected',
  simulated: 'simulated agents only',
  browser: 'browser demo',
  noProject: 'no project selected',
  unbound: 'not linked',
  trusted: `linked ${LOCAL_PATH} · trusted`,
  untrusted: `linked ${LOCAL_PATH} · not trusted`,
  missing: `linked ${LOCAL_PATH} · missing`,
  builtIn: 'built-in',
  fff: 'FFF',
};

function causeCode(cause: DiagnosticCause): string {
  switch (cause.kind) {
    case 'endpoint':
      return `endpoint test ${cause.test}`;
    case 'pathFallback':
      return `fallback ${cause.reason}`;
    default:
      return cause.kind;
  }
}

/**
 * Plain text to paste into a report. It is built only from the rows' codes and counts and a
 * checked version, so keys, tokens, sign-in links, bootstrap fragments, local paths, server error
 * text and message bodies never reach it.
 */
export function diagnosticsSummary(report: DiagnosticsReport): string {
  const version = displayVersion(report.runtime.version);
  const lines = diagnosticRows(report).map((row) => {
    let status: string;
    if (row.id === 'server')
      status =
        row.status === 'server'
          ? `local server${version === 'development' ? ' · development build' : version ? ` · version ${version}` : ''}`
          : 'browser demo';
    else if (row.id === 'localAi' && row.status in LOCAL_AI_TONE)
      status = row.status === 'missing' ? 'not installed' : row.status;
    else if (row.status === 'connected' && row.counts)
      status = `connected · ${row.counts.ready}/${row.counts.total} models ready`;
    else status = STATUS[row.status] ?? 'unknown';
    if (row.counts)
      status += ` · ${row.counts.signedIn}/${row.counts.providers} providers signed in`;
    const causes = row.causes.map(causeCode);
    return `${LABELS[row.id]}: ${status}${causes.length ? ` · ${causes.join(', ')}` : ''}`;
  });
  return ['Corral diagnostics', ...lines].join('\n');
}
