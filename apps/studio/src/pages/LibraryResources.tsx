import type {
  HarnessEntryView,
  HarnessResource,
  PackageView,
  ProjectToolConfigRevision,
} from '@corral/contracts';
import {
  Button,
  EmptyState,
  KitBadge,
  SectionLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@corral/react/design-kit';
import { Plus } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { type DependencyList, useCallback, useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { type SettingsSection, useSettingsNavigation } from '../workbench/navigation.ts';

// The library's resources: what is installed and whether it works, read-only. Editing, trust,
// installation and unsaved-change protection stay in the settings dialog, which "Manage" opens
// over this page (docs/specs/features/library.md). Rows never show local paths, sources or tokens.

export const RESOURCE_GROUPS = ['skills', 'hooks', 'extensions', 'packages', 'mcp'] as const;
export type ResourceGroup = (typeof RESOURCE_GROUPS)[number];

/** Why a resource does not work as installed: a refusal, a judgment or a harness report code. */
export type ResourceIssue =
  | 'package_limit'
  | 'root_skill'
  | 'extension_load_failed'
  | 'resource_invalid'
  | 'policy_denied'
  | 'sdk_start_failed';

export type ResourceState =
  | 'ready'
  | 'untrusted'
  | 'archived'
  | 'enabled'
  | 'disabled'
  | 'removed'
  | 'refused'
  | 'failed';

export interface ResourceRow {
  key: string;
  name: string;
  /** A version or transport, never a source path. */
  detail?: string;
  scope: 'personal' | 'project';
  state: ResourceState;
  issue?: ResourceIssue;
}

/** The settings section that manages each group. */
const SECTION: Record<ResourceGroup, SettingsSection> = {
  skills: 'skills',
  hooks: 'hooks',
  extensions: 'hooks',
  packages: 'hooks',
  mcp: 'mcp',
};

const TONE: Record<ResourceState, 'green' | 'amber' | 'gray' | 'red'> = {
  ready: 'green',
  enabled: 'green',
  untrusted: 'amber',
  archived: 'gray',
  disabled: 'gray',
  removed: 'gray',
  refused: 'red',
  failed: 'red',
};

/** Hooks are written in Corral; extensions arrive with installed packages. */
const madeInCorral = (resource: Pick<HarnessResource, 'sourceLabel'>) =>
  resource.sourceLabel === 'Created in Corral' || resource.sourceLabel === 'Edited copy';

/** A SKILL.md at the package root makes the whole package one Skill and skips its extensions. */
function rootSkill(resource: HarnessResource) {
  const root = resource.packagePath ? `${resource.packagePath}/SKILL.md` : 'SKILL.md';
  return resource.skills.some((skill) => skill.entry === root);
}

export function entryRows(entries: HarnessEntryView[], group: ResourceGroup): ResourceRow[] {
  return entries
    .filter((entry) =>
      group === 'skills'
        ? entry.kind === 'skill'
        : entry.kind === 'extension' && madeInCorral(entry.resource) === (group === 'hooks'),
    )
    .map((entry) => ({
      key: `${entry.resourceHash}:${entry.entry}`,
      name: entry.name,
      scope: 'personal',
      state: entry.archivedAt ? 'archived' : entry.resource.trustedAt ? 'ready' : 'untrusted',
    }));
}

export function packageRows(packages: PackageView[]): ResourceRow[] {
  return packages
    .filter((item) => !madeInCorral(item.resource))
    .map((item) => ({
      key: item.resource.hash,
      name: item.resource.name,
      detail: item.resource.version,
      scope: 'personal',
      state: item.status === 'enabled' && !item.resource.trustedAt ? 'untrusted' : item.status,
      ...(rootSkill(item.resource) ? { issue: 'root_skill' as const } : {}),
    }));
}

export function mcpRows(config: ProjectToolConfigRevision | null): ResourceRow[] {
  return (config?.mcpServers ?? []).map((server) => ({
    key: server.id,
    name: server.name,
    detail: server.transport === 'http' ? 'HTTP' : 'stdio',
    scope: 'project',
    state: server.enabled === false ? 'disabled' : 'enabled',
  }));
}

type Loaded<T> =
  | { state: 'local' }
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; value: T };

/** One group's data. Without the local server it is "local"; a failure is never "none". */
function useLoaded<T>(load: (() => Promise<T>) | null, deps: DependencyList) {
  const [loaded, setLoaded] = useState<Loaded<T>>(load ? { state: 'loading' } : { state: 'local' });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names what the loader reads
  useEffect(() => {
    if (!load) return setLoaded({ state: 'local' });
    let live = true;
    void attempt;
    setLoaded({ state: 'loading' });
    load().then(
      (value) => live && setLoaded({ state: 'ready', value }),
      () => live && setLoaded({ state: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [...deps, attempt, Boolean(load)]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return [loaded, retry] as const;
}

function map<T, U>(loaded: Loaded<T>, rows: (value: T) => U): Loaded<U> {
  return loaded.state === 'ready' ? { state: 'ready', value: rows(loaded.value) } : loaded;
}

export function LibraryResources({ projectId }: { projectId: string }) {
  const t = useTranslations('Library.resources');
  const { harnesses } = useServices();
  const [entries, retryEntries] = useLoaded(harnesses ? () => harnesses.entries() : null, [
    harnesses,
  ]);
  const [packages, retryPackages] = useLoaded(harnesses ? () => harnesses.packages() : null, [
    harnesses,
  ]);
  const [mcp, retryMcp] = useLoaded(harnesses ? () => harnesses.projectTools(projectId) : null, [
    harnesses,
    projectId,
  ]);
  const groups: Record<ResourceGroup, { rows: Loaded<ResourceRow[]>; retry: () => void }> = {
    skills: { rows: map(entries, (value) => entryRows(value, 'skills')), retry: retryEntries },
    hooks: { rows: map(entries, (value) => entryRows(value, 'hooks')), retry: retryEntries },
    extensions: {
      rows: map(entries, (value) => entryRows(value, 'extensions')),
      retry: retryEntries,
    },
    packages: { rows: map(packages, packageRows), retry: retryPackages },
    mcp: { rows: map(mcp, mcpRows), retry: retryMcp },
  };
  // Without the local server every group is the same one state, said once.
  if (!harnesses) return <EmptyState title={t('localOnly')} />;
  const rowsOf = (group: ResourceGroup) => groups[group].rows;
  // A group is listed when it has rows or failed to load; a failure is never "none".
  const listed = RESOURCE_GROUPS.filter((group) => {
    const rows = rowsOf(group);
    return rows.state === 'failed' || (rows.state === 'ready' && rows.value.length > 0);
  });
  const empty = RESOURCE_GROUPS.filter((group) => {
    const rows = rowsOf(group);
    return rows.state === 'ready' && rows.value.length === 0;
  });
  const loading = RESOURCE_GROUPS.some((group) => rowsOf(group).state === 'loading');
  if (!loading && listed.length === 0)
    return (
      <div className="grid justify-items-center gap-4">
        <div className="w-full">
          <EmptyState title={t('emptyTitle')} />
        </div>
        <AddResources groups={empty} projectId={projectId} />
      </div>
    );
  return (
    <div className="flex flex-col gap-8">
      {listed.map((group) => (
        <ResourceSection
          key={group}
          group={group}
          projectId={projectId}
          rows={groups[group].rows}
          onRetry={groups[group].retry}
        />
      ))}
      {loading ? (
        <p role="status" className="text-body text-muted-foreground">
          {t('loading')}
        </p>
      ) : (
        <AddResources groups={empty} projectId={projectId} />
      )}
    </div>
  );
}

/** The empty groups' way into settings, so adding the first of a kind stays one click away. */
function AddResources({ groups, projectId }: { groups: ResourceGroup[]; projectId: string }) {
  const t = useTranslations('Library.resources');
  const navigation = useSettingsNavigation();
  if (groups.length === 0) return null;
  return (
    <nav aria-label={t('addKinds')} className="flex flex-wrap items-center gap-1">
      {groups.map((group) => (
        <Button
          key={group}
          variant="ghost"
          size="compact"
          aria-label={t('manageNamed', { name: t(`group.${group}`) })}
          render={<Link {...navigation.link(SECTION[group], projectId)} />}
        >
          <Plus aria-hidden />
          {t(`group.${group}`)}
        </Button>
      ))}
    </nav>
  );
}

function ResourceSection({
  group,
  projectId,
  rows,
  onRetry,
}: {
  group: ResourceGroup;
  projectId: string;
  rows: Loaded<ResourceRow[]>;
  onRetry: () => void;
}) {
  const t = useTranslations('Library.resources');
  const heading = useId();
  const name = t(`group.${group}`);
  return (
    <section data-resource-group={group} aria-labelledby={heading} className="flex flex-col gap-2">
      <div id={heading}>
        <SectionLabel {...(rows.state === 'ready' ? { count: rows.value.length } : {})}>
          {name}
        </SectionLabel>
      </div>
      {rows.state === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-body text-destructive">
          <span>{t('loadFailed', { group: name })}</span>
          <Button variant="tertiary" size="compact" onClick={onRetry}>
            {t('retry')}
          </Button>
        </div>
      ) : rows.state === 'ready' ? (
        <ResourceTable group={group} projectId={projectId} rows={rows.value} />
      ) : null}
    </section>
  );
}

/** Rows of one group: name, scope, status, the cause and next step, and "Manage". */
export function ResourceTable({
  group,
  projectId,
  rows,
}: {
  group: ResourceGroup;
  projectId: string;
  rows: ResourceRow[];
}) {
  const t = useTranslations('Library.resources');
  const navigation = useSettingsNavigation();
  return (
    <Table aria-label={t(`group.${group}`)}>
      <TableHeader>
        <TableRow>
          <TableHead>{t('name')}</TableHead>
          <TableHead>{t('scope')}</TableHead>
          <TableHead>{t('status')}</TableHead>
          <TableHead>{t('cause')}</TableHead>
          <TableHead>
            <span className="sr-only">{t('actions')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={row.key} index={index}>
            <TableCell className="text-foreground">
              <span className="break-words">{row.name}</span>
              {row.detail ? (
                <span className="ml-2 text-caption text-muted-foreground">{row.detail}</span>
              ) : null}
            </TableCell>
            <TableCell>{t(`scopes.${row.scope}`)}</TableCell>
            <TableCell>
              <KitBadge
                variant="dot"
                size="compact"
                color={
                  row.issue && row.issue !== 'root_skill'
                    ? 'red'
                    : row.issue
                      ? 'amber'
                      : TONE[row.state]
                }
              >
                {t(`states.${row.state}`)}
              </KitBadge>
            </TableCell>
            <TableCell>
              {row.issue ? (
                <span className="flex flex-col gap-0.5">
                  <span>{t(`issue.${row.issue}.cause`)}</span>
                  <span className="text-caption">{t(`issue.${row.issue}.next`)}</span>
                </span>
              ) : row.state === 'untrusted' ? (
                <span className="text-caption">{t('trustNext')}</span>
              ) : null}
            </TableCell>
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="compact"
                aria-label={t('manageNamed', { name: row.name })}
                render={<Link {...navigation.link(SECTION[group], projectId)} />}
              >
                {t('manage')}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
