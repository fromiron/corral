import type {
  VaultApplyResult,
  VaultBindings,
  VaultDomain,
  VaultPreview,
  VaultStatus,
} from '@corral/client';
import { Button, Checkbox, Input, Select } from '@corral/react/design-kit';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useLocale } from '../locale.tsx';
import { projectName } from '../projects.ts';
import { useServices } from '../services.tsx';
import {
  applyPortablePreferences,
  portablePreferences,
} from '../workbench/portable-preferences.ts';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { SettingsLayout } from './SettingsPage.tsx';

type Choice = { value: string; label: string };
const inputClass = 'min-w-0';
export function VaultSettingsPage() {
  const t = useTranslations('Vault');
  const projectText = useTranslations('Projects');
  const defaultProjectName = projectText('defaultName');
  const { vault, repository, models } = useServices();
  const { locale, setLocale } = useLocale();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [password, setPassword] = useState('');
  const [selected, setSelected] = useState<VaultDomain[]>(['application', 'providers']);
  const [bindings, setBindings] = useState<VaultBindings>({});
  const [envelope, setEnvelope] = useState<unknown>(null);
  const [preview, setPreview] = useState<VaultPreview | null>(null);
  const [previewDirty, setPreviewDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [projects, setProjects] = useState<Choice[]>([]);
  const [teams, setTeams] = useState<Choice[]>([]);
  const [sessions, setSessions] = useState<Choice[]>([]);
  const [parents, setParents] = useState<Choice[]>([]);
  const [profiles, setProfiles] = useState<Choice[]>([]);
  const [keys, setKeys] = useState<Choice[]>([]);
  const [includeSecrets, setIncludeSecrets] = useState<string[]>([]);
  const [etag, setEtag] = useState<string | null>(null);
  const [s3, setS3] = useState({
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    key: 'corral-settings.json',
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
  });
  const projectId = bindings.subagents?.projectId ?? '';
  const teamId = bindings.subagents?.corralId ?? '';
  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    void Promise.all([
      vault.state(),
      repository.listProjects(),
      repository.list(),
      models?.profiles() ?? [],
      models?.auth() ?? [],
    ])
      .then(([state, projects, teams, profiles, providers]) => {
        if (cancelled) return;
        setStatus(state);
        setSelected((current) =>
          current.filter((domain) =>
            state.domains.some((item) => item.domain === domain && item.available),
          ),
        );
        setProjects(
          projects.map((project) => ({
            value: project.projectId,
            label: projectName(project, defaultProjectName),
          })),
        );
        setTeams(teams.map((team) => ({ value: team.corralId, label: team.name })));
        setProfiles(
          profiles
            .filter((profile) => profile.available)
            .map((profile) => ({
              value: profile.profileId,
              label: `${profile.profileId} · ${profile.modelId}`,
            })),
        );
        setKeys(
          providers
            .filter((provider) => provider.method === 'api_key' && provider.source === 'corral')
            .map((provider) => ({ value: provider.providerId, label: provider.name })),
        );
      })
      .catch(() => {
        if (!cancelled) setError(t('loadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [vault, repository, models, t, defaultProjectName]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      projectId ? repository.listSessions(projectId) : [],
      teamId ? repository.get(teamId) : null,
    ])
      .then(([sessions, team]) => {
        if (cancelled) return;
        setSessions(
          sessions.map((session) => ({ value: session.sessionId, label: session.title })),
        );
        setParents(
          team?.definition.nodes
            .filter((node) => node.type === 'agent' && node.invocation !== 'callable')
            .map((node) => ({ value: node.id, label: node.label })) ?? [],
        );
      })
      .catch(() => {
        if (!cancelled) setError(t('loadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [repository, projectId, teamId, t]);
  const capture = () => ({
    password,
    domains: selected,
    application: portablePreferences(locale),
    bindings,
    includeSecrets,
  });
  const runSettingsTask = useSettingsTask('vault');
  useSettingsForm({
    dirty: Boolean(preview || s3.secretAccessKey || s3.sessionToken),
    pending: busy,
  });
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await runSettingsTask(action);
    } catch (error) {
      setError(error instanceof Error ? error.message : t('failed'));
    } finally {
      if (vault) {
        try {
          setStatus(await vault.options(bindings));
        } catch {
          /* Keep the original operation error; retrying the page refreshes state. */
        }
      }
      setBusy(false);
    }
  }
  async function finish(result: VaultApplyResult) {
    if (!vault) return;
    if (result.application) {
      const readback = await applyPortablePreferences(
        result.application.target,
        result.application.expectedRevision,
        locale,
        setLocale,
      );
      result = await vault.acknowledge({ id: result.id, password, application: readback });
    }
    setMessage(t(result.status === 'rolled_back' ? 'rolledBack' : 'saved'));
  }
  function bind(domain: VaultDomain, key: string, value: string) {
    setBindings((current) => ({ ...current, [domain]: { ...current[domain], [key]: value } }));
    setPreview(null);
  }
  const canAct = Boolean(vault && password.length >= 12 && !busy);
  const pending = status && !['idle', 'committed', 'rolled_back'].includes(status.status);
  return (
    <SettingsLayout active="vault">
      <main className="settings-content">
        <h2 className="text-2xl font-semibold">{t('heading')}</h2>
        {!vault ? (
          <p className="text-sm text-muted-foreground">{t('serverOnly')}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('intro')}</p>
            <label className="flex flex-col gap-1 text-sm">
              {t('password')}
              <Input
                type="password"
                aria-describedby="vault-password-hint"
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
            </label>
            <p id="vault-password-hint" className="text-xs text-muted-foreground">
              {t('passwordHint')}
            </p>
            <section className="settings-surface flex flex-col gap-3" aria-label={t('scope')}>
              <h3 className="text-sm font-semibold">{t('scope')}</h3>
              <div className="flex flex-wrap gap-3">
                {status?.domains.map(({ domain, available }) => (
                  <Checkbox
                    key={domain}
                    label={available ? t(domain) : `${t(domain)} · ${t('needsBinding')}`}
                    checked={selected.includes(domain)}
                    disabled={busy || !available}
                    onToggle={() =>
                      setSelected((values) =>
                        values.includes(domain)
                          ? values.filter((value) => value !== domain)
                          : [...values, domain],
                      )
                    }
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Select
                  label={t('project')}
                  value={projectId || null}
                  placeholder={t('project')}
                  options={projects}
                  disabled={busy}
                  onValueChange={(value) => {
                    setBindings((current) => ({
                      ...current,
                      subagents: {
                        ...current.subagents,
                        projectId: value,
                        corralId: '',
                        parentNodeId: '',
                      },
                      mcp: { ...current.mcp, projectId: value },
                      skills: { ...current.skills, projectId: value },
                      plugins: { ...current.plugins, projectId: value },
                    }));
                    setPreview(null);
                  }}
                />
                <Select
                  label={t('team')}
                  value={teamId || null}
                  placeholder={t('team')}
                  options={teams}
                  disabled={busy}
                  onValueChange={(value) => bind('subagents', 'corralId', value)}
                />
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setStatus(await vault.options(bindings));
                    })
                  }
                >
                  {t('refreshBindings')}
                </Button>
              </div>
              {keys.length ? (
                <details>
                  <summary className="cursor-pointer text-sm">{t('secretOptions')}</summary>
                  <p className="my-2 text-xs text-muted-foreground">{t('secretHint')}</p>
                  {keys.map((key) => (
                    <Checkbox
                      key={key.value}
                      label={key.label}
                      checked={includeSecrets.includes(key.value)}
                      disabled={busy}
                      onToggle={() =>
                        setIncludeSecrets((values) =>
                          values.includes(key.value)
                            ? values.filter((id) => id !== key.value)
                            : [...values, key.value],
                        )
                      }
                    />
                  ))}
                </details>
              ) : null}
              <Button
                className="self-start"
                size="compact"
                disabled={!canAct || !selected.length}
                onClick={() =>
                  void act(async () => {
                    const result = await vault.capture(capture());
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(result.envelope)], { type: 'application/json' }),
                    );
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'corral-settings-vault.json';
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    setMessage(t('exported'));
                  })
                }
              >
                {t('export')}
              </Button>
            </section>
            <section className="settings-surface flex flex-col gap-3" aria-label={t('import')}>
              <h3 className="text-sm font-semibold">{t('import')}</h3>
              <label className="flex flex-col gap-1 text-sm">
                {t('file')}
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    void act(async () => {
                      if (file.size > 16 * 1024 * 1024) throw new Error(t('tooLarge'));
                      setEnvelope(JSON.parse(await file.text()));
                      setPreview(null);
                      setSelected([]);
                    });
                  }}
                />
              </label>
              <Button
                className="self-start"
                size="compact"
                variant="tertiary"
                disabled={!canAct || !envelope}
                onClick={() =>
                  void act(async () => {
                    setPreview(
                      await vault.preview({
                        envelope,
                        password,
                        application: portablePreferences(locale),
                        bindings,
                      }),
                    );
                    setPreviewDirty(false);
                    setSelected([]);
                  })
                }
              >
                {t('preview')}
              </Button>
              {preview?.entries.map((entry) => (
                <div key={entry.domain} className="border-t border-line pt-2">
                  <Checkbox
                    label={`${t(entry.domain)} · ${t(entry.changed ? 'changed' : 'unchanged')}`}
                    disabled={busy || !entry.available}
                    checked={selected.includes(entry.domain)}
                    onToggle={() =>
                      setSelected((values) =>
                        values.includes(entry.domain)
                          ? values.filter((domain) => domain !== entry.domain)
                          : [...values, entry.domain],
                      )
                    }
                  />
                  {entry.warnings.map((warning) => (
                    <p key={warning} className="mt-1 text-xs text-muted-foreground">
                      {warning}
                    </p>
                  ))}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {entry.fields.map((field) => {
                      const value = bindings[entry.domain]?.[field.key] ?? '';
                      const options =
                        field.kind === 'project'
                          ? projects
                          : field.kind === 'team'
                            ? teams
                            : field.kind === 'session'
                              ? sessions
                              : field.kind === 'parent'
                                ? parents
                                : field.kind === 'model'
                                  ? profiles
                                  : null;
                      return options ? (
                        <Select
                          key={field.key}
                          label={field.label}
                          placeholder={field.label}
                          value={value || null}
                          options={options}
                          disabled={busy}
                          onValueChange={(value) => {
                            setPreviewDirty(true);
                            setBindings((current) => ({
                              ...current,
                              [entry.domain]: { ...current[entry.domain], [field.key]: value },
                            }));
                          }}
                        />
                      ) : (
                        <label key={field.key} className="flex flex-col gap-1 text-xs">
                          {field.label}
                          <Input
                            value={value}
                            disabled={busy}
                            onChange={(event) => {
                              setPreviewDirty(true);
                              setBindings((current) => ({
                                ...current,
                                [entry.domain]: {
                                  ...current[entry.domain],
                                  [field.key]: event.target.value,
                                },
                              }));
                            }}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
              {preview ? (
                <Button
                  className="self-start"
                  size="compact"
                  disabled={!canAct || !selected.length || Boolean(pending) || previewDirty}
                  onClick={() =>
                    void act(async () => {
                      await finish(
                        await vault.apply({
                          previewId: preview.previewId,
                          domains: selected,
                          password,
                        }),
                      );
                      setPreview(null);
                    })
                  }
                >
                  {t('apply', { count: selected.length })}
                </Button>
              ) : null}
            </section>
            {pending ? (
              <section className="settings-surface flex flex-col gap-2" aria-label={t('recovery')}>
                <h3 className="text-sm font-semibold">{t('recovery')}</h3>
                <p className="text-sm text-muted-foreground">{t('recoveryHint')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="compact"
                    disabled={!canAct}
                    onClick={() =>
                      void act(async () => {
                        await finish(await vault.pending(password));
                      })
                    }
                  >
                    {t('resume')}
                  </Button>
                  <Button
                    size="compact"
                    variant="tertiary"
                    disabled={!canAct}
                    onClick={() =>
                      void act(async () => {
                        await finish(await vault.rollback(password));
                      })
                    }
                  >
                    {t('rollback')}
                  </Button>
                </div>
              </section>
            ) : null}
            <details className="settings-surface">
              <summary className="cursor-pointer text-sm font-semibold">{t('s3')}</summary>
              <p className="my-2 text-xs text-muted-foreground">{t('s3Hint')}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    'endpoint',
                    'region',
                    'bucket',
                    'key',
                    'accessKeyId',
                    'secretAccessKey',
                    'sessionToken',
                  ] as const
                ).map((key) => (
                  <label key={key} className="flex flex-col gap-1 text-xs">
                    {t(key)}
                    <Input
                      type={
                        key === 'secretAccessKey' || key === 'sessionToken' ? 'password' : 'text'
                      }
                      autoComplete="off"
                      value={s3[key]}
                      disabled={busy}
                      onChange={(event) =>
                        setS3((value) => ({ ...value, [key]: event.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={
                    !canAct || !s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey
                  }
                  onClick={() =>
                    void act(async () => {
                      await vault.saveConnection({
                        password,
                        config: {
                          endpoint: s3.endpoint,
                          region: s3.region,
                          bucket: s3.bucket,
                          key: s3.key,
                        },
                        credentials: {
                          accessKeyId: s3.accessKeyId,
                          secretAccessKey: s3.secretAccessKey,
                          ...(s3.sessionToken ? { sessionToken: s3.sessionToken } : {}),
                        },
                      });
                      setS3((value) => ({
                        ...value,
                        accessKeyId: '',
                        secretAccessKey: '',
                        sessionToken: '',
                      }));
                      setEtag(null);
                      setMessage(t('connectionSaved'));
                    })
                  }
                >
                  {t('saveConnection')}
                </Button>
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={!canAct || !status?.s3Configured}
                  onClick={() =>
                    void act(async () => {
                      const result = await vault.download(password);
                      setEtag(result.etag);
                      setEnvelope(result.envelope);
                      setPreview(null);
                      setSelected([]);
                      setMessage(t(result.envelope ? 'downloaded' : 'remoteEmpty'));
                    })
                  }
                >
                  {t('download')}
                </Button>
                <Button
                  size="compact"
                  disabled={!canAct || !status?.s3Configured || !selected.length}
                  onClick={() =>
                    void act(async () => {
                      const result = await vault.upload({ ...capture(), expectedEtag: etag });
                      setEtag(result.etag);
                      setMessage(t('uploaded'));
                    })
                  }
                >
                  {t('upload')}
                </Button>
              </div>
              {etag ? (
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  {t('remoteRevision', { revision: etag })}
                </p>
              ) : null}
            </details>
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
          </>
        )}
      </main>
    </SettingsLayout>
  );
}
