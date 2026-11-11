import type { ModelImportPreview, ModelImportSource } from '@corral/client';
import {
  Button,
  Checkbox,
  InputField,
  InputGroup,
  TabItem,
  Tabs,
  TabsList,
} from '@corral/react/design-kit';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useModelSettingsRefresh } from '../workbench/modelSettings.tsx';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';

const SOURCES: { value: ModelImportSource; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'pi', label: 'Pi' },
];

/**
 * Another tool's model settings, previewed then imported: a face of the add-connection dialog.
 * Commands, environment references and OAuth tokens never cross over.
 */
export function ModelImportPanel() {
  const t = useTranslations('ModelImport');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const [source, setSource] = useState<ModelImportSource>('claude-code');
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<ModelImportPreview | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [copyKeys, setCopyKeys] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runSettingsTask = useSettingsTask('models-import');
  useSettingsForm({ dirty: Boolean(path || preview), pending: busy });
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await runSettingsTask(action);
    } catch (error) {
      setError(error instanceof Error ? error.message : t('failed'));
    } finally {
      setBusy(false);
    }
  }
  const reset = () => {
    setPreview(null);
    setSelected({});
    setCopyKeys({});
  };
  const choices = preview?.candidates.filter((candidate) => selected[candidate.id]) ?? [];
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-3"
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
        <Tabs
          value={source}
          onValueChange={(value) => {
            setSource(value as ModelImportSource);
            reset();
          }}
          size="compact"
          className="min-w-0 overflow-x-auto"
        >
          <TabsList aria-label={t('source')} className="w-max">
            {SOURCES.map((item) => (
              <TabItem key={item.value} value={item.value} label={item.label} disabled={busy} />
            ))}
          </TabsList>
        </Tabs>
        <InputGroup className="w-full">
          <InputField
            index={0}
            label={t('path')}
            value={path}
            disabled={busy}
            placeholder={t('defaultPath')}
            autoComplete="off"
            spellCheck={false}
            onChange={(value) => {
              setPath(value);
              setPreview(null);
            }}
          />
        </InputGroup>
        {/* What never crosses over from the other tool, before anything is read. */}
        <p className="m-0 text-caption text-muted-foreground">{t('excluded')}</p>
        <Button type="submit" variant="tertiary" disabled={busy} className="self-start">
          {t('preview')}
        </Button>
      </form>
      {preview ? (
        <div className="flex flex-col gap-2">
          {!preview.candidates.length ? (
            <p role="status" className="m-0 text-body text-muted-foreground">
              {t('empty')}
            </p>
          ) : null}
          {preview.candidates.map((candidate) => (
            <div
              key={candidate.id}
              className="flex flex-col gap-1 border-t border-border pt-2 text-body"
            >
              <Checkbox
                label={`${candidate.provider} / ${candidate.model} — ${t(candidate.change)}`}
                disabled={busy || !candidate.supported}
                checked={Boolean(selected[candidate.id])}
                onToggle={() =>
                  setSelected((value) => ({ ...value, [candidate.id]: !value[candidate.id] }))
                }
              />
              {candidate.previous ? (
                <p className="m-0 text-caption text-muted-foreground">
                  {t('previous', {
                    model: `${candidate.previous.provider} / ${candidate.previous.model}`,
                    endpoint: candidate.previous.endpoint ?? '—',
                  })}
                </p>
              ) : null}
              {candidate.endpoint ? (
                <p className="m-0 break-all font-mono text-caption text-muted-foreground">
                  {candidate.endpoint}
                </p>
              ) : null}
              {candidate.reason ? (
                <p className="m-0 text-caption text-muted-foreground">{candidate.reason}</p>
              ) : null}
              {candidate.warnings.map((warning) => (
                <p key={warning} className="m-0 text-caption text-warning">
                  {warning}
                </p>
              ))}
              {candidate.hasKey ? (
                <Checkbox
                  label={t('copyKey')}
                  disabled={busy || !selected[candidate.id]}
                  checked={Boolean(copyKeys[candidate.id])}
                  onToggle={() =>
                    setCopyKeys((value) => ({ ...value, [candidate.id]: !value[candidate.id] }))
                  }
                />
              ) : null}
            </div>
          ))}
          {preview.candidates.length ? (
            <Button
              className="self-end"
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
                  reset();
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
      {message ? (
        <p role="status" className="m-0 text-body">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-body text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
