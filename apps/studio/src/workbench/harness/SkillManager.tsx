import type { HarnessApi } from '@corral/client';
import type { HarnessEntryView, RoleSkillRef } from '@corral/contracts';
import {
  Button,
  EmptyState,
  Input,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@corral/react/design-kit';
import { Plus } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import { ABOVE_CHOSEN_TABLE_ROW, CHOSEN_TABLE_ROW } from '../chosenRow.ts';
import { useSettingsNavigation } from '../navigation.ts';
import { useSettingsTask } from '../SettingsLifecycle.tsx';
import { useManagementConfirmation } from './ConfirmAction.tsx';
import { EntryContent, entryId, entryKey } from './EntryContent.tsx';
import { ResourceEditor } from './ResourceEditor.tsx';
import { SkillQualityPanel } from './SkillQualityPanel.tsx';
import { loadSkillCatalog, type SkillCatalog, skillState, versionsOf } from './skillCatalog.ts';
import { operationId } from './Target.tsx';

type Editor = { importing?: boolean; entry?: HarnessEntryView };

type UsageData<T> = { state: 'loading' | 'failed' } | { state: 'ready'; value: T };

function useUsageData<T>(load: () => Promise<T>, revision = 0) {
  const [data, setData] = useState<UsageData<T>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void revision;
    void attempt;
    setData({ state: 'loading' });
    void load().then(
      (value) => active && setData({ state: 'ready', value }),
      () => active && setData({ state: 'failed' }),
    );
    return () => {
      active = false;
    };
  }, [load, revision, attempt]);
  return [data, () => setAttempt((value) => value + 1)] as const;
}

function UsageGroup({
  label,
  state,
  failure,
  retry,
  children,
}: {
  label: string;
  state: UsageData<unknown>['state'];
  failure: string;
  retry: () => void;
  children: ReactNode;
}) {
  const l = useTranslations('Library');
  return (
    <section aria-label={label}>
      <h4 className="text-caption text-muted-foreground">{label}</h4>
      {state === 'loading' ? (
        <p role="status" className="text-muted-foreground">
          {l('resources.loading')}
        </p>
      ) : state === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-destructive">
          {failure}
          <Button variant="tertiary" onClick={retry}>
            {l('retry')}
          </Button>
        </div>
      ) : (
        children
      )}
    </section>
  );
}

type SkillUser = { id: string; name: string; skills: RoleSkillRef[] | undefined };

function ProjectUsageGroup({
  group,
  projectId,
  selected,
}: {
  group: 'originals' | 'teams';
  projectId: string;
  selected: HarnessEntryView;
}) {
  const l = useTranslations('Library');
  const { agents, repository } = useServices();
  const load = useCallback(async (): Promise<SkillUser[]> => {
    if (group === 'originals') {
      const originals = await agents.list(projectId);
      return originals.map(({ agentId, role }) => ({
        id: agentId,
        name: role.name,
        skills: role.skills,
      }));
    }
    const teams = (await repository.list()).filter((team) => team.projectId === projectId);
    // get reads the current saved draft, even when it is not runnable yet.
    const records = await Promise.all(teams.map((team) => repository.get(team.corralId)));
    return records.flatMap((record) => {
      if (!record) throw new Error('A listed team could not be read.');
      if (record.projectId !== projectId) return [];
      return [
        {
          id: record.corralId,
          name: record.name,
          skills: record.definition.roles.flatMap((role) => role.skills ?? []),
        },
      ];
    });
  }, [agents, repository, projectId, group]);
  const [users, retry] = useUsageData(load);

  const matches =
    users.state === 'ready'
      ? users.value.filter((user) =>
          user.skills?.some(
            (ref) => ref.resourceHash === selected.resourceHash && ref.entry === selected.entry,
          ),
        )
      : [];
  return (
    <UsageGroup
      label={l(`skills.${group}`)}
      state={users.state}
      failure={l(group === 'originals' ? 'skills.originalsFailed' : 'skills.teamsFailed')}
      retry={retry}
    >
      {matches.length ? (
        <ul>
          {matches.map((user) => (
            <li key={user.id}>
              {group === 'originals' ? (
                <Link
                  className="underline"
                  to="/library/agents"
                  search={{ project: projectId, agent: user.id }}
                >
                  {user.name}
                </Link>
              ) : (
                <Link
                  className="underline"
                  to="/corrals/$corralId/edit"
                  params={{ corralId: user.id }}
                >
                  {user.name}
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          {l(group === 'originals' ? 'skills.noOriginals' : 'skills.noTeams')}
        </p>
      )}
    </UsageGroup>
  );
}

function SkillUsages({
  api,
  selected,
  revision,
}: {
  api: HarnessApi;
  selected: HarnessEntryView;
  revision: number;
}) {
  const t = useTranslations('Resources');
  const l = useTranslations('Library.skills');
  const navigation = useSettingsNavigation();
  // Profile use is part of an entry snapshot. Read it independently of the catalog so
  // its failure can be retried without closing the detail or reloading other groups.
  const loadPolicies = useCallback(async () => {
    const byEntry = new Map<string, HarnessEntryView['profiles']>();
    for (const entry of await api.entries()) {
      if (entry.kind === 'skill') byEntry.set(entryId(entry), entry.profiles);
    }
    return byEntry;
  }, [api]);
  const [policies, retry] = useUsageData(loadPolicies, revision);
  const profiles = policies.state === 'ready' ? policies.value.get(entryId(selected)) : undefined;
  return (
    <section className="grid gap-2 text-body" aria-label={t('usage')}>
      <h3 className="text-subtitle">{t('usage')}</h3>
      {navigation.projectId ? (
        <>
          <ProjectUsageGroup
            group="originals"
            projectId={navigation.projectId}
            selected={selected}
          />
          <ProjectUsageGroup group="teams" projectId={navigation.projectId} selected={selected} />
        </>
      ) : null}
      <UsageGroup
        label={t('policies')}
        state={policies.state === 'ready' && !profiles ? 'failed' : policies.state}
        failure={l('policiesFailed')}
        retry={retry}
      >
        {profiles?.length ? (
          <ul>
            {profiles.map((profile) => {
              const id = `${profile.profileId}:${profile.revision}`;
              return (
                <li key={id}>
                  <Link
                    {...navigation.link('harness', navigation.projectId, id)}
                    className="underline"
                  >
                    {profile.name} · r{profile.revision}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted-foreground">{t('noPolicies')}</p>
        )}
      </UsageGroup>
    </section>
  );
}

export function SkillManager({ api, toolbar }: { api: HarnessApi; toolbar?: HTMLElement | null }) {
  const t = useTranslations('Resources'),
    l = useTranslations('Library'),
    h = useTranslations('Harness');
  const navigation = useSettingsNavigation();
  const confirmation = useManagementConfirmation();
  const run = useSettingsTask('resources:skill');
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [attempt, refresh] = useState(0);
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState('');
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const carried = useRef(navigation.item);
  useEffect(() => {
    let active = true;
    void attempt;
    setFailed(false);
    void loadSkillCatalog(api).then(
      (loaded) => {
        if (!active) return;
        setCatalog(loaded);
        if (carried.current) {
          const entry = loaded.entries.find((e) => entryId(e) === carried.current);
          carried.current = undefined;
          if (entry) {
            setSelection(entryId(entry));
            setArchived(Boolean(entry.archivedAt));
          }
        }
      },
      () => {
        if (active) {
          setCatalog(null);
          setFailed(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api, attempt]);
  function changed() {
    refresh((n) => n + 1);
    window.dispatchEvent(new Event('corral:harness-changed'));
  }
  async function work(action: () => Promise<unknown>) {
    setBusy(true);
    setActionFailed(false);
    try {
      await run(action);
      changed();
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  }
  function open(next: Editor, button: HTMLButtonElement) {
    trigger.current = button;
    setEditor(next);
  }
  function close() {
    setEditor(null);
    trigger.current?.focus();
  }
  function choose(entry: HarnessEntryView) {
    setActionFailed(false);
    setSelection(entryId(entry));
  }
  function walk(entry: HarnessEntryView) {
    if (entry.archivedAt) setArchived(true);
    setSearch('');
    choose(entry);
  }
  const controls = (
    <>
      <Button onClick={(event) => open({}, event.currentTarget)}>
        <Plus aria-hidden />
        {t('createSkill')}
      </Button>
      <Button
        variant="tertiary"
        onClick={(event) => open({ importing: true }, event.currentTarget)}
      >
        {t('importSkills')}
      </Button>
    </>
  );
  const entries = catalog?.entries ?? [];
  const query = search.trim().toLocaleLowerCase();
  const filtered = entries.filter(
    (entry) =>
      (archived || !entry.archivedAt) &&
      `${entry.name} ${entry.description} ${entry.resource.name}`
        .toLocaleLowerCase()
        .includes(query),
  );
  const chosen = filtered.findIndex((entry) => entryId(entry) === selection);
  const selected = filtered[chosen];
  const names = new Map<string, number>();
  for (const entry of entries) names.set(entry.name, (names.get(entry.name) ?? 0) + 1);
  const versions = selected ? versionsOf(selected, entries) : null;
  const previous = versions?.chain[versions.index - 1],
    next = versions?.chain[versions.index + 1];
  return (
    <div className="@container grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-3 empty:hidden">
        {entries.length ? (
          <>
            <Input
              aria-label={t('skillSearch')}
              placeholder={t('skillSearch')}
              className="min-w-0 flex-1 sm:max-w-72"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Switch
              label={t('showArchived')}
              checked={archived}
              onToggle={() => setArchived(!archived)}
            />
          </>
        ) : null}
        {toolbar ? (
          createPortal(controls, toolbar)
        ) : (
          <div className="ml-auto flex flex-wrap gap-2">{controls}</div>
        )}
      </div>
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-body text-destructive">
          {l('resources.loadFailed', { group: t('skills') })}
          <Button variant="tertiary" onClick={() => refresh((n) => n + 1)}>
            {l('retry')}
          </Button>
        </div>
      ) : !catalog ? (
        <p role="status" className="text-body text-muted-foreground">
          {h('busy')}
        </p>
      ) : !filtered.length ? (
        <EmptyState
          title={t(!entries.length ? 'emptySkills' : query ? 'noMatches' : 'onlyArchived')}
        />
      ) : (
        <div className={selected ? 'grid min-w-0 items-start gap-6 @3xl:grid-cols-2' : 'min-w-0'}>
          <Table aria-label={t('skills')} className="table-fixed">
            <TableHeader>
              <TableRow className={chosen === 0 ? ABOVE_CHOSEN_TABLE_ROW : undefined}>
                <TableHead>{l('resources.name')}</TableHead>
                <TableHead>{t('whenToUse')}</TableHead>
                <TableHead className="w-1/4">{l('resources.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((entry, i) => {
                const state = skillState(entry, catalog.disabled);
                const source =
                  entry.resource.sourceLabel === 'Created in Corral'
                    ? t('savedCopy')
                    : entry.resource.sourceLabel === 'Edited copy'
                      ? t('editedCopy')
                      : entry.resource.sourceKind === 'local'
                        ? t('importedCopy')
                        : entry.resource.sourceKind === 'npm'
                          ? 'npm'
                          : 'Git';
                return (
                  <TableRow
                    key={entryId(entry)}
                    index={i}
                    data-selected={chosen === i}
                    className={
                      chosen === i
                        ? CHOSEN_TABLE_ROW
                        : chosen === i + 1
                          ? ABOVE_CHOSEN_TABLE_ROW
                          : undefined
                    }
                  >
                    <TableCell>
                      <button
                        className="block w-full break-words text-left text-foreground after:absolute after:inset-0 after:content-['']"
                        type="button"
                        aria-pressed={chosen === i}
                        onClick={() => choose(entry)}
                      >
                        {entry.name}
                        {(names.get(entry.name) ?? 0) > 1 ? (
                          <small className="block text-caption text-muted-foreground">
                            {entry.resource.name} · {source}
                          </small>
                        ) : null}
                      </button>
                    </TableCell>
                    <TableCell className="break-words">
                      <span className="line-clamp-2">{entry.description}</span>
                    </TableCell>
                    <TableCell className="break-words">{state ? t(state) : null}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {selected ? (
            <section aria-label={t('details')} className="grid min-w-0 gap-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="tertiary"
                  disabled={busy}
                  onClick={(event) => open({ entry: selected }, event.currentTarget)}
                >
                  {t('edit')}
                </Button>
                <Button
                  variant="tertiary"
                  disabled={busy}
                  onClick={() =>
                    void work(() => api.trust(selected.resourceHash, !selected.resource.trustedAt))
                  }
                >
                  {t(selected.resource.trustedAt ? 'revokeSkill' : 'trustSkill')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const archive = () =>
                      void work(() =>
                        api.archiveEntry(
                          entryKey(selected),
                          selected.managementRevision,
                          !selected.archivedAt,
                          operationId(),
                        ),
                      );
                    if (selected.archivedAt) archive();
                    else confirmation.request(t('archiveConfirm'), archive);
                  }}
                >
                  {t(selected.archivedAt ? 'restoreSkill' : 'archiveSkill')}
                </Button>
              </div>
              {selected.resource.fileCount > 1 ? (
                <p className="text-caption text-muted-foreground">{t('packageTrust')}</p>
              ) : null}
              {actionFailed ? (
                <p role="alert" className="text-body text-destructive">
                  {h('error')}
                </p>
              ) : null}
              <section className="grid gap-1">
                <h3 className="text-subtitle">{t('whenToUse')}</h3>
                <p className="break-words text-body">{selected.description}</p>
              </section>
              <div className="grid min-w-0 gap-2">
                <EntryContent key={entryId(selected)} api={api} entry={selected} />
              </div>
              {versions && versions.chain.length > 1 ? (
                <div className="flex flex-wrap items-center gap-2 text-body">
                  <span>{t('versionNumber', { number: versions.index + 1 })}</span>
                  {previous ? (
                    <Button variant="tertiary" onClick={() => walk(previous)}>
                      {t('previousVersion')}
                    </Button>
                  ) : null}
                  {next ? (
                    <Button variant="tertiary" onClick={() => walk(next)}>
                      {t('nextVersion')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <SkillUsages
                key={navigation.projectId}
                api={api}
                selected={selected}
                revision={attempt}
              />
              {!selected.archivedAt ? (
                <SkillQualityPanel
                  key={entryId(selected)}
                  api={api}
                  entry={selected}
                  entries={entries}
                  onChanged={changed}
                />
              ) : null}
            </section>
          ) : null}
        </div>
      )}
      {editor ? (
        <ResourceEditor
          api={api}
          kind="skill"
          {...editor}
          onClose={close}
          onSaved={(hash, path) => {
            close();
            setArchived(false);
            setSearch('');
            setSelection(`${hash}:${path ?? 'skills/SKILL.md'}`);
            changed();
          }}
        />
      ) : null}
      {confirmation.dialog}
    </div>
  );
}
