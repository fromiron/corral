import type { HarnessApi } from '@corral/client';
import type { HarnessEntryKey, HarnessEntryView, ManagedHook } from '@corral/contracts';
import { Plus } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useManagementConfirmation } from '../workbench/harness/ConfirmAction.tsx';
import { PackageManager } from '../workbench/harness/PackageManager.tsx';
import { ResourceEditor } from '../workbench/harness/ResourceEditor.tsx';
import { SkillQualityPanel } from '../workbench/harness/SkillQualityPanel.tsx';
import { field, operationId } from '../workbench/harness/Target.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
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
  const runSettingsTask = useSettingsTask(`resources:${kind}`);

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
  return (
    <main className="settings-content">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          {t(kind === 'skill' ? 'skills' : 'hooks')}
        </h2>
        <p className="mt-2 text-sm text-muted">
          {t(kind === 'skill' ? 'skillsIntro' : 'hooksIntro')}
        </p>
      </div>
      <section className="settings-row">
        <div>
          <h3>{t('library')}</h3>
        </div>
        <Button ref={add} onClick={() => setEditor({})}>
          <Plus size={16} />
          {t('add')}
        </Button>
      </section>
      <section className="settings-row">
        <div>
          <h3>{t('search')}</h3>
        </div>
        <input
          aria-label={t('search')}
          className={`${field} sm:w-72`}
          value={search}
          placeholder={t('search')}
          onChange={(e) => setSearch(e.target.value)}
        />
      </section>
      <section className="settings-row">
        <div>
          <h3>{t('showArchived')}</h3>
        </div>
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
      </section>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-6">
        <section className="settings-list max-h-80 overflow-y-auto" aria-label={t('library')}>
          {!loaded ? (
            <p role="status" className="p-5 text-sm text-muted">
              {h('busy')}
            </p>
          ) : !filtered.length ? (
            <p className="p-5 text-sm text-muted">{t(search ? 'noMatches' : 'empty')}</p>
          ) : (
            <ul className="flex flex-col">
              {filtered.map((entry) => (
                <li key={keyOf(entry)}>
                  <button
                    type="button"
                    aria-pressed={selection === keyOf(entry)}
                    onClick={() => setSelection(keyOf(entry))}
                    className={`flex w-full flex-col gap-2 p-4 text-left hover:bg-surface ${selection === keyOf(entry) ? 'bg-sidebar-selected' : ''}`}
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
          <section key={keyOf(selected)} className="flex flex-col gap-6" aria-label={t('details')}>
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
                variant="outline"
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
                {kind === 'extension' ? <p className="text-warning">{h('nativeWarning')}</p> : null}
              </div>
              <Button
                variant="outline"
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
                variant="outline"
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
            </section>
            <section className="settings-row">
              <div>
                <h3>{n('addToWorkStyle')}</h3>
                <p>
                  {selected.profiles.length
                    ? selected.profiles
                        .map((profile) => `${profile.name} · r${profile.revision}`)
                        .join(', ')
                    : t('unused')}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" render={<Link {...navigation.link('harness')} />}>
                  {n('addToWorkStyle')}
                </Button>
                <Button variant="outline" render={<Link {...navigation.link('harness')} />}>
                  {t('manageProfiles')}
                </Button>
              </div>
            </section>
            {kind === 'skill' && !selected.archivedAt ? (
              <SkillQualityPanel
                api={api}
                entry={selected}
                entries={entries}
                onChanged={() => refresh((value) => value + 1)}
              />
            ) : null}
            {selected.successor ? (
              <section className="settings-row">
                <div>
                  <h3>{t('newCopy')}</h3>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    setArchived(false);
                    setSelection(keyOf(selected.successor!));
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
        ) : (
          <p className="text-sm text-muted">{t('selectItem')}</p>
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
      {kind === 'extension' ? (
        <PackageManager api={api} onChanged={() => refresh((n) => n + 1)} />
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
