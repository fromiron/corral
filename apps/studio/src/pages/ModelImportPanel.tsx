import type { ModelCatalogMetadata, ModelImportPreview, ModelImportSource } from '@corral/client';
import { Button, Select } from '@corral/react/ui';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useModelSettingsRefresh } from '../workbench/modelSettings.tsx';

export function ModelImportPanel() {
  const t = useTranslations('ModelImport');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const heading = useId();
  const [source, setSource] = useState<ModelImportSource>('claude-code');
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<ModelImportPreview | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [copyKeys, setCopyKeys] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<ModelCatalogMetadata | null>(null);
  const [catalogVisible, setCatalogVisible] = useState(false);
  const [query, setQuery] = useState('');
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : t('failed'));
    } finally {
      setBusy(false);
    }
  }
  const choices = preview?.candidates.filter((candidate) => selected[candidate.id]) ?? [];
  const matches =
    metadata?.models.filter((model) =>
      `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  return (
    <section aria-labelledby={heading} className="settings-surface flex flex-col gap-3">
      <h3 id={heading} className="text-sm font-semibold">
        {t('heading')}
      </h3>
      <p className="text-sm text-muted">{t('intro')}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            if (!models) return;
            const result = await models.importPreview(source, path.trim() || undefined);
            setPreview(result);
            setSelected({});
            setCopyKeys({});
          });
        }}
      >
        <div className="flex flex-col gap-1 text-sm">
          <span>{t('source')}</span>
          <Select
            label={t('source')}
            value={source}
            disabled={busy}
            onValueChange={(value) => {
              setSource(value);
              setPreview(null);
              setSelected({});
              setCopyKeys({});
            }}
            options={[
              { value: 'claude-code', label: 'Claude Code' },
              { value: 'codex', label: 'Codex' },
              { value: 'opencode', label: 'OpenCode' },
              { value: 'pi', label: 'Pi' },
            ]}
          />
        </div>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          {t('path')}
          <input
            className="min-w-0 rounded border border-line bg-surface px-2 py-1.5"
            value={path}
            disabled={busy}
            placeholder={t('defaultPath')}
            onChange={(event) => {
              setPath(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <Button type="submit" variant="outline" size="sm" disabled={busy}>
          {t('preview')}
        </Button>
      </form>
      {preview ? (
        <div className="flex flex-col gap-3">
          {!preview.candidates.length ? (
            <p role="status" className="text-sm text-muted">
              {t('empty')}
            </p>
          ) : null}
          {preview.candidates.map((candidate) => (
            <div
              key={candidate.id}
              className="flex flex-col gap-1 border-t border-line pt-2 text-sm"
            >
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  disabled={busy || !candidate.supported}
                  checked={Boolean(selected[candidate.id])}
                  onChange={(event) =>
                    setSelected((value) => ({ ...value, [candidate.id]: event.target.checked }))
                  }
                />
                <span className="min-w-0 break-words">
                  {candidate.provider} / {candidate.model}{' '}
                  <span className="text-muted">— {t(candidate.change)}</span>
                </span>
              </label>
              {candidate.previous ? (
                <p className="text-xs text-muted">
                  {t('previous', {
                    model: `${candidate.previous.provider} / ${candidate.previous.model}`,
                    endpoint: candidate.previous.endpoint ?? '—',
                  })}
                </p>
              ) : null}
              {candidate.endpoint ? (
                <p className="break-all text-xs text-muted">{candidate.endpoint}</p>
              ) : null}
              {candidate.reason ? <p className="text-xs text-muted">{candidate.reason}</p> : null}
              {candidate.warnings.map((warning) => (
                <p key={warning} className="text-xs text-muted">
                  {warning}
                </p>
              ))}
              {candidate.hasKey ? (
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    disabled={busy || !selected[candidate.id]}
                    checked={Boolean(copyKeys[candidate.id])}
                    onChange={(event) =>
                      setCopyKeys((value) => ({ ...value, [candidate.id]: event.target.checked }))
                    }
                  />
                  {t('copyKey')}
                </label>
              ) : null}
            </div>
          ))}
          {preview.candidates.length ? (
            <Button
              className="self-start"
              size="sm"
              disabled={busy || !choices.length}
              onClick={() =>
                void act(async () => {
                  if (!models) return;
                  const result = await models.importCommit({
                    previewId: preview.previewId,
                    revision: preview.revision,
                    selected: choices.map((candidate) => ({
                      id: candidate.id,
                      copyKey: Boolean(copyKeys[candidate.id]),
                    })),
                  });
                  setPreview(null);
                  setSelected({});
                  setCopyKeys({});
                  setMessage(result.keyFailures.length ? t('keyFailure') : t('saved'));
                  await refresh();
                })
              }
            >
              {t('commit', { count: choices.length })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              setMetadata((await models?.catalogMetadata()) ?? null);
              setCatalogVisible(true);
            })
          }
        >
          {t('showCatalog')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              setMetadata((await models?.refreshCatalogMetadata()) ?? null);
              setCatalogVisible(true);
            })
          }
        >
          {t('refreshCatalog')}
        </Button>
      </div>
      {catalogVisible ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">{t('metadataOnly')}</p>
          <p className="text-xs text-muted">
            {metadata?.fetchedAt
              ? `${metadata.fetchedAt} · ${metadata.stale ? t('stale') : t('current')} · ${metadata.hash?.slice(0, 12)}`
              : t('noCache')}
          </p>
          {metadata?.error ? (
            <p role="status" className="text-xs text-muted">
              {metadata.error}
            </p>
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            {t('filter')}
            <input
              className="rounded border border-line bg-surface px-2 py-1.5"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th>{t('model')}</th>
                  <th>{t('context')}</th>
                  <th>{t('price')}</th>
                </tr>
              </thead>
              <tbody>
                {matches.slice(0, 100).map((model) => (
                  <tr key={`${model.provider}/${model.id}`}>
                    <td className="break-all py-1">
                      {model.provider} / {model.name}
                    </td>
                    <td>{model.contextWindow ?? '—'}</td>
                    <td>
                      {model.inputCost ?? '—'} / {model.outputCost ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {matches.length > 100 ? <p className="text-xs text-muted">{t('filterMore')}</p> : null}
        </div>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
