import type { DecisionApiView, LocalAiView } from '@corral/client';
import { Button, Select } from '@corral/react/design-kit';
import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useModelSettingsRefresh } from '../workbench/modelSettings.tsx';

const INSTALLED = new Set<LocalAiView['state']>(['idle', 'starting', 'ready']);
const MB = 1_000_000;

/**
 * The local judge's model and runtime: the server downloads them when the person presses
 * Install, and this panel follows that install until it ends. Below it, the workspace's
 * external judge for requests the local judge is unsure about.
 */
export function LocalAiPanel({
  onInstalled,
  pollMs = 1000,
}: {
  /** Called once an install from this panel finishes, so automatic reasoning can re-read. */
  onInstalled(): void;
  pollMs?: number;
}) {
  const t = useTranslations('LocalAi');
  const format = useFormatter();
  const { models } = useServices();
  const [view, setView] = useState<LocalAiView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const installed = useRef(onInstalled);
  installed.current = onInstalled;
  const installing = view?.state === 'installing';

  useEffect(() => {
    let mounted = true;
    void models?.localAi().then(
      (value) => {
        if (mounted) setView(value);
      },
      () => {
        if (mounted) setLoadFailed(true);
      },
    );
    return () => {
      mounted = false;
    };
  }, [models]);

  // Follow a running install one request at a time; a cancel or unmount stops following.
  useEffect(() => {
    if (!installing || !models) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      timer = setTimeout(async () => {
        try {
          const next = await models.localAi();
          if (stopped) return;
          setView(next);
          if (next.state === 'installing') poll();
          else if (INSTALLED.has(next.state)) installed.current();
        } catch {
          if (!stopped) poll();
        }
      }, pollMs);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [installing, models, pollMs]);

  const run = async (action: () => Promise<LocalAiView>) => {
    setBusy(true);
    setActionFailed(false);
    try {
      setView(await action());
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const mb = (bytes: number) => format.number(Math.round(bytes / MB));
  const canInstall = view && (view.state === 'missing' || view.state === 'stale');

  return (
    <>
      <section className="settings-row" aria-labelledby="local-ai-heading">
        <div>
          <h3 id="local-ai-heading">{t('heading')}</h3>
          {view ? (
            <>
              <p role="status">
                {view.modelName} · {t(`state.${view.state}`)}
              </p>
              {canInstall && view.downloadBytes !== null ? (
                <p>{t('download', { size: mb(view.downloadBytes) })}</p>
              ) : null}
              {installing && view.progress ? (
                <p>
                  {t('progress', {
                    percent: Math.floor((view.progress.received / view.progress.total) * 100),
                    received: mb(view.progress.received),
                    total: mb(view.progress.total),
                  })}
                </p>
              ) : null}
              {view.error && view.state !== 'unsupported' ? (
                <p role="alert" className="text-danger">
                  {view.error}
                </p>
              ) : view.error ? (
                <p>{view.error}</p>
              ) : null}
            </>
          ) : null}
          {loadFailed ? (
            <p role="alert" className="text-danger">
              {t('loadFailed')}
            </p>
          ) : null}
          {actionFailed ? (
            <p role="alert" className="text-danger">
              {t('actionFailed')}
            </p>
          ) : null}
        </div>
        {models && canInstall ? (
          <Button
            variant="secondary"
            size="compact"
            type="button"
            disabled={busy}
            onClick={() => void run(() => models.installLocalAi())}
          >
            {view.state === 'stale' ? t('update') : t('install')}
          </Button>
        ) : models && installing ? (
          <Button
            variant="tertiary"
            size="compact"
            type="button"
            disabled={busy}
            onClick={() => void run(() => models.cancelLocalAiInstall())}
          >
            {t('cancel')}
          </Button>
        ) : null}
      </section>
      {models && view && view.state !== 'unsupported' ? (
        <ExternalJudgeSettings view={view} onView={setView} />
      ) : null}
    </>
  );
}

/** Which decision API to ask when the local judge abstains; keys live under Decision APIs. */
function ExternalJudgeSettings({
  view,
  onView,
}: {
  view: LocalAiView;
  onView(view: LocalAiView): void;
}) {
  const t = useTranslations('LocalAi');
  const names = useTranslations('DecisionApis');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const [apis, setApis] = useState<DecisionApiView[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const { external } = view;

  useEffect(() => {
    let mounted = true;
    void models?.decisionApis().then(
      (value) => {
        if (mounted) setApis(value);
      },
      () => {},
    );
    return () => {
      mounted = false;
    };
  }, [models]);

  if (!models) return null;
  const name = (id: DecisionApiView['id']) => names(`name.${id}`);
  // A chosen API whose key was removed stays visible so the setting is not silently changed.
  const offered = apis.filter((api) => api.keyConfigured || api.id === external.provider);
  const chosenWithoutKey = apis.some((api) => api.id === external.provider && !api.keyConfigured);
  const choose = async (mode: DecisionApiView['id'] | 'off') => {
    setBusy(true);
    setFailed(false);
    try {
      onView(await models.setExternalJudge(mode === 'off' ? null : mode, external.revision));
      // The reasoning switch saves the same config file; let it read the new revision.
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-row" aria-labelledby="local-ai-external-heading">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 id="local-ai-external-heading">{t('external.heading')}</h3>
        <p>{t('external.scope')}</p>
        {external.provider && chosenWithoutKey ? (
          <p>{t('external.chosenNoKey', { name: name(external.provider) })}</p>
        ) : offered.length === 0 ? (
          <p>{t('external.noKey')}</p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-danger">
            {t('external.saveFailed')}
          </p>
        ) : null}
      </div>
      <Select<DecisionApiView['id'] | 'off'>
        label={t('external.mode')}
        value={external.provider ?? 'off'}
        disabled={busy}
        onValueChange={(mode) => void choose(mode)}
        options={[
          { value: 'off', label: t('external.off') },
          ...offered.map((api) => ({
            value: api.id,
            label: t('external.ask', { name: name(api.id) }),
          })),
        ]}
      />
    </section>
  );
}
