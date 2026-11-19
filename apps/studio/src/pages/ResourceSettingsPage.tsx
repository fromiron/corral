import type { HarnessApi } from '@corral/client';
import type { HarnessEntryView } from '@corral/contracts';
import { EmptyView } from '@corral/react';
import { Button, cn, fontWeights, Input, Switch } from '@corral/react/design-kit';
import { Plus } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { CHOSEN_BUTTON_ROW } from '../workbench/chosenRow.ts';
import { useManagementConfirmation } from '../workbench/harness/ConfirmAction.tsx';
import { EntryContent, entryId, entryKey } from '../workbench/harness/EntryContent.tsx';
import { PackageManager } from '../workbench/harness/PackageManager.tsx';
import { ResourceEditor } from '../workbench/harness/ResourceEditor.tsx';
import { SkillManager } from '../workbench/harness/SkillManager.tsx';
import { operationId } from '../workbench/harness/Target.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { SectionIndex } from '../workbench/SectionIndex.tsx';
import { useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { SettingsLayout } from './SettingsPage.tsx';

export function SkillSettingsPage() {
  const { harnesses } = useServices();
  const t = useTranslations('Library.resources');
  return (
    <SettingsLayout active="skills">
      <main className="settings-content">
        {harnesses ? (
          <SkillManager api={harnesses} />
        ) : (
          <p className="text-body text-muted-foreground">{t('localOnly')}</p>
        )}
      </main>
    </SettingsLayout>
  );
}
export function HookSettingsPage() {
  const { harnesses } = useServices();
  const t = useTranslations('Harness');
  return (
    <SettingsLayout active="hooks">
      {harnesses ? (
        <HookManager api={harnesses} />
      ) : (
        <main className="settings-content">
          <p className="text-body text-muted-foreground">{t('localOnly')}</p>
        </main>
      )}
    </SettingsLayout>
  );
}
function HookManager({ api }: { api: HarnessApi }) {
  const t = useTranslations('Resources'),
    h = useTranslations('Harness');
  const n = useTranslations('Navigation');
  const p = useTranslations('Packages');
  const navigation = useSettingsNavigation();
  const confirmation = useManagementConfirmation();
  const [entries, setEntries] = useState<HarnessEntryView[]>([]),
    [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState(''),
    [search, setSearch] = useState(''),
    [archived, setArchived] = useState(false);
  const [version, refresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [editor, setEditor] = useState<{ entry?: HarnessEntryView } | null>(null);
  const alive = useRef(true),
    add = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void version;
    void api.entries().then(
      (value) => {
        if (active) {
          setEntries(value.filter((entry) => entry.kind === 'extension'));
          setLoaded(true);
        }
      },
      (e) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [api, version]);
  const selected = entries.find((entry) => entryId(entry) === selection);
  // Manage in the library opens this page to choose one entry (features/library.md): once, after
  // the first load, and only an exact match, so a package's hash meant for the package list
  // below never picks one of its entries. The person's own choice wins from then on.
  const carried = useRef(navigation.item);
  const chosenRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!loaded || !carried.current) return;
    const item = carried.current;
    carried.current = undefined;
    const entry = entries.find((value) => entryId(value) === item);
    if (!entry) return;
    setArchived(Boolean(entry.archivedAt));
    setSelection(item);
    requestAnimationFrame(() => chosenRow.current?.scrollIntoView?.({ block: 'nearest' }));
  }, [loaded, entries]);
  useEffect(() => {
    if (!selection || entries.some((entry) => entryId(entry) === selection)) return;
    const sameBundle = entries.find((entry) => selection.startsWith(`${entry.resourceHash}:`));
    if (sameBundle) setSelection(entryId(sameBundle));
  }, [entries, selection]);
  const filtered = entries.filter(
    (entry) =>
      Boolean(entry.archivedAt) === archived &&
      `${entry.name} ${entry.description} ${entry.resource.name}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const runSettingsTask = useSettingsTask('resources:extension');

  async function work(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await runSettingsTask(action);
      if (alive.current) refresh((n) => n + 1);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  // Nothing at all, archived included: one empty state that carries the Add action.
  const none = loaded && entries.length === 0;
  // The first saved item replaces the empty state and the Add focus went back to; focus moves on
  // to the Add above the list.
  const wasNone = useRef(none);
  useLayoutEffect(() => {
    if (wasNone.current && !none && document.activeElement === document.body) add.current?.focus();
    wasNone.current = none;
  }, [none]);
  return (
    <main className="settings-content">
      {/* Package management lives below the hook library; with a library above it the top of the
          page says so and lets the keyboard jump there (#82). An empty library leaves the
          Packages heading right below, and the row would only repeat it. */}
      {entries.length > 0 ? (
        <SectionIndex
          sections={[
            { id: 'resources-library', label: t('library') },
            { id: 'resources-packages', label: p('title') },
          ]}
        />
      ) : null}
      <section
        id="resources-library"
        tabIndex={-1}
        aria-label={t('library')}
        className="flex flex-wrap items-center gap-3 outline-none"
      >
        {none ? null : (
          <>
            <Input
              aria-label={t('search')}
              className="min-w-0 flex-1 sm:max-w-72"
              value={search}
              placeholder={t('search')}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Switch
              label={t('showArchived')}
              checked={archived}
              onToggle={() => setArchived(!archived)}
            />
          </>
        )}
        {none ? (
          <EmptyView
            className="w-full"
            title={t('emptyHooks')}
            action={{ label: t('add'), onClick: () => setEditor({}), ref: add }}
          />
        ) : (
          <Button ref={add} className="ml-auto" onClick={() => setEditor({})}>
            <Plus size={16} />
            {t('add')}
          </Button>
        )}
      </section>
      {error ? (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-6 empty:hidden">
        {none ? null : (
          <section className="settings-list max-h-80 overflow-y-auto" aria-label={t('library')}>
            {!loaded ? (
              <p role="status" className="p-5 text-body text-muted-foreground">
                {h('busy')}
              </p>
            ) : !filtered.length ? (
              <p className="p-5 text-body text-muted-foreground">
                {t(search ? 'noMatches' : archived ? 'noArchived' : 'onlyArchived')}
              </p>
            ) : (
              <ul className="flex flex-col">
                {filtered.map((entry) => (
                  <li key={entryId(entry)}>
                    <Button
                      ref={selection === entryId(entry) ? chosenRow : undefined}
                      variant="ghost"
                      aria-pressed={selection === entryId(entry)}
                      onClick={() => setSelection(entryId(entry))}
                      className={cn(
                        'h-auto w-full flex-col items-start gap-1.5 whitespace-normal p-3 text-left',
                        selection === entryId(entry) && CHOSEN_BUTTON_ROW,
                      )}
                    >
                      <span style={{ fontVariationSettings: fontWeights.semibold }}>
                        {entry.name}
                      </span>
                      {entry.description ? (
                        <span className="line-clamp-2 text-body text-muted-foreground">
                          {entry.description}
                        </span>
                      ) : null}
                      <span className="flex flex-wrap gap-2 text-caption text-muted-foreground">
                        <span>{entry.resource.trustedAt ? h('trusted') : h('untrusted')}</span>
                        {entry.archivedAt ? <span>{t('archived')}</span> : null}
                        {entry.successor ? <span>{t('newCopy')}</span> : null}
                        {entry.profiles.length ? (
                          <span>{t('profileCount', { count: entry.profiles.length })}</span>
                        ) : null}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {selected ? (
          <section
            key={entryId(selected)}
            className="flex flex-col gap-6"
            aria-label={t('details')}
          >
            <section className="settings-row">
              <div>
                <h3>{selected.name}</h3>
                <p>
                  {t(
                    selected.resource.sourceLabel === 'Created in Corral'
                      ? 'savedCopy'
                      : selected.resource.sourceLabel === 'Edited copy'
                        ? 'editedCopy'
                        : selected.resource.sourceKind === 'local'
                          ? 'importedCopy'
                          : 'pinnedPackage',
                  )}{' '}
                  · {selected.resource.version}
                </p>
              </div>
              <Button
                variant="tertiary"
                disabled={busy}
                onClick={() => setEditor({ entry: selected })}
              >
                {t('editCopy')}
              </Button>
            </section>
            <section className="settings-row">
              <div>
                <h3>{selected.resource.trustedAt ? h('trusted') : h('untrusted')}</h3>
                <p>{selected.resource.trustedAt ? t('packageTrust') : t('trustBeforeUse')}</p>
                <p className="text-warning">{h('nativeWarning')}</p>
              </div>
              <Button
                variant="tertiary"
                disabled={busy}
                onClick={() =>
                  void work(() => api.trust(selected.resourceHash, !selected.resource.trustedAt))
                }
              >
                {selected.resource.trustedAt ? h('revoke') : h('trust')}
              </Button>
            </section>
            <section className="settings-row">
              <div>
                <h3>{t(selected.archivedAt ? 'restore' : 'archive')}</h3>
              </div>
              <Button
                variant="tertiary"
                disabled={busy}
                onClick={() => {
                  const save = () =>
                    void work(() =>
                      api.archiveEntry(
                        entryKey(selected),
                        selected.managementRevision,
                        !selected.archivedAt,
                        operationId(),
                      ),
                    );
                  if (selected.archivedAt) save();
                  else confirmation.request(t('archiveConfirm'), save);
                }}
              >
                {t(selected.archivedAt ? 'restore' : 'archive')}
              </Button>
            </section>
            <section className="settings-row">
              <div>
                <h3>{t('usedBy')}</h3>
                <p>
                  {selected.profiles.length
                    ? selected.profiles
                        .map((profile) => `${profile.name} · r${profile.revision}`)
                        .join(', ')
                    : t('unused')}
                </p>
              </div>
              {/* One way there, named for what happens: nothing is added from here (#79). */}
              <Button
                variant="tertiary"
                className="self-start sm:self-end"
                render={<Link {...navigation.link('harness')} />}
              >
                {n('addToWorkStyle')}
              </Button>
            </section>
            {selected.successor ? (
              <section className="settings-row">
                <div>
                  <h3>{t('newCopy')}</h3>
                </div>
                <Button
                  variant="tertiary"
                  onClick={() => {
                    if (!selected.successor) return;
                    setArchived(false);
                    setSelection(entryId(selected.successor));
                  }}
                >
                  {t('viewCopy')}
                </Button>
              </section>
            ) : null}
            <section className="settings-surface">
              <EntryContent api={api} entry={selected} />
            </section>
          </section>
        ) : null}
      </div>
      {editor ? (
        <ResourceEditor
          api={api}
          kind="extension"
          entry={editor.entry}
          onClose={() => {
            setEditor(null);
            add.current?.focus();
          }}
          onSaved={(hash, entry) => {
            setEditor(null);
            setArchived(false);
            setSelection(`${hash}:${entry ?? 'extensions/hook.ts'}`);
            refresh((n) => n + 1);
            add.current?.focus();
          }}
        />
      ) : null}
      {/* Below the hook library, named by its own heading. */}
      <div id="resources-packages" tabIndex={-1} className="outline-none">
        <PackageManager api={api} onChanged={() => refresh((n) => n + 1)} />
      </div>
      {confirmation.dialog}
    </main>
  );
}
