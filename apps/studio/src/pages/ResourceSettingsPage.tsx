import type { HarnessApi } from '@corral/client';
import type { HarnessEntryKey, HarnessEntryView, ManagedHook } from '@corral/contracts';
import { Plus, Search } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useManagementConfirmation } from '../workbench/harness/ConfirmAction.tsx';
import { ResourceEditor } from '../workbench/harness/ResourceEditor.tsx';
import { field, operationId } from '../workbench/harness/Target.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { SettingsLayout } from './SettingsPage.tsx';

const keyOf = (entry: HarnessEntryKey) => `${entry.resourceHash}:${entry.entry}`;
const refOf = (entry: HarnessEntryKey): HarnessEntryKey => ({
  resourceHash: entry.resourceHash,
  entry: entry.entry,
  kind: entry.kind,
});
export function SkillSettingsPage() {
  return <ResourceSettingsPage kind="skill" />;
}
export function HookSettingsPage() {
  return <ResourceSettingsPage kind="extension" />;
}
function ResourceSettingsPage({ kind }: { kind: 'skill' | 'extension' }) {
  const { harnesses } = useServices();
  const t = useTranslations('Harness');
  return (
    <SettingsLayout active={kind === 'skill' ? 'skills' : 'hooks'}>
      {harnesses ? (
        <ResourceManager key={kind} api={harnesses} kind={kind} />
      ) : (
        <p className="p-8">{t('localOnly')}</p>
      )}
    </SettingsLayout>
  );
}
function ResourceManager({ api, kind }: { api: HarnessApi; kind: 'skill' | 'extension' }) {
  const t = useTranslations('Resources'),
    h = useTranslations('Harness');
  const n = useTranslations('Navigation');
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
          setEntries(value.filter((entry) => entry.kind === kind));
          setLoaded(true);
        }
      },
      (e) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [api, kind, version]);
  const selected = entries.find((entry) => keyOf(entry) === selection);
  useEffect(() => {
    if (!selection || entries.some((entry) => keyOf(entry) === selection)) return;
    const sameBundle = entries.find((entry) => entry.resourceHash === selection.split(':')[0]);
    if (sameBundle) setSelection(keyOf(sameBundle));
  }, [entries, selection]);
  const filtered = entries.filter(
    (entry) =>
      Boolean(entry.archivedAt) === archived &&
      `${entry.name} ${entry.description} ${entry.resource.name}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  async function work(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      if (alive.current) refresh((n) => n + 1);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6 sm:p-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {t(kind === 'skill' ? 'skills' : 'hooks')}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            {t(kind === 'skill' ? 'skillsIntro' : 'hooksIntro')}
          </p>
        </div>
        <Button ref={add} onClick={() => setEditor({})}>
          <Plus size={16} />
          {t('add')}
        </Button>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(16rem,0.8fr)_minmax(22rem,1.2fr)]">
        <section
          className="max-h-[70vh] min-w-0 overflow-y-auto rounded-xl border border-line"
          aria-label={t('library')}
        >
          <div className="flex flex-col gap-3 border-b border-line p-4">
            <label className="flex items-center gap-2">
              <Search size={16} />
              <input
                aria-label={t('search')}
                className={field}
                value={search}
                placeholder={t('search')}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
              />
              {t('showArchived')}
            </label>
          </div>
          {!loaded ? (
            <p role="status" className="p-5 text-sm text-muted">
              {h('busy')}
            </p>
          ) : !filtered.length ? (
            <p className="p-5 text-sm text-muted">{t(search ? 'noMatches' : 'empty')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {filtered.map((entry) => (
                <li key={keyOf(entry)}>
                  <button
                    type="button"
                    aria-pressed={selection === keyOf(entry)}
                    onClick={() => setSelection(keyOf(entry))}
                    className={`flex w-full flex-col gap-2 p-4 text-left hover:bg-raised ${selection === keyOf(entry) ? 'bg-sidebar-selected' : ''}`}
                  >
                    <span className="font-medium">{entry.name}</span>
                    {entry.description ? (
                      <span className="line-clamp-2 text-sm text-muted">{entry.description}</span>
                    ) : null}
                    <span className="flex flex-wrap gap-2 text-xs text-muted">
                      <span>{entry.resource.trustedAt ? h('trusted') : h('untrusted')}</span>
                      {entry.archivedAt ? <span>{t('archived')}</span> : null}
                      {entry.successor ? <span>{t('newCopy')}</span> : null}
                      {entry.profiles.length ? (
                        <span>{t('profileCount', { count: entry.profiles.length })}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {selected ? (
          <section
            key={keyOf(selected)}
            className="flex min-w-0 flex-col gap-4 rounded-xl border border-line p-5"
            aria-label={t('details')}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">{selected.name}</h3>
                <p className="mt-1 text-xs text-muted">
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
                variant="outline"
                disabled={busy}
                onClick={() => setEditor({ entry: selected })}
              >
                {t('editCopy')}
              </Button>
            </div>
            <Link
              to="/settings/harness"
              search={navigation.search}
              className="text-sm text-accent underline"
            >
              {n('addToWorkStyle')}
            </Link>
            {!selected.resource.trustedAt ? (
              <p className="text-sm text-warning">{t('trustBeforeUse')}</p>
            ) : null}
            {kind === 'extension' ? (
              <p className="text-xs text-warning">{h('nativeWarning')}</p>
            ) : null}
            <EntryContent api={api} entry={selected} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void work(() => api.trust(selected.resourceHash, !selected.resource.trustedAt))
                }
              >
                {selected.resource.trustedAt ? h('revoke') : h('trust')}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  const save = () =>
                    void work(() =>
                      api.archiveEntry(
                        refOf(selected),
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
            </div>
            <p className="text-xs text-muted">{t('packageTrust')}</p>
            <div className="border-t border-line pt-4">
              <h4 className="text-sm font-medium">{t('usages')}</h4>
              {selected.profiles.length ? (
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {selected.profiles.map((profile) => (
                    <li key={`${profile.profileId}:${profile.revision}`}>
                      {profile.name} · r{profile.revision}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted">{t('unused')}</p>
              )}
              <Link
                to="/settings/harness"
                search={navigation.search}
                className="mt-2 inline-block text-sm text-accent underline"
              >
                {t('manageProfiles')}
              </Link>
            </div>
            {selected.successor ? (
              <p className="text-sm">
                {t('newCopy')}{' '}
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() => {
                    setArchived(false);
                    setSelection(keyOf(selected.successor!));
                  }}
                >
                  {t('viewCopy')}
                </button>
              </p>
            ) : null}
          </section>
        ) : (
          <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-line p-6 text-sm text-muted">
            {t('selectItem')}
          </div>
        )}
      </div>
      {editor ? (
        <ResourceEditor
          api={api}
          kind={kind}
          entry={editor.entry}
          onClose={() => {
            setEditor(null);
            add.current?.focus();
          }}
          onSaved={(hash, entry) => {
            setEditor(null);
            setArchived(false);
            setSelection(
              `${hash}:${entry ?? (kind === 'skill' ? 'skills/SKILL.md' : 'extensions/hook.ts')}`,
            );
            refresh((n) => n + 1);
            add.current?.focus();
          }}
        />
      ) : null}
      {confirmation.dialog}
    </main>
  );
}
function EntryContent({ api, entry }: { api: HarnessApi; entry: HarnessEntryView }) {
  const t = useTranslations('Resources'),
    h = useTranslations('Harness');
  const [filesOpen, setFilesOpen] = useState(false);
  const [value, setValue] = useState<{
      content: string;
      hook: ManagedHook | null;
      files: Awaited<ReturnType<HarnessApi['resource']>>['files'];
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([api.readEntry(refOf(entry)), api.resource(entry.resourceHash)]).then(
      ([v, resource]) => active && setValue({ ...v, files: resource.files }),
      (e) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [api, entry]);
  return (
    <>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {entry.kind === 'extension' ? (
        <p className="text-xs text-muted">{t(value?.hook ? 'managedHook' : 'externalExtension')}</p>
      ) : null}
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-subtle p-4 font-mono text-xs">
        {value?.content ?? t('loadingContent')}
      </pre>
      <details className="text-xs text-muted" onToggle={(e) => setFilesOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer">
          {t('advanced')} · {h('files', { count: entry.resource.fileCount })}
        </summary>
        <p className="my-2 break-all font-mono">{entry.resourceHash}</p>
        {filesOpen ? (
          <ul className="max-h-40 overflow-auto">
            {value?.files.map((file) => (
              <li key={file.path}>
                {file.path} · {file.bytes} B
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </>
  );
}
