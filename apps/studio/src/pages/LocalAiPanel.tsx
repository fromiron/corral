import { ApiError, type LocalAiView } from '@corral/client';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
} from '@corral/react/design-kit';
import { useEffect, useId, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { formatDownload } from './download-size.ts';

const MB = 1_000_000;

/**
 * The meeting analysis model and runtime: the server downloads them when the person presses
 * Install, and this panel follows that install until it ends.
 */
export function LocalAiPanel({ pollMs = 1000 }: { pollMs?: number }) {
  const t = useTranslations('LocalAi');
  const format = useFormatter();
  const { models } = useServices();
  const [view, setView] = useState<LocalAiView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [refusal, setRefusal] = useState<
    'removeInstalling' | 'removeComputing' | 'removeFailed' | null
  >(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const downloadHint = useId();
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
    setRefusal(null);
    try {
      setView(await action());
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!models) return;
    setBusy(true);
    setActionFailed(false);
    setRefusal(null);
    try {
      setView(await models.removeLocalAi());
    } catch (error) {
      if (error instanceof ApiError && error.message === 'an install is in progress')
        setRefusal('removeInstalling');
      else if (error instanceof ApiError && error.message === 'a computation is in progress')
        setRefusal('removeComputing');
      else setRefusal('removeFailed');
    } finally {
      setBusy(false);
    }
  };
  const mb = (bytes: number) => format.number(Math.round(bytes / MB));
  const download =
    view?.downloadBytes == null
      ? null
      : formatDownload(view.downloadBytes, (value, options) => format.number(value, options));
  const canInstall = view && (view.state === 'missing' || view.state === 'stale');
  const canRemove =
    !!view &&
    view.state !== 'missing' &&
    view.state !== 'unsupported' &&
    view.state !== 'installing';

  return (
    <section className="settings-row" aria-labelledby="local-ai-heading">
      <div>
        <h3 id="local-ai-heading">{t('heading')}</h3>
        {view ? (
          <>
            <ul>
              <li>{t('model.meeting', { name: view.models.meeting })}</li>
            </ul>
            <p role="status">{t(`state.${view.state}`)}</p>
            {canInstall && download ? <p id={downloadHint}>{t('download', download)}</p> : null}
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
        {refusal ? (
          <p role="alert" className="text-danger">
            {t(refusal)}
          </p>
        ) : null}
      </div>
      {models && (canInstall || installing || canRemove) ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canInstall ? (
            <Button
              variant="secondary"
              size="compact"
              type="button"
              disabled={busy}
              aria-describedby={download ? downloadHint : undefined}
              onClick={() => void run(() => models.installLocalAi())}
            >
              {view.state === 'stale' ? t('update') : t('install')}
            </Button>
          ) : null}
          {installing ? (
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
          {canRemove ? (
            <Button
              variant="tertiary"
              size="compact"
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {t('remove')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogPopup className="p-6" showCloseButton={false}>
          <DialogTitle>{t('removeTitle')}</DialogTitle>
          <DialogDescription className="my-4">
            {t('removeConfirm', {
              size: download?.size ?? '0',
              unit: download?.unit ?? 'MB',
            })}
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" type="button" onClick={() => setConfirming(false)}>
              {t('removeDismiss')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirming(false);
                void remove();
              }}
            >
              {t('remove')}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
