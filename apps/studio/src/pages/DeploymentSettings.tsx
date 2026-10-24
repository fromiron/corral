import type { HarnessApi } from '@corral/client';
import { type ProjectToolConfigRevision, RegisteredDeployment } from '@corral/contracts';
import { Button, Input, Textarea } from '@corral/react/design-kit';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { projectToolValues } from './projectToolValues.ts';

const empty = {
  id: '',
  name: '',
  environment: '',
  argv: '',
  readbackArgv: '',
  envRefs: '',
  seconds: '300',
};
export function DeploymentSettings({
  api,
  projectId,
  config,
  onChange,
}: {
  api: HarnessApi;
  projectId: string;
  config: ProjectToolConfigRevision | null;
  onChange(config: ProjectToolConfigRevision): void;
}) {
  const t = useTranslations('Deployment');
  const [draft, setDraft] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const run = useSettingsTask(`project-deployments:${projectId}`);
  useSettingsForm({
    dirty: JSON.stringify(draft) !== JSON.stringify(empty),
    pending: busy,
    save: saveDraft,
  });
  async function work(action: () => Promise<void>) {
    if (busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run(action);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save(deployments: RegisteredDeployment[]) {
    const next = await api.saveProjectTools(projectId, config?.revision ?? 0, {
      ...projectToolValues(config),
      deployments,
    });
    onChange(next);
    setDraft(empty);
    setEditing(null);
    setNotice(t('saved'));
  }
  async function saveDraft() {
    return work(async () => {
      const parsed = RegisteredDeployment.safeParse({
        id: draft.id.trim(),
        name: draft.name,
        environment: draft.environment.trim(),
        argv: draft.argv.split('\n').map((value) => value.trim()),
        readbackArgv: draft.readbackArgv.split('\n').map((value) => value.trim()),
        envRefs: draft.envRefs.split(/[\s,]+/).filter(Boolean),
        timeoutMs: Number(draft.seconds) * 1000,
      });
      if (!parsed.success) throw new Error(t('invalid'));
      if (!editing && config?.deployments?.some((item) => item.id === parsed.data.id))
        throw new Error(t('duplicate'));
      await save([
        ...(config?.deployments ?? []).filter((item) => item.id !== editing),
        parsed.data,
      ]);
    });
  }
  return (
    <section className="flex flex-col gap-3" aria-label={t('settingsTitle')}>
      <h4 className="font-medium">{t('settingsTitle')}</h4>
      <p className="text-xs text-muted-foreground">{t('settingsHint')}</p>
      {(config?.deployments ?? []).map((profile) => (
        <div key={profile.id} className="settings-surface flex flex-col gap-2">
          <p className="text-sm font-medium">
            {profile.name} · {profile.environment}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="tertiary"
              disabled={busy}
              onClick={() => {
                setEditing(profile.id);
                setDraft({
                  id: profile.id,
                  name: profile.name,
                  environment: profile.environment,
                  argv: profile.argv.join('\n'),
                  readbackArgv: profile.readbackArgv.join('\n'),
                  envRefs: profile.envRefs.join(', '),
                  seconds: String(profile.timeoutMs / 1000),
                });
              }}
            >
              {t('edit')}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void work(() =>
                  save((config?.deployments ?? []).filter((item) => item.id !== profile.id)),
                )
              }
            >
              {t('remove')}
            </Button>
          </div>
        </div>
      ))}
      <fieldset disabled={busy} className="settings-surface flex flex-col gap-3">
        <legend className="mb-3 font-medium">{t('configure')}</legend>
        {(['id', 'name', 'environment', 'envRefs'] as const).map((key) => (
          <label key={key} className="flex flex-col gap-1 text-sm">
            {t(key)}
            <Input
              name={key}
              value={draft[key]}
              disabled={key === 'id' && editing !== null}
              onChange={(event) => setDraft((draft) => ({ ...draft, [key]: event.target.value }))}
            />
          </label>
        ))}
        <p className="text-xs text-muted-foreground">{t('envHint')}</p>
        {(['argv', 'readbackArgv'] as const).map((key) => (
          <label key={key} className="flex flex-col gap-1 text-sm">
            {t(key)}
            <Textarea
              rows={3}
              value={draft[key]}
              onChange={(event) => setDraft((draft) => ({ ...draft, [key]: event.target.value }))}
            />
          </label>
        ))}
        <p className="text-xs text-muted-foreground">{t('argvHint')}</p>
        <p className="text-xs text-muted-foreground">{t('readbackHint')}</p>
        <label className="flex flex-col gap-1 text-sm">
          {t('timeout')}
          <Input
            type="number"
            min={1}
            max={1800}
            value={draft.seconds}
            onChange={(event) => setDraft((draft) => ({ ...draft, seconds: event.target.value }))}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              !draft.id.trim() ||
              !draft.name.trim() ||
              !draft.environment.trim() ||
              !draft.argv.trim() ||
              !draft.readbackArgv.trim()
            }
            onClick={() => void saveDraft()}
          >
            {t('save')}
          </Button>
          {editing || JSON.stringify(draft) !== JSON.stringify(empty) ? (
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(empty);
                setEditing(null);
              }}
            >
              {t('cancel')}
            </Button>
          ) : null}
        </div>
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
