import type { HarnessApi, HarnessPreview } from '@corral/client';
import type {
  HarnessDefault,
  HarnessProfile,
  HarnessProfileRevision,
  HarnessProfileView,
} from '@corral/contracts';
import { Select } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useSettingsNavigation } from '../navigation.ts';
import { SettingsProjectPicker } from '../SettingsNavigation.tsx';

export const field = 'w-full rounded-md border border-line bg-surface p-2 text-sm';
export const operationId = () => `manage_${crypto.randomUUID()}`;
// A navigation preference, scoped to this workspace's API instance and project.
const targets = new WeakMap<HarnessApi, Map<string, string>>();
export function rememberHarnessTarget(
  api: HarnessApi,
  projectId: string | undefined,
  value: string,
) {
  if (!targets.has(api)) targets.set(api, new Map());
  if (value !== 'library') targets.get(api)?.set(projectId ?? '', value);
}

export function profileInput(p: HarnessProfile): HarnessProfile {
  return {
    name: p.name,
    policy: p.policy,
    allowedTools: p.allowedTools,
    resources: p.resources,
    startupCommands: p.startupCommands,
    ...(p.checkIds === undefined ? {} : { checkIds: p.checkIds }),
    ...(p.lspServerIds === undefined ? {} : { lspServerIds: p.lspServerIds }),
    ...(p.mcpServerIds === undefined ? {} : { mcpServerIds: p.mcpServerIds }),
  };
}
export function useHarnessTarget(api: HarnessApi, projectId: string | undefined) {
  const [selection, setSelectionState] = useState('library');
  const [loaded, setLoaded] = useState<{
    api: HarnessApi;
    projectId: string | undefined;
    selection: string;
  } | null>(null);
  const ready =
    loaded?.api === api && loaded.projectId === projectId && loaded.selection === selection;
  const setSelection = (value: string) => {
    rememberHarnessTarget(api, projectId, value);
    setSelectionState(value);
  };
  const [profiles, setProfiles] = useState<HarnessProfileView[]>([]);
  const [profile, setProfile] = useState<HarnessProfileRevision | null>(null);
  const [target, setTarget] = useState<HarnessDefault | null>(null);
  const [toolsRevision, setToolsRevision] = useState(0);
  const [preview, setPreview] = useState<HarnessPreview | null>(null);
  const [version, refresh] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const owner = useRef(0);
  const retry = useRef<{ json: string; operationId: string } | null>(null);
  useEffect(() => {
    void version;
    const current = ++owner.current;
    setBusy(true);
    setError('');
    setProfile(null);
    setPreview(null);
    setTarget(null);
    void (async () => {
      const [list, tools] = await Promise.all([
        api.profileManagement(),
        projectId && selection !== 'library' ? api.projectTools(projectId) : null,
      ]);
      const d =
        selection === 'personal'
          ? await api.default('personal', 'default')
          : selection === 'project' && projectId
            ? await api.default('project', projectId)
            : null;
      const binding =
        d?.binding ??
        (selection.startsWith('profile:')
          ? list.find((p) => p.profileId === selection.slice(8))
          : null);
      const selected = binding ? await api.profile(binding) : null;
      let effective: HarnessPreview | null = null;
      if (selected && selection !== 'personal' && projectId)
        effective = await api
          .preview({ profileId: selected.profileId, revision: selected.revision }, projectId)
          .catch(() => null);
      if (owner.current !== current) return;
      setProfiles(list);
      setToolsRevision(tools?.revision ?? 0);
      setTarget(d);
      setProfile(selected);
      setPreview(effective);
    })()
      .catch((e) => {
        if (owner.current === current) setError(e.message);
      })
      .finally(() => {
        if (owner.current === current) {
          setLoaded({ api, projectId, selection });
          setBusy(false);
        }
      });
    return () => {
      owner.current++;
    };
  }, [api, projectId, selection, version]);
  async function save(next: HarnessProfile) {
    if (!ready || !profile || busy) return;
    const current = owner.current;
    const input = {
      profileId: profile.profileId,
      expectedRevision:
        profiles.find((p) => p.profileId === profile.profileId)?.revision ?? profile.revision,
      profile: profileInput(next),
      ...(target
        ? {
            target: {
              scope: target.scope,
              scopeId: target.scopeId,
              expectedRevision: target.revision,
              binding: target.binding,
              ...(target.scope === 'project' ? { projectToolsRevision: toolsRevision } : {}),
            },
          }
        : {}),
    };
    const json = JSON.stringify(input);
    if (retry.current?.json !== json) retry.current = { json, operationId: operationId() };
    setBusy(true);
    setError('');
    setProfile({ ...profile, ...profileInput(next) });
    try {
      const saved = await api.publish({ ...input, operationId: retry.current.operationId });
      if (owner.current !== current) return;
      retry.current = null;
      setProfile(saved.profile);
      setProfiles((current) =>
        current.map((value) =>
          value.profileId === saved.profile.profileId ? { ...value, ...saved.profile } : value,
        ),
      );
      if (saved.target) setTarget(saved.target);
      if (selection !== 'personal' && projectId) {
        const effective = await api
          .preview(
            { profileId: saved.profile.profileId, revision: saved.profile.revision },
            projectId,
          )
          .catch(() => null);
        if (owner.current === current) setPreview(effective);
      }
      window.dispatchEvent(new Event('corral:harness-changed'));
    } catch (e) {
      if (owner.current === current) {
        setProfile(profile);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (owner.current === current) setBusy(false);
    }
  }
  return {
    selection,
    setSelection,
    connect: () => setSelection(targets.get(api)?.get(projectId ?? '') ?? 'personal'),
    profiles,
    profile: ready ? profile : null,
    preview: ready ? preview : null,
    target: ready ? target : null,
    busy: busy || !ready,
    error,
    setError,
    save,
    reload: () => refresh((n) => n + 1),
  };
}
export function TargetPicker({
  target,
  beforeChange,
}: {
  target: ReturnType<typeof useHarnessTarget>;
  beforeChange?: () => boolean;
}) {
  const t = useTranslations('Resources');
  const navigation = useSettingsNavigation();
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-raised p-4">
      <div className="flex flex-col gap-1 text-sm">
        {t('target')}
        <Select
          className="h-9 w-full justify-between"
          label={t('target')}
          value={target.selection}
          disabled={target.busy}
          onValueChange={(value) => {
            if (!beforeChange || beforeChange()) target.setSelection(value);
          }}
          options={[
            { value: 'personal', label: t('personal') },
            { value: 'project', label: t('project') },
            ...target.profiles
              .filter((p) => !p.archivedAt || target.selection === `profile:${p.profileId}`)
              .map((p) => ({
                value: `profile:${p.profileId}`,
                label: `${p.name} · r${p.revision}${p.archivedAt ? ` · ${t('archived')}` : ''}`,
              })),
          ]}
        />
      </div>
      {target.selection === 'project' ? (
        <SettingsProjectPicker disabled={target.busy} className="py-2" />
      ) : null}
      <p className="text-xs text-muted">
        {target.profile
          ? t('targetRevision', { name: target.profile.name, revision: target.profile.revision })
          : t(target.selection === 'library' ? 'libraryHint' : 'noTarget')}
      </p>
      <Link
        to="/settings/harness"
        search={navigation.search}
        className="text-xs text-accent underline"
      >
        {t('manageProfiles')}
      </Link>
      {target.error ? (
        <p role="alert" className="text-sm text-danger">
          {target.error}{' '}
          <button type="button" className="underline" onClick={target.reload}>
            {t('reload')}
          </button>
        </p>
      ) : null}
    </div>
  );
}
