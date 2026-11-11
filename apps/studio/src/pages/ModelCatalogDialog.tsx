import type { ModelCatalogMetadata } from '@corral/client';
import {
  Button,
  Dialog,
  DialogPopup,
  DialogTitle,
  fontWeights,
  InputField,
  InputGroup,
} from '@corral/react/design-kit';
import { Search, X } from '@corral/react/icons';
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

/** How many catalog rows show at once; the filter narrows the rest. */
const SHOWN = 100;

/**
 * The models.dev catalog the endpoints' limits can come from: reference prices and limits only,
 * opened from the Connections menu. `refresh` downloads it again first.
 */
export function ModelCatalogDialog({
  refresh,
  onClose,
}: {
  refresh: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('ModelImport');
  const tc = useTranslations('Connections');
  const ta = useTranslations('AddConnection');
  const format = useFormatter();
  const { models } = useServices();
  const [metadata, setMetadata] = useState<ModelCatalogMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let live = true;
    const read = refresh ? models?.refreshCatalogMetadata() : models?.catalogMetadata();
    void Promise.resolve(read)
      .then((value) => live && setMetadata(value ?? null))
      .catch(
        (failure) => live && setError(failure instanceof Error ? failure.message : t('failed')),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [models, refresh, t]);
  const q = query.trim().toLowerCase();
  const matches =
    metadata?.models.filter((model) =>
      `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(q),
    ) ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup
        data-settings-sheet
        size="lg"
        showCloseButton={false}
        className="flex flex-col gap-3"
      >
        <div className="flex items-center justify-between gap-3 pr-8">
          <DialogTitle>{tc('catalog')}</DialogTitle>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute right-3 top-3"
          aria-label={ta('close')}
          onClick={onClose}
        >
          <X aria-hidden />
        </Button>
        {loading ? (
          <p role="status" className="shimmer-text m-0 text-body text-muted-foreground">
            {refresh ? tc('refreshCatalog') : tc('catalog')}
          </p>
        ) : null}
        {error || metadata?.error ? (
          <p role="alert" className="m-0 text-caption text-danger">
            {error ?? metadata?.error}
          </p>
        ) : null}
        {!loading ? (
          <p className="m-0 text-caption text-muted-foreground">
            {metadata?.fetchedAt
              ? `${format.dateTime(new Date(metadata.fetchedAt), { dateStyle: 'medium', timeStyle: 'short' })} · ${metadata.stale ? t('stale') : t('current')}`
              : t('noCache')}
          </p>
        ) : null}
        {metadata?.models.length ? (
          <>
            <InputGroup className="w-full">
              <InputField
                index={0}
                label={t('filter')}
                labelHidden
                icon={Search}
                placeholder={t('filter')}
                value={query}
                onChange={setQuery}
                autoComplete="off"
              />
            </InputGroup>
            <div className="max-h-[50dvh] overflow-auto">
              <table className="w-full text-left text-caption">
                <thead
                  className="text-muted-foreground"
                  style={{ fontVariationSettings: fontWeights.normal }}
                >
                  <tr>
                    <th className="py-1 text-left">{t('model')}</th>
                    <th className="py-1 text-right">{t('context')}</th>
                    <th className="py-1 text-right">{t('price')}</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {matches.slice(0, SHOWN).map((model) => (
                    <tr key={`${model.provider}/${model.id}`} className="border-t border-border">
                      <td className="break-all py-1 pr-2">
                        <span className="text-muted-foreground">{model.provider} / </span>
                        {model.name}
                      </td>
                      <td className="py-1 text-right">
                        {model.contextWindow != null ? format.number(model.contextWindow) : '—'}
                      </td>
                      <td className="whitespace-nowrap py-1 pl-2 text-right">
                        {model.inputCost ?? '—'} / {model.outputCost ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {matches.length > SHOWN ? (
              <p className="m-0 text-caption text-muted-foreground">{t('filterMore')}</p>
            ) : null}
            <p className="m-0 text-caption text-muted-foreground">{t('metadataOnly')}</p>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
