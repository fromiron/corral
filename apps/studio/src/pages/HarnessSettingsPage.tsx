import type { HarnessPreview } from '@corral/client';
import type {
  HarnessDefault,
  HarnessProfile,
  HarnessProfileRevision,
  HarnessResource,
  HarnessResourceView,
} from '@corral/contracts';
import { WorkTool } from '@corral/contracts';
import { Button } from '@corral/react/ui';
import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useCurrentProject } from '../projects.ts';
import { useServices } from '../services.tsx';
import { SettingsLayout } from './SettingsPage.tsx';

const field = 'w-full rounded-md border border-line bg-surface p-2 text-sm';
const emptyProfile = (): HarnessProfile => ({
  name: '',
  policy: 'strict',
  allowedTools: [
    ...WorkTool.options,
    'read',
    'edit',
    'write',
    'submit_result',
    'spawn_subagents',
    'await_tasks',
    'ask',
    'reply',
    'read_artifact',
  ],
  resources: [],
  startupCommands: [],
});
const bindingOf = (profile: HarnessProfileRevision) => ({
  profileId: profile.profileId,
  revision: profile.revision,
});

export function HarnessPreviewView({ preview }: { preview: HarnessPreview }) {
  const t = useTranslations('Harness');
  return (
    <section
      data-testid="harness-preview"
      className="flex flex-col gap-3 border-t border-line pt-4"
    >
      <h3 className="font-semibold">{t('previewHeading')}</h3>
      <p className="text-sm">{t(preview.snapshot.policy)}</p>
      <dl className="text-xs">
        <dt className="font-medium">{t('layers')}</dt>
        {(preview.snapshot.layers ?? []).map((layer) => (
          <dd key={layer.scope}>
            {t(layer.scope)} · {layer.binding.profileId} · r{layer.binding.revision}
          </dd>
        ))}
      </dl>
      <p className="break-words text-xs text-muted">
        {preview.snapshot.allowedTools.join(', ') || t('noTools')}
      </p>
      {preview.snapshot.resources.map((resource) => (
        <p key={`${resource.hash}:${resource.entry}`} className="text-xs">
          {resource.skillName ?? resource.name} · {resource.version} ·{' '}
          {resource.skillMode ? t(resource.skillMode) : resource.kind}
        </p>
      ))}
      {preview.dynamic ? <p className="text-sm text-muted">{t('dynamic')}</p> : null}
      {preview.sections.length ? (
        preview.sections.map((section) => (
          <details key={section.name} open>
            <summary className="cursor-pointer text-sm">{section.name}</summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-subtle p-3 text-xs">
              {section.text}
            </pre>
          </details>
        ))
      ) : (
        <p className="text-sm text-muted">{t('noSections')}</p>
      )}
      <p className="break-all font-mono text-2xs text-muted">
        SHA-256 {preview.snapshot.snapshotHash}
      </p>
    </section>
  );
}

export function HarnessSettingsPage() {
  const t = useTranslations('Harness');
  const { harnesses: api } = useServices();
  const projectId = useCurrentProject();
  const id = useId();
  const [resources, setResources] = useState<HarnessResourceView[]>([]);
  const [profiles, setProfiles] = useState<HarnessProfileRevision[]>([]);
  const [defaults, setDefaults] = useState<HarnessDefault[]>([]);
  const [selected, setSelected] = useState<HarnessProfileRevision | null>(null);
  const [profile, setProfile] = useState<HarnessProfile>(emptyProfile);
  const [toolNames, setToolNames] = useState(emptyProfile().allowedTools.join(', '));
  const [commands, setCommands] = useState('');
  const [kind, setKind] = useState<'local' | 'package' | 'pi-home'>('local');
  const [source, setSource] = useState('');
  const [review, setReview] = useState<{ reviewId: string; resource: HarnessResource } | null>(
    null,
  );
  const [preview, setPreview] = useState<HarnessPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!api) return;
    let active = true;
    setError('');
    void Promise.all([
      api.resources(),
      api.profiles(),
      api.default('personal', 'default'),
      api.default('project', projectId),
    ]).then(
      ([r, p, personal, project]) => {
        if (active) {
          setResources(r);
          setProfiles(p);
          setDefaults([personal, project]);
        }
      },
      () => active && setError(t('loadFailed')),
    );
    return () => {
      active = false;
    };
  }, [api, projectId, t]);
  async function work(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('error'));
    } finally {
      setBusy(false);
    }
  }
  function choose(next: HarnessProfileRevision | null) {
    setSelected(next);
    setProfile(next ?? emptyProfile());
    setToolNames((next ?? emptyProfile()).allowedTools.join(', '));
    setCommands(next?.startupCommands.join('\n') ?? '');
    setPreview(null);
    setNotice('');
  }
  function selectResource(
    resourceHash: string,
    entry: string,
    selection: HarnessProfile['resources'][number] | null,
  ) {
    setProfile((current) => ({
      ...current,
      resources: [
        ...current.resources.filter((r) => r.resourceHash !== resourceHash || r.entry !== entry),
        ...(selection ? [selection] : []),
      ],
    }));
    setPreview(null);
  }
  const selectedKey = selected ? `${selected.profileId}:${selected.revision}` : '';
  return (
    <SettingsLayout active="harness">
      <main className="mx-auto flex max-w-3xl flex-col gap-7 p-6 sm:p-10">
        <div>
          <h2 className="text-2xl font-semibold">{t('heading')}</h2>
          <p className="mt-2 text-sm text-muted">{t('intro')}</p>
        </div>
        {!api ? (
          <p>{t('localOnly')}</p>
        ) : (
          <>
            {error ? (
              <p role="alert" className="rounded border border-danger/30 p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <p role="status" aria-live="polite" className="text-sm">
              {busy ? t('busy') : notice}
            </p>
            <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
              <legend className="mb-3 text-lg font-semibold">{t('resources')}</legend>
              <label className="flex flex-col gap-1 text-sm">
                {t('sourceKind')}
                <select
                  className={field}
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as typeof kind);
                    setReview(null);
                  }}
                >
                  <option value="local">{t('local')}</option>
                  <option value="package">{t('package')}</option>
                  <option value="pi-home">{t('piHome')}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t('source')}
                <input
                  disabled={kind === 'pi-home'}
                  className={field}
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value);
                    setReview(null);
                  }}
                  aria-describedby={`${id}-source-hint`}
                />
              </label>
              <p id={`${id}-source-hint`} className="text-xs text-muted">
                {kind === 'pi-home' ? t('piHomeHint', { folder: '~/.pi/agent' }) : t('sourceHint')}
              </p>
              <Button
                className="self-start"
                disabled={kind !== 'pi-home' && !source.trim()}
                onClick={() =>
                  void work(async () => {
                    setReview(await api.review(kind, source.trim()));
                    setSource('');
                  })
                }
              >
                {t('review')}
              </Button>
              {review ? (
                <section
                  className="flex flex-col gap-3 border-y border-line py-4"
                  aria-label={t('review')}
                >
                  <p className="font-medium">
                    {review.resource.name} · {review.resource.version}
                  </p>
                  <p className="text-xs text-muted">
                    {review.resource.license ?? t('unknownLicense')}
                  </p>
                  <p className="break-all font-mono text-2xs">SHA-256 {review.resource.hash}</p>
                  {review.resource.extensions.length ? (
                    <p className="text-sm text-warning">{t('nativeWarning')}</p>
                  ) : null}
                  <details>
                    <summary className="cursor-pointer text-sm">
                      {t('files', { count: review.resource.files.length })}
                    </summary>
                    <ul className="max-h-48 overflow-auto text-xs">
                      {review.resource.files.map((file) => (
                        <li key={file.path} className="break-all py-1">
                          {file.path} · {file.bytes} B · {file.hash.slice(0, 12)}
                        </li>
                      ))}
                    </ul>
                  </details>
                  <div className="flex gap-2">
                    <Button
                      onClick={() =>
                        void work(async () => {
                          await api.install(review.reviewId);
                          setResources(await api.resources());
                          setReview(null);
                        })
                      }
                    >
                      {t('install')}
                    </Button>
                    <Button variant="ghost" onClick={() => setReview(null)}>
                      {t('dismiss')}
                    </Button>
                  </div>
                </section>
              ) : null}
              {resources.length ? (
                <ul className="divide-y divide-line">
                  {resources.map((resource) => (
                    <li
                      key={resource.hash}
                      data-testid={`resource-${resource.name}`}
                      className="flex flex-col gap-2 py-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {resource.name} · {resource.version}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void work(async () => {
                              await api.trust(resource.hash, !resource.trustedAt);
                              setResources(await api.resources());
                              setPreview(null);
                            })
                          }
                        >
                          {resource.trustedAt ? t('revoke') : t('trust')}
                        </Button>
                      </div>
                      <p className="text-xs text-muted">
                        {resource.trustedAt ? t('trusted') : t('untrusted')} ·{' '}
                        {resource.license ?? t('unknownLicense')}
                      </p>
                      {resource.extensions.length ? (
                        <p className="text-xs text-warning">{t('nativeWarning')}</p>
                      ) : null}
                      <p className="break-all font-mono text-2xs text-muted">{resource.hash}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{t('noResources')}</p>
              )}
            </fieldset>
            <fieldset
              disabled={busy}
              className="flex min-w-0 flex-col gap-4 border-t border-line pt-5"
            >
              <legend className="px-1 text-lg font-semibold">{t('heading')}</legend>
              <label className="flex flex-col gap-1 text-sm">
                {t('profile')}
                <select
                  className={field}
                  aria-label={t('profile')}
                  value={selectedKey}
                  onChange={(e) =>
                    choose(
                      profiles.find((p) => `${p.profileId}:${p.revision}` === e.target.value) ??
                        null,
                    )
                  }
                >
                  <option value="">{t('newProfile')}</option>
                  {profiles.map((p) => (
                    <option key={p.profileId} value={`${p.profileId}:${p.revision}`}>
                      {p.name} · r{p.revision}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t('name')}
                <input
                  className={field}
                  value={profile.name}
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t('policy')}
                <select
                  className={field}
                  value={profile.policy}
                  onChange={(e) => {
                    setProfile({ ...profile, policy: e.target.value as HarnessProfile['policy'] });
                    setPreview(null);
                  }}
                >
                  <option value="strict">{t('strict')}</option>
                  <option value="trusted-native">{t('trusted-native')}</option>
                </select>
              </label>
              {profile.policy === 'trusted-native' ? (
                <p className="text-sm text-warning">{t('nativeWarning')}</p>
              ) : null}
              {resources.map((resource) => (
                <div key={resource.hash} className="flex flex-col gap-3 border-t border-line pt-3">
                  <p className="text-sm font-medium">
                    {resource.name} · {resource.version} ·{' '}
                    {resource.trustedAt ? t('trusted') : t('untrusted')}
                  </p>
                  {resource.skills.map((skill) => {
                    const selection = profile.resources.find(
                      (r) => r.resourceHash === resource.hash && r.entry === skill.entry,
                    );
                    return (
                      <div key={skill.entry} className="flex flex-col gap-1">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!!selection}
                            disabled={!selection && !resource.trustedAt}
                            onChange={(e) =>
                              selectResource(
                                resource.hash,
                                skill.entry,
                                e.target.checked
                                  ? {
                                      resourceHash: resource.hash,
                                      entry: skill.entry,
                                      kind: 'skill',
                                      required: false,
                                      skillMode: 'auto',
                                    }
                                  : null,
                              )
                            }
                          />
                          {t('useSkill', { name: skill.name })}
                        </label>
                        <p className="text-xs text-muted">{skill.description}</p>
                        {selection ? (
                          <select
                            aria-label={t('skillMode', { name: skill.name })}
                            className={field}
                            value={selection.skillMode ?? 'auto'}
                            onChange={(e) =>
                              selectResource(resource.hash, skill.entry, {
                                ...selection,
                                skillMode: e.target.value as 'auto' | 'explicit' | 'mandatory',
                              })
                            }
                          >
                            {(['auto', 'explicit', 'mandatory'] as const).map((mode) => (
                              <option key={mode} value={mode}>
                                {t(mode)}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </div>
                    );
                  })}
                  {resource.extensions.map((entry) => {
                    const selection = profile.resources.find(
                      (r) => r.resourceHash === resource.hash && r.entry === entry,
                    );
                    return (
                      <div key={entry} className="flex flex-col gap-1">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!!selection}
                            disabled={
                              !selection && (!resource.trustedAt || profile.policy === 'strict')
                            }
                            onChange={(e) =>
                              selectResource(
                                resource.hash,
                                entry,
                                e.target.checked
                                  ? {
                                      resourceHash: resource.hash,
                                      entry,
                                      kind: 'extension',
                                      required: true,
                                    }
                                  : null,
                              )
                            }
                          />
                          {t('useExtension', { name: entry })}
                        </label>
                        {selection ? (
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={selection.required}
                              onChange={(e) =>
                                selectResource(resource.hash, entry, {
                                  ...selection,
                                  required: e.target.checked,
                                })
                              }
                            />
                            {t('required', { name: entry })}
                          </label>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
              <p className="text-xs text-muted">{t('skillScripts')}</p>
              <details>
                <summary className="cursor-pointer text-sm">{t('allowedTools')}</summary>
                <label className="mt-2 flex flex-col gap-1 text-sm">
                  {t('allowedTools')}
                  <textarea
                    className={field}
                    value={toolNames}
                    onChange={(e) => setToolNames(e.target.value)}
                    rows={3}
                  />
                </label>
                <p className="text-xs text-muted">{t('toolsHint')}</p>
              </details>
              <label className="flex flex-col gap-1 text-sm">
                {t('commands')}
                <textarea
                  className={field}
                  value={commands}
                  onChange={(e) => setCommands(e.target.value)}
                  rows={2}
                />
              </label>
              <p className="text-xs text-muted">{t('commandsHint')}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!profile.name.trim()}
                  onClick={() =>
                    void work(async () => {
                      const saved = await api.save(
                        selected?.profileId ?? `harness_${crypto.randomUUID().replaceAll('-', '')}`,
                        selected?.revision ?? 0,
                        {
                          name: profile.name,
                          policy: profile.policy,
                          resources: profile.resources,
                          allowedTools: [...new Set(toolNames.split(/[\s,]+/).filter(Boolean))],
                          startupCommands: commands
                            .split('\n')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        },
                      );
                      setProfiles(await api.profiles());
                      choose(saved);
                      setNotice(t('saved', { revision: saved.revision }));
                      window.dispatchEvent(new Event('corral:harness-changed'));
                    })
                  }
                >
                  {t('save')}
                </Button>
                <Button
                  variant="outline"
                  disabled={!selected}
                  onClick={() =>
                    selected &&
                    void work(async () =>
                      setPreview(await api.preview(bindingOf(selected), projectId)),
                    )
                  }
                >
                  {t('preview')}
                </Button>
              </div>
              {preview ? <HarnessPreviewView preview={preview} /> : null}
            </fieldset>
            <fieldset disabled={busy} className="flex flex-col gap-3 border-t border-line pt-5">
              <legend className="px-1 text-lg font-semibold">{t('defaults')}</legend>
              <p className="text-xs text-muted">{t('defaultsHint')}</p>
              {defaults.map((value) => (
                <label
                  key={`${value.scope}:${value.scopeId}`}
                  className="flex flex-col gap-1 text-sm"
                >
                  {t(value.scope)}
                  <select
                    className={field}
                    value={
                      value.binding ? `${value.binding.profileId}:${value.binding.revision}` : ''
                    }
                    onChange={(e) =>
                      void work(async () => {
                        const picked = profiles.find(
                          (p) => `${p.profileId}:${p.revision}` === e.target.value,
                        );
                        const saved = await api.setDefault(
                          value,
                          picked ? bindingOf(picked) : null,
                        );
                        setDefaults((current) =>
                          current.map((d) => (d.scope === saved.scope ? saved : d)),
                        );
                        setPreview(null);
                        setNotice(t('defaultSaved'));
                      })
                    }
                  >
                    <option value="">{t('none')}</option>
                    {value.binding &&
                    !profiles.some(
                      (p) =>
                        p.profileId === value.binding?.profileId &&
                        p.revision === value.binding.revision,
                    ) ? (
                      <option value={`${value.binding.profileId}:${value.binding.revision}`}>
                        {value.binding.profileId} · r{value.binding.revision}
                      </option>
                    ) : null}
                    {profiles.map((p) => (
                      <option key={p.profileId} value={`${p.profileId}:${p.revision}`}>
                        {p.name} · r{p.revision}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
          </>
        )}
      </main>
    </SettingsLayout>
  );
}
