import type { HarnessPreview } from '@corral/client';
import type {
  HarnessEntryView,
  HarnessProfile,
  HarnessProfileRevision,
  HarnessProfileView,
  HarnessResourceView,
  ProjectToolConfigRevision,
} from '@corral/contracts';
import { canonicalJson, WorkTool } from '@corral/contracts';
import { toolDescriptorHash } from '@corral/core';
import { Button, Select } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useManagementConfirmation } from '../workbench/harness/ConfirmAction.tsx';
import { PermissionPolicyEditor } from '../workbench/harness/PermissionPolicyEditor.tsx';
import { updateResourceSelection } from '../workbench/harness/selection.ts';
import { operationId, profileInput } from '../workbench/harness/Target.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import {
  useSettingsCommand,
  useSettingsForm,
  useSettingsTask,
} from '../workbench/SettingsLifecycle.tsx';
import { SettingsProjectPicker } from '../workbench/SettingsNavigation.tsx';
import { HarnessMcpTools } from './HarnessMcpTools.tsx';
import { SettingsLayout } from './SettingsPage.tsx';

const field = 'settings-field';
const emptyProfile = (): HarnessProfile => ({
  name: '',
  policy: 'strict',
  allowedTools: [
    ...WorkTool.options,
    'read',
    'edit',
    'write',
    'run_check',
    'lsp_query',
    'submit_result',
    'spawn_subagents',
    'await_tasks',
    'ask',
    'ask_user',
    'update_plan',
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
    <section data-testid="harness-preview" className="settings-surface flex flex-col gap-3">
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
      {preview.snapshot.tools.length ? (
        <details>
          <summary className="cursor-pointer text-sm">
            {t('staticTools', { count: preview.snapshot.tools.length })}
          </summary>
          <p className="my-2 text-xs text-muted">{t('staticToolsHint')}</p>
          <ul className="flex flex-col gap-2 text-xs">
            {preview.snapshot.tools.map((tool) => (
              <li key={tool.name}>
                <span className="font-mono">{tool.name}</span> · {tool.source} ·{' '}
                {t(`toolEffects.${tool.sideEffect}`)}
                <p className="break-all font-mono text-2xs text-muted">
                  {t('toolSchema', { hash: tool.schemaHash })}
                  <br />
                  {t('permissionDescriptor')}: {toolDescriptorHash(tool)}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
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
      {preview.snapshot.projectTools ? (
        <p className="text-xs">
          {t('selectedChecks', {
            revision: preview.snapshot.projectTools.revision,
            ids: preview.snapshot.projectTools.checkIds.join(', ') || '—',
          })}
          <br />
          {t('selectedLsp', { ids: preview.snapshot.projectTools.lspServerIds.join(', ') || '—' })}
          <br />
          {t('selectedMcp', { ids: preview.snapshot.projectTools.mcpServerIds?.join(', ') || '—' })}
        </p>
      ) : null}
    </section>
  );
}

export function HarnessSettingsPage() {
  const { projectId } = useSettingsNavigation();
  return <HarnessSettingsEditor projectId={projectId} />;
}

function HarnessSettingsEditor({ projectId }: { projectId: string | undefined }) {
  const t = useTranslations('Harness'),
    r = useTranslations('Resources');
  const n = useTranslations('Navigation');
  const navigation = useSettingsNavigation();
  const { harnesses: api } = useServices();
  const [resources, setResources] = useState<HarnessResourceView[]>([]);
  const [profiles, setProfiles] = useState<HarnessProfileView[]>([]);
  const [entries, setEntries] = useState<HarnessEntryView[]>([]);
  const [search, setSearch] = useState(''),
    [archived, setArchived] = useState(false);
  const [toolsState, setToolsState] = useState<{
    projectId: string | undefined;
    value: ProjectToolConfigRevision | null;
  } | null>(null);
  const projectTools = toolsState && toolsState.projectId === projectId ? toolsState.value : null;
  const [selected, setSelected] = useState<HarnessProfileRevision | null>(null);
  const pendingOperation = useSettingsCommand<{ json: string; id: string }>(
    `harness-publish:${selected?.profileId ?? 'new'}`,
  );
  const [profile, setProfile] = useState<HarnessProfile>(emptyProfile);
  const [toolNames, setToolNames] = useState(emptyProfile().allowedTools.join(', '));
  const [commands, setCommands] = useState('');
  const [previewState, setPreviewState] = useState<{
    projectId: string | undefined;
    value: HarnessPreview;
  } | null>(null);
  const preview = previewState?.projectId === projectId ? (previewState?.value ?? null) : null;
  const setPreview = (value: HarnessPreview | null) =>
    setPreviewState(value ? { projectId, value } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const confirmation = useManagementConfirmation();
  const [refreshFailed, setRefreshFailed] = useState(false);
  useEffect(() => {
    if (!api) return;
    let active = true;
    setError('');
    void Promise.all([
      api.resources(),
      api.profileManagement(),
      projectId ? api.projectTools(projectId) : null,
      api.entries(),
    ]).then(
      ([r, p, tools, entries]) => {
        if (active) {
          setResources(r);
          setEntries(entries);
          setProfiles(p);
          setToolsState({ projectId, value: tools });
        }
      },
      () => active && setError(t('loadFailed')),
    );
    return () => {
      active = false;
    };
  }, [api, projectId, t]);
  const runSettingsTask = useSettingsTask(`harness:${selected?.profileId ?? 'new'}`);
  async function work(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await runSettingsTask(task);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t('error'));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function choose(next: HarnessProfileRevision | null, saved = false) {
    if (!saved && !(await confirmLeave())) return;
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
    const key = { resourceHash, entry, kind: selection?.kind ?? ('skill' as const) };
    const skillName = resources
      .find((value) => value.hash === resourceHash)
      ?.skills.find((value) => value.entry === entry)?.name;
    const replacing = selection
      ? profile.resources.filter((ref) => {
          if (ref.resourceHash === resourceHash && ref.entry === entry) return false;
          const old = entries.find(
            (value) => value.resourceHash === ref.resourceHash && value.entry === ref.entry,
          );
          return (
            (old?.successor?.resourceHash === resourceHash && old.successor.entry === entry) ||
            (selection.kind === 'skill' &&
              ref.kind === 'skill' &&
              old?.resource.skills.some(
                (skill) => skill.entry === ref.entry && skill.name === skillName,
              ))
          );
        })
      : [];
    const apply = () => {
      setProfile((current) =>
        replacing.length
          ? updateResourceSelection(current, key, true, replacing)
          : {
              ...current,
              resources: [
                ...current.resources.filter(
                  (ref) => ref.resourceHash !== resourceHash || ref.entry !== entry,
                ),
                ...(selection ? [selection] : []),
              ],
            },
      );
      setPreview(null);
    };
    if (replacing.length)
      confirmation.request(r('replaceVersion', { count: replacing.length }), apply);
    else apply();
  }
  const pendingProfile: HarnessProfile = {
    ...(profile.permissionPolicy ? { permissionPolicy: profile.permissionPolicy } : {}),
    name: profile.name,
    policy: profile.policy,
    resources: profile.resources,
    ...(profile.checkIds !== undefined ? { checkIds: profile.checkIds } : {}),
    ...(profile.lspServerIds !== undefined ? { lspServerIds: profile.lspServerIds } : {}),
    ...(profile.mcpServerIds !== undefined ? { mcpServerIds: profile.mcpServerIds } : {}),
    allowedTools: [...new Set(toolNames.split(/[\s,]+/).filter(Boolean))],
    startupCommands: commands
      .split('\n')
      .map((command) => command.trim())
      .filter(Boolean),
  };
  const dirty =
    canonicalJson(pendingProfile) !== canonicalJson(profileInput(selected ?? emptyProfile()));
  const confirmLeave = useSettingsForm({ dirty, pending: busy, save: saveProfile });
  async function saveProfile() {
    if (!api || !profile.name.trim() || busy) return false;
    return work(async () => {
      const input = {
        profileId: selected?.profileId ?? `harness_${crypto.randomUUID().replaceAll('-', '')}`,
        expectedRevision: selected?.revision ?? 0,
        profile: pendingProfile,
      };
      const json = canonicalJson({
        ...input,
        profileId: selected?.profileId ?? 'new',
      });
      if (pendingOperation.current?.json !== json)
        pendingOperation.current = { json, id: operationId() };
      // A retry must retain the generated profile ID as well as the operation ID.
      if (!selected) input.profileId = `harness_${pendingOperation.current.id}`;
      const { profile: saved } = await api.publish({
        ...input,
        operationId: pendingOperation.current.id,
      });
      pendingOperation.current = null;
      choose(saved, true);
      setProfiles((current) => {
        const prior = current.find((value) => value.profileId === saved.profileId);
        return [
          ...current.filter((value) => value.profileId !== saved.profileId),
          {
            ...saved,
            managementRevision: prior?.managementRevision ?? 0,
            archivedAt: prior?.archivedAt ?? null,
            usages: prior?.usages ?? [],
          },
        ];
      });
      setNotice(t('saved', { revision: saved.revision }));
      window.dispatchEvent(new Event('corral:harness-changed'));
      try {
        setProfiles(await api.profileManagement());
        setRefreshFailed(false);
      } catch {
        setRefreshFailed(true);
      }
    });
  }
  const meta = selected ? profiles.find((p) => p.profileId === selected.profileId) : null;
  const visibleEntry = (hash: string, entry: string) =>
    !entries.find((e) => e.resourceHash === hash && e.entry === entry)?.archivedAt ||
    profile.resources.some((ref) => ref.resourceHash === hash && ref.entry === entry);
  const canPreview =
    Boolean(projectId) &&
    selected !== null &&
    JSON.stringify({ ...selected, ...pendingProfile }) === JSON.stringify(selected);
  return (
    <SettingsLayout active="harness">
      <main className="settings-content">
        <div>
          <h2 className="text-2xl font-semibold">{t('heading')}</h2>
          <p className="mt-2 text-sm text-muted">{t('intro')}</p>
        </div>
        {api ? (
          <section id="project-context" className="settings-row">
            <div>
              <h3>{n('projectContext')}</h3>
              <p>{n('projectContextHint')}</p>
            </div>
            <SettingsProjectPicker
              label={n('projectContext')}
              disabled={busy}
              className="w-full sm:w-72"
            />
          </section>
        ) : null}
        {!api ? (
          <p>{t('localOnly')}</p>
        ) : (
          <>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <p data-testid="harness-status" role="status" aria-live="polite" className="text-sm">
              {busy ? t('busy') : notice}
            </p>
            {refreshFailed ? (
              <div role="alert" className="flex items-center gap-3 text-sm">
                <span>{r('savedListFailed')}</span>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      setProfiles(await api.profileManagement());
                      setRefreshFailed(false);
                      if (selected) setNotice(t('saved', { revision: selected.revision }));
                    })
                  }
                >
                  {r('refreshProfiles')}
                </Button>
              </div>
            ) : null}
            <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
              <legend className="sr-only">{t('heading')}</legend>
              <div className="settings-list flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    className={field}
                    aria-label={r('profileSearch')}
                    placeholder={r('profileSearch')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <label className="flex shrink-0 items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={archived}
                      onChange={(e) => setArchived(e.target.checked)}
                    />
                    {r('showArchived')}
                  </label>
                  <Button variant="outline" onClick={() => choose(null)}>
                    {t('newProfile')}
                  </Button>
                </div>
                <ul
                  className="flex max-h-48 flex-col gap-1 overflow-auto"
                  aria-label={t('profile')}
                >
                  {profiles
                    .filter(
                      (p) =>
                        Boolean(p.archivedAt) === archived &&
                        p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
                    )
                    .map((p) => (
                      <li key={p.profileId}>
                        <button
                          type="button"
                          aria-pressed={selected?.profileId === p.profileId}
                          className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selected?.profileId === p.profileId ? 'bg-sidebar-selected' : 'hover:bg-surface'}`}
                          onClick={() => choose(p)}
                        >
                          {p.name} · r{p.revision}
                          {p.archivedAt ? ` · ${r('archived')}` : ''}
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
              {selected ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSelected(null);
                        setProfile({
                          ...profileInput(profile),
                          name: r('copyName', { name: profile.name }),
                        });
                        setPreview(null);
                      }}
                    >
                      {r('copy')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (!meta) return;
                        const save = () =>
                          void work(async () => {
                            await api.archiveProfile(
                              meta.profileId,
                              meta.managementRevision,
                              !meta.archivedAt,
                              operationId(),
                            );
                            setProfiles(await api.profileManagement());
                          });
                        if (meta.archivedAt) save();
                        else confirmation.request(r('archiveConfirm'), save);
                      }}
                    >
                      {r(meta?.archivedAt ? 'restore' : 'archive')}
                    </Button>
                  </div>
                  {meta?.usages.length ? (
                    <div className="text-xs text-muted">
                      <p>{r('usages')}</p>
                      {meta.usages.map((usage) => (
                        <p key={usage.id}>
                          {usage.scope} · {usage.name} · r{usage.revision}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <section className="settings-row">
                <div>
                  <h3>{t('name')}</h3>
                </div>
                <input
                  className={`${field} sm:w-72`}
                  aria-label={t('name')}
                  value={profile.name}
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                />
              </section>
              <section className="settings-row">
                <div>
                  <h3>{t('policy')}</h3>
                </div>
                <Select
                  label={t('policy')}
                  value={profile.policy}
                  disabled={busy}
                  className="h-9 w-full sm:w-72"
                  onValueChange={(value) => {
                    setProfile({ ...profile, policy: value });
                    setPreview(null);
                  }}
                  options={[
                    { value: 'strict', label: t('strict') },
                    { value: 'trusted-native', label: t('trusted-native') },
                  ]}
                />
              </section>
              {profile.policy === 'trusted-native' ? (
                <p className="text-sm text-warning">{t('nativeWarning')}</p>
              ) : null}
              <nav className="flex flex-wrap gap-2">
                <Button variant="outline" render={<Link {...navigation.link('skills')} />}>
                  {r('skills')}
                </Button>
                <Button variant="outline" render={<Link {...navigation.link('hooks')} />}>
                  {r('hooks')}
                </Button>
                <Button variant="outline" render={<Link {...navigation.link('mcp')} />}>
                  {r('mcp')}
                </Button>
              </nav>
              {resources
                .filter((resource) =>
                  [...resource.skills.map((skill) => skill.entry), ...resource.extensions].some(
                    (entry) => visibleEntry(resource.hash, entry),
                  ),
                )
                .map((resource) => (
                  <div key={resource.hash} className="flex flex-col gap-3">
                    <p className="text-sm font-medium">
                      {resource.skills.length + resource.extensions.length === 1
                        ? (entries.find((value) => value.resourceHash === resource.hash)?.name ??
                          resource.name)
                        : resource.name}{' '}
                      · {resource.version} · {resource.trustedAt ? t('trusted') : t('untrusted')}
                    </p>
                    {resource.skills
                      .filter((skill) => visibleEntry(resource.hash, skill.entry))
                      .map((skill) => {
                        const selection = profile.resources.find(
                          (r) => r.resourceHash === resource.hash && r.entry === skill.entry,
                        );
                        return (
                          <div key={skill.entry} className="flex flex-col gap-3">
                            <label className="settings-row">
                              <span>
                                <span className="text-sm font-medium">
                                  {t('useSkill', {
                                    name:
                                      entries.find(
                                        (e) =>
                                          e.resourceHash === resource.hash &&
                                          e.entry === skill.entry,
                                      )?.name ?? skill.name,
                                  })}
                                </span>
                                <span className="mt-1 block text-xs text-muted">
                                  {skill.description}
                                </span>
                                {entries.find(
                                  (e) =>
                                    e.resourceHash === resource.hash && e.entry === skill.entry,
                                )?.archivedAt ? (
                                  <span className="mt-1 block text-xs text-warning">
                                    {r('archivedSelected')}
                                  </span>
                                ) : null}
                              </span>
                              <input
                                type="checkbox"
                                aria-label={t(
                                  selection?.kind === 'extension' ? 'useExtension' : 'useSkill',
                                  {
                                    name:
                                      entries.find(
                                        (e) =>
                                          e.resourceHash === resource.hash &&
                                          e.entry === skill.entry,
                                      )?.name ?? skill.name,
                                  },
                                )}
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
                            </label>
                            {selection ? (
                              <section className="settings-row">
                                <div>
                                  <h3>{t('skillMode', { name: skill.name })}</h3>
                                </div>
                                <Select
                                  label={t('skillMode', { name: skill.name })}
                                  value={selection.skillMode ?? 'auto'}
                                  disabled={busy}
                                  className="h-9 w-full sm:w-72"
                                  onValueChange={(value) =>
                                    selectResource(resource.hash, skill.entry, {
                                      ...selection,
                                      skillMode: value,
                                    })
                                  }
                                  options={(['auto', 'explicit', 'mandatory'] as const).map(
                                    (mode) => ({ value: mode, label: t(mode) }),
                                  )}
                                />
                              </section>
                            ) : null}
                          </div>
                        );
                      })}
                    {resource.extensions
                      .filter((entry) => visibleEntry(resource.hash, entry))
                      .map((entry) => {
                        const selection = profile.resources.find(
                          (r) => r.resourceHash === resource.hash && r.entry === entry,
                        );
                        return (
                          <div key={entry} className="flex flex-col gap-3">
                            <label className="settings-row">
                              <span>
                                <span className="text-sm font-medium">
                                  {t('useExtension', {
                                    name:
                                      entries.find(
                                        (e) =>
                                          e.resourceHash === resource.hash && e.entry === entry,
                                      )?.name ?? entry,
                                  })}
                                </span>
                                {entries.find(
                                  (e) => e.resourceHash === resource.hash && e.entry === entry,
                                )?.archivedAt ? (
                                  <span className="mt-1 block text-xs text-warning">
                                    {r('archivedSelected')}
                                  </span>
                                ) : null}
                              </span>
                              <input
                                type="checkbox"
                                aria-label={t('useExtension', {
                                  name:
                                    entries.find(
                                      (e) => e.resourceHash === resource.hash && e.entry === entry,
                                    )?.name ?? entry,
                                })}
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
                            </label>
                            {selection ? (
                              <label className="settings-row">
                                <span className="text-sm font-medium">
                                  {t('required', {
                                    name:
                                      entries.find(
                                        (value) =>
                                          value.resourceHash === resource.hash &&
                                          value.entry === entry,
                                      )?.name ?? entry,
                                  })}
                                </span>
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
                              </label>
                            ) : null}
                          </div>
                        );
                      })}
                  </div>
                ))}
              <p className="text-xs text-muted">{t('skillScripts')}</p>
              {(
                [
                  {
                    key: 'checkIds',
                    tool: 'run_check',
                    items: projectTools?.checks ?? [],
                    select: 'selectChecks',
                    hint: 'checkSelectionHint',
                    use: 'useCheck',
                    missing: 'unregisteredCheck',
                    empty: 'noProjectChecks',
                  },
                  {
                    key: 'lspServerIds',
                    tool: 'lsp_query',
                    items: projectTools?.lspServers ?? [],
                    select: 'selectLsp',
                    hint: 'lspSelectionHint',
                    use: 'useLsp',
                    missing: 'unregisteredLsp',
                    empty: 'noProjectLsp',
                  },
                  {
                    key: 'mcpServerIds',
                    tool: '',
                    items: projectTools?.mcpServers ?? [],
                    select: 'selectMcp',
                    hint: 'mcpSelectionHint',
                    use: 'useMcp',
                    missing: 'unregisteredMcp',
                    empty: 'noProjectMcp',
                  },
                ] as const
              ).map((group) => (
                <div key={group.key} className="flex flex-col gap-3">
                  <label className="settings-row">
                    <span>
                      <span className="text-sm font-medium">{t(group.select)}</span>
                      <span className="mt-1 block text-xs text-muted">{t(group.hint)}</span>
                    </span>
                    <input
                      type="checkbox"
                      aria-label={t(group.select)}
                      checked={profile[group.key] !== undefined}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        if (checked && group.tool)
                          setToolNames((current) =>
                            [
                              ...new Set([...current.split(/[\s,]+/).filter(Boolean), group.tool]),
                            ].join(', '),
                          );
                        setProfile((current) => {
                          const next = { ...current };
                          if (checked) next[group.key] = [];
                          else delete next[group.key];
                          return next;
                        });
                      }}
                    />
                  </label>
                  {profile[group.key] !== undefined ? (
                    <div className="flex flex-col gap-3">
                      {group.items.map((item) => (
                        <label key={item.id} className="settings-row">
                          <span className="text-sm font-medium">
                            {t(group.use, { name: item.name })}
                          </span>
                          <input
                            type="checkbox"
                            checked={profile[group.key]?.includes(item.id) ?? false}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setProfile((current) => ({
                                ...current,
                                [group.key]: checked
                                  ? [...(current[group.key] ?? []), item.id]
                                  : (current[group.key] ?? []).filter((id) => id !== item.id),
                              }));
                            }}
                          />
                        </label>
                      ))}
                      {profile[group.key]
                        ?.filter((id) => !group.items.some((item) => item.id === id))
                        .map((id) => (
                          <label key={id} className="settings-row">
                            <span className="text-sm font-medium text-warning">
                              {t(group.missing, { id })}
                            </span>
                            <input
                              type="checkbox"
                              checked
                              onChange={() =>
                                setProfile((current) => ({
                                  ...current,
                                  [group.key]: current[group.key]?.filter((value) => value !== id),
                                }))
                              }
                            />
                          </label>
                        ))}
                      {!group.items.length ? (
                        <p className="text-xs text-muted">{t(group.empty)}</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
              {projectId && projectTools && profile.policy === 'trusted-native' ? (
                <HarnessMcpTools
                  key={`${projectId}:${projectTools.revision}:${selected?.profileId ?? 'new'}`}
                  api={api}
                  projectId={projectId}
                  config={projectTools}
                  selectedIds={profile.mcpServerIds ?? []}
                  allowedTools={pendingProfile.allowedTools}
                  onChange={(names) => {
                    setToolNames(names.join(', '));
                    setPreview(null);
                  }}
                />
              ) : null}
              <PermissionPolicyEditor
                value={profile.permissionPolicy}
                tools={preview?.snapshot.tools ?? []}
                names={pendingProfile.allowedTools}
                onChange={(permissionPolicy) =>
                  setProfile((current) => ({ ...current, permissionPolicy }))
                }
              />
              <label className="settings-row">
                <span>
                  <span className="text-sm font-medium">{t('codemode')}</span>
                  <span className="mt-1 block text-xs text-muted">{t('codemodeHint')}</span>
                </span>
                <input
                  type="checkbox"
                  aria-label={t('codemode')}
                  checked={pendingProfile.allowedTools.includes('codemode')}
                  disabled={profile.policy !== 'trusted-native'}
                  onChange={(event) =>
                    setToolNames(
                      [
                        ...pendingProfile.allowedTools.filter((name) => name !== 'codemode'),
                        ...(event.target.checked ? ['codemode'] : []),
                      ].join(', '),
                    )
                  }
                />
              </label>
              <section className="settings-surface flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t('allowedTools')}</h3>
                <p className="text-xs text-muted">{t('toolsHint')}</p>
                <textarea
                  className={field}
                  aria-label={t('allowedTools')}
                  value={toolNames}
                  onChange={(e) => setToolNames(e.target.value)}
                  rows={3}
                />
              </section>
              <section className="settings-surface flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t('commands')}</h3>
                <p className="text-xs text-muted">{t('commandsHint')}</p>
                <textarea
                  className={field}
                  aria-label={t('commands')}
                  value={commands}
                  onChange={(e) => setCommands(e.target.value)}
                  rows={2}
                />
              </section>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!profile.name.trim() || (selected !== null && !dirty)}
                  onClick={() => void saveProfile()}
                >
                  {t('save')}
                </Button>
                <Button
                  variant="outline"
                  disabled={!canPreview}
                  onClick={() =>
                    selected &&
                    projectId &&
                    canPreview &&
                    void work(async () =>
                      setPreview(await api.preview(bindingOf(selected), projectId)),
                    )
                  }
                >
                  {t('preview')}
                </Button>
              </div>
              {selected && !canPreview && projectId ? (
                <p className="text-xs text-muted">{t('saveBeforePreview')}</p>
              ) : null}
              {preview && canPreview ? <HarnessPreviewView preview={preview} /> : null}
            </fieldset>
          </>
        )}
        {confirmation.dialog}
      </main>
    </SettingsLayout>
  );
}
