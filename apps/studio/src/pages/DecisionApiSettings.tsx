import type { DecisionApiView } from '@corral/client';
import { Button } from '@corral/react/design-kit';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { ApiKeyInput } from './ApiKeyInput.tsx';

/**
 * Judge-only APIs and their keys, apart from model sign-ins. A key is sent once and never
 * loaded back; the server says only whether one is stored.
 */
export function DecisionApiSettings({
  onChanged,
}: {
  /** Called after a key is saved or removed, so the external judge choice can re-read. */
  onChanged(): void;
}) {
  const t = useTranslations('DecisionApis');
  const { models } = useServices();
  const [apis, setApis] = useState<DecisionApiView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    void models?.decisionApis().then(
      (value) => {
        if (mounted) setApis(value);
      },
      () => {
        if (mounted) setLoadFailed(true);
      },
    );
    return () => {
      mounted = false;
    };
  }, [models]);

  return (
    <section aria-labelledby="decision-apis-heading" className="flex flex-col gap-2">
      <h3 id="decision-apis-heading" className="text-sm font-semibold">
        {t('heading')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {loadFailed ? (
        <p role="alert" className="text-sm text-danger">
          {t('loadFailed')}
        </p>
      ) : null}
      {apis?.map((api) => (
        <DecisionApiCard
          key={api.id}
          api={api}
          onList={(next) => {
            setApis(next);
            onChanged();
          }}
        />
      ))}
    </section>
  );
}

function DecisionApiCard({
  api,
  onList,
}: {
  api: DecisionApiView;
  onList(apis: DecisionApiView[]): void;
}) {
  const t = useTranslations('DecisionApis');
  const { models } = useServices();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = t(`name.${api.id}`);
  const act = async (action: () => Promise<DecisionApiView[]>) => {
    setBusy(true);
    setFailed(false);
    try {
      onList(await action());
      setKey('');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const saveKey = (event: FormEvent) => {
    event.preventDefault();
    if (models && key.trim()) void act(() => models.setDecisionApiKey(api.id, key.trim()));
  };
  if (!models) return null;
  return (
    <article
      aria-label={name}
      className="settings-surface flex flex-col gap-3"
      data-decision-api={api.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">
          {name} <span className="font-mono text-xs text-muted-foreground">{api.model}</span>
        </h4>
        {api.keyConfigured ? (
          <Button
            variant="tertiary"
            size="compact"
            type="button"
            disabled={busy}
            onClick={() => void act(() => models.deleteDecisionApiKey(api.id))}
          >
            {t('removeKey')}
          </Button>
        ) : null}
      </div>
      <p role="status" className="text-sm">
        {api.keyConfigured ? t('keySaved') : t('noKey')}
      </p>
      <p className="text-xs text-muted-foreground">{t(`data.${api.id}`)}</p>
      {api.keyConfigured ? null : (
        <form onSubmit={saveKey} className="flex flex-col gap-1">
          <div className="flex items-end gap-2">
            <ApiKeyInput value={key} onChange={setKey} disabled={busy} />
            <Button variant="primary" type="submit" disabled={busy || !key.trim()}>
              {t('saveKey')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('keyHint')}</p>
        </form>
      )}
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          {t('saveFailed')}
        </p>
      ) : null}
    </article>
  );
}
