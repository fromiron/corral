import type { HarnessPreview } from '@corral/client';
import type {
  HarnessDefault,
  HarnessEntryView,
  HarnessProfile,
  HarnessProfileRevision,
  HarnessProfileView,
  HarnessResourceView,
  ProjectToolConfigRevision,
} from '@corral/contracts';
import { canonicalJson, WorkTool } from '@corral/contracts';
import { Button } from '@corral/react/ui';
import { Link, useBlocker } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useCurrentProject } from '../projects.ts';
import { useServices } from '../services.tsx';
import { useManagementConfirmation } from '../workbench/harness/ConfirmAction.tsx';
import { operationId, profileInput, rememberHarnessTarget } from '../workbench/harness/Target.tsx';
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
    'run_check',
    'lsp_query',
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
      {preview.snapshot.tools.length ? (
        <details>
          <summary className="cursor-pointer text-sm">
            {t('staticTools', { count: preview.snapshot.tools.length })}
          </summary>
          <p className="my-2 text-xs text-muted">{t('staticToolsHint')}</p>
          <ul className="flex flex-col gap-2 text-xs">
            {preview.snapshot.tools.map((tool) => (
              <li key={tool.name} className="border-b border-line pb-2">
                <span className="font-mono">{tool.name}</span> · {tool.source} ·{' '}
                {t(`toolEffects.${tool.sideEffect}`)}
                <p className="break-all font-mono text-2xs text-muted">
                  {t('toolSchema', { hash: tool.schemaHash })}
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
  const projectId = useCurrentProject();
  return <HarnessSettingsEditor key={projectId} projectId={projectId} />;
}

function HarnessSettingsEditor({ projectId }: { projectId: string }) {
  const t = useTranslations('Harness'),
    r = useTranslations('Resources');
  const { harnesses: api } = useServices();
  const [resources, setResources] = useState<HarnessResourceView[]>([]);
  const [profiles, setProfiles] = useState<HarnessProfileView[]>([]);
  const [entries, setEntries] = useState<HarnessEntryView[]>([]);
  const [search, setSearch] = useState(''),
    [archived, setArchived] = useState(false),
    [saveTarget, setSaveTarget] = useState('standalone');
  const pendingOperation = useRef<{ json: string; id: string } | null>(null);
  const [defaults, setDefaults] = useState<HarnessDefault[]>([]);
  const [toolsState, setToolsState] = useState<{
    projectId: string;
    value: ProjectToolConfigRevision | null;
  } | null>(null);
  const projectTools = toolsState?.projectId === projectId ? toolsState.value : null;
  const [selected, setSelected] = useState<HarnessProfileRevision | null>(null);
  const [profile, setProfile] = useState<HarnessProfile>(emptyProfile);
  const [toolNames, setToolNames] = useState(emptyProfile().allowedTools.join(', '));
  const [commands, setCommands] = useState('');
  const [preview, setPreview] = useState<HarnessPreview | null>(null);
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
      api.default('personal', 'default'),
      api.default('project', projectId),
      api.projectTools(projectId),
      api.entries(),
    ]).then(
      ([r, p, personal, project, tools, entries]) => {
        if (active) {
          setResources(r);
          setEntries(entries);
          setProfiles(p);
          setDefaults([personal, project]);
          setToolsState({ projectId, value: tools });
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
  function choose(next: HarnessProfileRevision | null, saved = false) {
    if (!saved && dirty && !window.confirm(r('leaveUnsaved'))) return;
    if (next && api) rememberHarnessTarget(api, projectId, `profile:${next.profileId}`);
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
  const pendingProfile: HarnessProfile = {
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
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useBlocker({
    shouldBlockFn: () => dirtyRef.current && !window.confirm(r('leaveUnsaved')),
    enableBeforeUnload: () => dirtyRef.current,
  });
  const meta = selected ? profiles.find((p) => p.profileId === selected.profileId) : null;
  const visibleEntry = (hash: string, entry: string) =>
    !entries.find((e) => e.resourceHash === hash && e.entry === entry)?.archivedAt ||
    profile.resources.some((ref) => ref.resourceHash === hash && ref.entry === entry);
  const canPreview =
    selected !== null &&
    JSON.stringify({ ...selected, ...pendingProfile }) === JSON.stringify(selected);
  return (
    <SettingsLayout active="harness">
      <main className="mx-auto flex max-w-5xl flex-col gap-7 p-6 sm:p-10">
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
            <fieldset
              disabled={busy}
              className="flex min-w-0 flex-col gap-4 border-t border-line pt-5"
            >
              <legend className="px-1 text-lg font-semibold">{t('heading')}</legend>
              <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
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
                          className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selected?.profileId === p.profileId ? 'bg-sidebar-selected' : 'hover:bg-raised'}`}
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
              <nav className="flex flex-wrap gap-3 text-sm text-accent">
                <Link to="/settings/skills" className="underline">
                  {r('skills')}
                </Link>
                <Link to="/settings/hooks" className="underline">
                  {r('hooks')}
                </Link>
                <Link to="/settings/mcp" className="underline">
                  {r('mcp')}
                </Link>
              </nav>
              {resources
                .filter((resource) =>
                  [...resource.skills.map((skill) => skill.entry), ...resource.extensions].some(
                    (entry) => visibleEntry(resource.hash, entry),
                  ),
                )
                .map((resource) => (
                  <div
                    key={resource.hash}
                    className="flex flex-col gap-3 border-t border-line pt-3"
                  >
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
                              {t('useSkill', {
                                name:
                                  entries.find(
                                    (e) =>
                                      e.resourceHash === resource.hash && e.entry === skill.entry,
                                  )?.name ?? skill.name,
                              })}
                              {entries.find(
                                (e) => e.resourceHash === resource.hash && e.entry === skill.entry,
                              )?.archivedAt ? (
                                <span className="text-xs text-warning">
                                  {r('archivedSelected')}
                                </span>
                              ) : null}
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
                    {resource.extensions
                      .filter((entry) => visibleEntry(resource.hash, entry))
                      .map((entry) => {
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
                              {t('useExtension', {
                                name:
                                  entries.find(
                                    (e) => e.resourceHash === resource.hash && e.entry === entry,
                                  )?.name ?? entry,
                              })}
                              {entries.find(
                                (e) => e.resourceHash === resource.hash && e.entry === entry,
                              )?.archivedAt ? (
                                <span className="text-xs text-warning">
                                  {r('archivedSelected')}
                                </span>
                              ) : null}
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
                                {t('required', {
                                  name:
                                    entries.find(
                                      (value) =>
                                        value.resourceHash === resource.hash &&
                                        value.entry === entry,
                                    )?.name ?? entry,
                                })}
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
                <div key={group.key} className="flex flex-col gap-2 border-t border-line pt-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
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
                    {t(group.select)}
                  </label>
                  <p className="text-xs text-muted">{t(group.hint)}</p>
                  {profile[group.key] !== undefined ? (
                    <div className="flex flex-col gap-2 pl-5">
                      {group.items.map((item) => (
                        <label key={item.id} className="flex items-center gap-2 text-sm">
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
                          {t(group.use, { name: item.name })}
                        </label>
                      ))}
                      {profile[group.key]
                        ?.filter((id) => !group.items.some((item) => item.id === id))
                        .map((id) => (
                          <label key={id} className="flex items-center gap-2 text-sm text-warning">
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
                            {t(group.missing, { id })}
                          </label>
                        ))}
                      {!group.items.length ? (
                        <p className="text-xs text-muted">{t(group.empty)}</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
              <details>
                <summary className="cursor-pointer text-sm">{t('allowedTools')}</summary>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
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
                  {t('codemode')}
                </label>
                <p className="text-xs text-muted">{t('codemodeHint')}</p>
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
              <label className="flex flex-col gap-1 text-sm">
                {r('saveTo')}
                <select
                  className={field}
                  value={saveTarget}
                  onChange={(e) => setSaveTarget(e.target.value)}
                >
                  <option value="standalone">{r('standalone')}</option>
                  <option value="personal">{r('personal')}</option>
                  <option value="project">{r('project')}</option>
                </select>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!profile.name.trim() || (selected !== null && !dirty)}
                  onClick={() =>
                    void work(async () => {
                      const target = defaults.find((value) => value.scope === saveTarget);
                      const input = {
                        profileId:
                          selected?.profileId ??
                          `harness_${crypto.randomUUID().replaceAll('-', '')}`,
                        expectedRevision: selected?.revision ?? 0,
                        profile: pendingProfile,
                        ...(target
                          ? {
                              target: {
                                scope: target.scope,
                                scopeId: target.scopeId,
                                expectedRevision: target.revision,
                                binding: target.binding,
                                ...(target.scope === 'project'
                                  ? { projectToolsRevision: projectTools?.revision ?? 0 }
                                  : {}),
                              },
                            }
                          : {}),
                      };
                      const json = canonicalJson({
                        ...input,
                        profileId: selected?.profileId ?? 'new',
                      });
                      if (pendingOperation.current?.json !== json)
                        pendingOperation.current = { json, id: operationId() };
                      // A retry must retain the generated profile ID as well as the operation ID.
                      if (!selected) input.profileId = `harness_${pendingOperation.current.id}`;
                      const { profile: saved, target: updated } = await api.publish({
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
                      if (updated)
                        setDefaults((current) =>
                          current.map((value) => (value.scope === updated.scope ? updated : value)),
                        );
                      setNotice(t('saved', { revision: saved.revision }));
                      window.dispatchEvent(new Event('corral:harness-changed'));
                      try {
                        setProfiles(await api.profileManagement());
                        setRefreshFailed(false);
                      } catch {
                        setRefreshFailed(true);
                      }
                    })
                  }
                >
                  {t('save')}
                </Button>
                <Button
                  variant="outline"
                  disabled={!canPreview}
                  onClick={() =>
                    selected &&
                    canPreview &&
                    void work(async () =>
                      setPreview(await api.preview(bindingOf(selected), projectId)),
                    )
                  }
                >
                  {t('preview')}
                </Button>
              </div>
              {selected && !canPreview ? (
                <p className="text-xs text-muted">{t('saveBeforePreview')}</p>
              ) : null}
              {preview && canPreview ? <HarnessPreviewView preview={preview} /> : null}
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
                    {profiles
                      .filter(
                        (p) =>
                          !p.archivedAt ||
                          (value.binding?.profileId === p.profileId &&
                            value.binding.revision === p.revision),
                      )
                      .map((p) => (
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
        {confirmation.dialog}
      </main>
    </SettingsLayout>
  );
}
