import type { LocalAiView } from '@corral/client';
import { Button, KitBadge } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import {
  type DiagnosticCause,
  type DiagnosticRow,
  type DiagnosticsReport,
  type DiagnosticTone,
  diagnosticRows,
  diagnosticsSummary,
  displayVersion,
} from '../workbench/diagnostics.ts';
import { useModelSettings } from '../workbench/modelSettings.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { useBinding } from './FilesViews.tsx';
import { SettingsLayout } from './SettingsPage.tsx';

const TONE_COLOR = {
  ok: 'green',
  attention: 'amber',
  error: 'red',
  neutral: 'gray',
} as const satisfies Record<DiagnosticTone, string>;

const LOCAL_AI_STATES = new Set<string>([
  'unsupported',
  'missing',
  'stale',
  'installing',
  'idle',
  'starting',
  'ready',
  'error',
]);

/** Settings › Diagnostics: each part's state, its cause, and the screen that fixes it. */
export function DiagnosticsSettingsPage() {
  const t = useTranslations('Diagnostics');
  const tm = useTranslations('Models');
  const tc = useTranslations('Connections');
  const tl = useTranslations('LocalAi');
  const tf = useTranslations('Files');
  const td = useTranslations('Desktop');
  const {
    mode,
    live,
    models,
    workspaces,
    serverVersion,
    pathEngine: readPathEngine,
  } = useServices();
  const navigation = useSettingsNavigation();
  const projectId = navigation.projectId;
  const serverModels = mode === 'server' ? models : null;
  const modelSettings = useModelSettings(serverModels && live ? serverModels : null);
  const { binding, reload } = useBinding(workspaces && projectId ? projectId : null);
  const [localAi, setLocalAi] = useState<
    { state: 'loading' | 'failed' } | { state: 'loaded'; view: LocalAiView }
  >({ state: 'loading' });
  const [pathEngine, setPathEngine] = useState<DiagnosticsReport['pathEngine']>(
    readPathEngine ? { state: 'loading' } : { state: 'loaded', status: { engine: 'builtIn' } },
  );
  const [check, setCheck] = useState(0);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    void check;
    if (!readPathEngine) return;
    let active = true;
    setPathEngine({ state: 'loading' });
    readPathEngine().then(
      (status) => active && setPathEngine({ state: 'loaded', status }),
      () => active && setPathEngine({ state: 'failed' }),
    );
    return () => {
      active = false;
    };
  }, [readPathEngine, check]);
  useEffect(() => {
    void check;
    if (!serverModels) return;
    let active = true;
    setLocalAi({ state: 'loading' });
    serverModels.localAi().then(
      (view) => active && setLocalAi({ state: 'loaded', view }),
      () => active && setLocalAi({ state: 'failed' }),
    );
    return () => {
      active = false;
    };
  }, [serverModels, check]);

  const report: DiagnosticsReport = {
    runtime: { mode, version: serverVersion ?? null, live },
    models: !serverModels
      ? { state: 'server-only' }
      : !live
        ? { state: 'simulated' }
        : modelSettings.error
          ? { state: 'failed' }
          : modelSettings.loading
            ? { state: 'loading' }
            : {
                state: 'ready',
                providers: modelSettings.providers,
                profiles: modelSettings.profiles,
              },
    folder: !workspaces
      ? { state: 'server-only' }
      : !projectId
        ? { state: 'no-project' }
        : binding === undefined
          ? { state: 'loading' }
          : binding === null
            ? { state: 'unbound' }
            : {
                state: 'bound',
                path: binding.path,
                trusted: binding.trusted,
                missing: binding.missing,
                isGit: binding.isGit,
              },
    pathEngine,
    localAi: serverModels ? localAi : { state: 'server-only' },
  };
  const rows = diagnosticRows(report);
  const version = displayVersion(serverVersion ?? null);

  const status = (row: DiagnosticRow) => {
    if (row.id === 'localAi' && LOCAL_AI_STATES.has(row.status)) return tl(`state.${row.status}`);
    if (row.status === 'server')
      return version
        ? t('status.server', {
            version: version === 'development' ? td('developmentBuild') : version,
          })
        : t('status.localServer');
    if (row.status === 'connected')
      return t('status.connected', {
        ready: row.counts?.ready ?? 0,
        total: row.counts?.total ?? 0,
      });
    return t(`status.${row.status}`);
  };
  const cause = (value: DiagnosticCause) => {
    switch (value.kind) {
      case 'noModel':
        return t('cause.noModel');
      case 'modelsFailed':
        return tm('loadFailed');
      case 'endpointFetch':
        // The words the endpoint's own connection row uses.
        return tc(`cause.fetch.${value.fetch}`);
      case 'endpointChanged':
        return tm('endpointChanged');
      case 'folderMissing':
        return report.folder.state === 'bound'
          ? tf('folderMissing', { path: report.folder.path })
          : null;
      case 'notGit':
        return tf('notGit');
      case 'pathFallback':
        return t(`cause.fallback.${value.reason}`);
      case 'localAiFailed':
        return tl('loadFailed');
      case 'localAiError':
        return report.localAi.state === 'loaded' ? report.localAi.view.error : null;
    }
  };
  const retry = () => {
    setCheck((count) => count + 1);
    void modelSettings.refresh().catch(() => {});
    void reload();
  };
  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticsSummary(report));
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };

  return (
    <SettingsLayout active="diagnostics">
      <main className="settings-content">
        <div className="flex flex-col">
          {rows.map((row) => (
            <section
              key={row.id}
              data-diagnostic={row.id}
              aria-labelledby={`diagnostic-${row.id}`}
              className="settings-row"
            >
              <div className="flex min-w-0 flex-col items-start gap-1.5">
                <h3 id={`diagnostic-${row.id}`}>{t(`rows.${row.id}`)}</h3>
                <KitBadge variant="dot" size="compact" color={TONE_COLOR[row.tone]}>
                  {status(row)}
                </KitBadge>
                {row.causes.map((value) => {
                  const text = cause(value);
                  return text ? (
                    <p
                      key={
                        value.kind === 'endpointFetch' ? `endpointFetch:${value.fetch}` : value.kind
                      }
                    >
                      {text}
                    </p>
                  ) : null;
                })}
              </div>
              {row.action === 'retry' ? (
                <Button variant="tertiary" size="compact" onClick={retry}>
                  {t('action.retry')}
                </Button>
              ) : row.action ? (
                <Button
                  variant="tertiary"
                  size="compact"
                  render={<Link {...navigation.link(row.action)} />}
                >
                  {t(`action.${row.action}`)}
                </Button>
              ) : null}
            </section>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => void copySummary()}>
            {t('copy')}
          </Button>
          <p role="status" className="text-caption text-muted-foreground">
            {copy === 'copied' ? t('copied') : copy === 'failed' ? t('copyFailed') : ''}
          </p>
        </div>
      </main>
    </SettingsLayout>
  );
}
