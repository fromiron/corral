import type { HarnessApi, McpProbeResult } from '@corral/client';
import type { ProjectToolConfigRevision, RegisteredMcpServer } from '@corral/contracts';
import { Plus, Search } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useManagementConfirmation } from '../workbench/harness/ConfirmAction.tsx';
import { McpEditor, mcpDraft } from '../workbench/harness/McpEditor.tsx';
import { field, operationId } from '../workbench/harness/Target.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { McpConnection } from './McpSettings.tsx';
import { SettingsLayout } from './SettingsPage.tsx';

export function McpSettingsPage() {
  const { harnesses } = useServices(),
    { projectId } = useSettingsNavigation();
  const t = useTranslations('Harness');
  return (
    <SettingsLayout active="mcp">
      {harnesses && projectId ? (
        <McpManager key={projectId} api={harnesses} projectId={projectId} />
      ) : !harnesses ? (
        <p className="p-8">{t('localOnly')}</p>
      ) : null}
    </SettingsLayout>
  );
}
function McpManager({ api, projectId }: { api: HarnessApi; projectId: string }) {
  const t = useTranslations('Resources'),
    h = useTranslations('Harness');
  const n = useTranslations('Navigation');
  const navigation = useSettingsNavigation();
  const confirmation = useManagementConfirmation();
  const [config, setConfig] = useState<ProjectToolConfigRevision | null>(null),
    [loaded, setLoaded] = useState(false);
  const [history, setHistory] = useState<Awaited<ReturnType<HarnessApi['mcpHistory']>>>([]);
  const [search, setSearch] = useState(''),
    [selection, setSelection] = useState('');
  const [editor, setEditor] = useState<{ server?: RegisteredMcpServer } | null>(null);
  const [usages, setUsages] = useState<Awaited<ReturnType<HarnessApi['mcpUsages']>>>([]);
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [pendingEnabled, setPendingEnabled] = useState<{ id: string; value: boolean } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [version, refresh] = useState(0);
  const active = useRef(true),
    add = useRef<HTMLButtonElement>(null);
  const selected = config?.mcpServers?.find((server) => server.id === selection);
  const verified = probe?.configRevision === config?.revision ? probe : null;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let owned = true;
    void version;
    void Promise.all([api.projectTools(projectId), api.mcpHistory(projectId)]).then(
      ([config, history]) => {
        if (owned) {
          setConfig(config);
          setHistory(history);
          setLoaded(true);
        }
      },
      (e) => owned && setError(e.message),
    );
    return () => {
      owned = false;
    };
  }, [api, projectId, version]);
  useEffect(() => {
    let owned = true;
    void config?.revision;
    setUsages([]);
    setProbe(null);
    if (selection)
      void api.mcpUsages(projectId, selection).then(
        (value) => owned && setUsages(value),
        (e) => owned && setError(e.message),
      );
    return () => {
      owned = false;
    };
  }, [api, projectId, selection, config?.revision]);
  async function work(action: () => Promise<ProjectToolConfigRevision>) {
    setBusy(true);
    setError('');
    try {
      const saved = await action();
      if (active.current) {
        setConfig(saved);
        setProbe(null);
        refresh((n) => n + 1);
      }
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (active.current) {
        setBusy(false);
        setPendingEnabled(null);
      }
    }
  }
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6 sm:p-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t('mcp')}</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted">{t('mcpIntro')}</p>
        </div>
        <Button ref={add} disabled={!loaded} onClick={() => setEditor({})}>
          <Plus size={16} />
          {t('add')}
        </Button>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}{' '}
          <Link
            to="/settings"
            search={{ ...navigation.search, section: 'workspace' }}
            className="underline"
          >
            {h('manageChecks')}
          </Link>
        </p>
      ) : null}
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(16rem,0.8fr)_minmax(22rem,1.2fr)]">
        <section
          className="max-h-[70vh] min-w-0 overflow-y-auto rounded-xl border border-line"
          aria-label={t('mcp')}
        >
          <label className="flex items-center gap-2 border-b border-line p-4">
            <Search size={16} />
            <input
              className={field}
              aria-label={t('search')}
              placeholder={t('search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {!loaded ? (
            <p role="status" className="p-5 text-sm">
              {h('busy')}
            </p>
          ) : !config?.mcpServers?.length ? (
            <p className="p-5 text-sm text-muted">{t('noServers')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {config.mcpServers
                .filter((server) =>
                  server.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
                )
                .map((server) => (
                  <li key={server.id}>
                    <button
                      type="button"
                      aria-pressed={selection === server.id}
                      onClick={() => {
                        setSelection(server.id);
                      }}
                      className={`flex w-full flex-col gap-2 p-4 text-left hover:bg-raised ${selection === server.id ? 'bg-sidebar-selected' : ''}`}
                    >
                      <span className="font-medium">{server.name}</span>
                      <span className="text-xs text-muted">
                        {server.transport === 'http' ? 'HTTP' : h('mcpStdio')} ·{' '}
                        {t(server.enabled === false ? 'disabled' : 'enabled')}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </section>
        {selected && config ? (
          <section
            className="flex min-w-0 flex-col gap-4 rounded-xl border border-line p-5"
            aria-label={t('details')}
          >
            <header className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold">{selected.name}</h3>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setEditor({ server: selected })}
              >
                {t('edit')}
              </Button>
            </header>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={
                  pendingEnabled?.id === selected.id
                    ? pendingEnabled.value
                    : selected.enabled !== false
                }
                disabled={busy}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setPendingEnabled({ id: selected.id, value: enabled });
                  void work(() =>
                    api.saveMcp(
                      projectId,
                      config.revision,
                      operationId(),
                      { ...mcpDraft(selected), enabled },
                      selected.id,
                    ),
                  );
                }}
              />
              {t('enabled')}
            </label>
            <p className="text-xs text-muted">{t('mcpEnableHint')}</p>
            <Link
              to="/settings/harness"
              search={navigation.search}
              className="text-sm text-accent underline"
            >
              {n('connectWorkStyle')}
            </Link>
            <McpConnection
              key={`${config.revision}:${selected.id}`}
              api={api}
              projectId={projectId}
              server={selected}
              onProbe={setProbe}
              disabled={busy}
            />
            {verified ? (
              <div className="flex flex-col gap-3 rounded-lg bg-raised p-4">
                <p role="status" className="text-sm font-medium">
                  {t('probeObserved', {
                    time: new Date(verified.observedAt).toLocaleTimeString(),
                    count: verified.tools.length,
                  })}
                </p>
                {!verified.tools.length ? (
                  <p className="text-sm text-muted">{t('probeEmpty')}</p>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {verified.tools.map((tool) => (
                      <li key={tool.name}>
                        {tool.title}
                        <p className="text-xs text-muted">{tool.description}</p>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted">{t('toolDiscoveryHint')}</p>
              </div>
            ) : null}
            <div className="border-t border-line pt-3">
              <h4 className="text-sm font-medium">{t('usages')}</h4>
              {usages.length ? (
                <ul className="mt-2 text-sm">
                  {usages.map((usage) => (
                    <li key={usage.id}>
                      {usage.name} · r{usage.binding.revision}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted">{t('mcpUsageEmpty')}</p>
              )}
            </div>
            <Button
              className="self-start"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                confirmation.request(
                  t('removeMcpConfirm'),
                  () =>
                    void work(() =>
                      api.removeMcp(projectId, selected.id, config.revision, operationId()),
                    ),
                );
              }}
            >
              {t('remove')}
            </Button>
          </section>
        ) : (
          <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-line p-6 text-sm text-muted">
            {t('selectItem')}
          </div>
        )}
      </div>
      {history.length ? (
        <details>
          <summary className="cursor-pointer text-sm">{t('removedServers')}</summary>
          <p className="my-3 text-xs text-muted">{t('mcpRestored')}</p>
          <ul className="divide-y divide-line">
            {history.map((item) => (
              <li
                key={`${item.server.id}:${item.configRevision}`}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <span className="text-sm">
                  {item.server.name} · r{item.configRevision}
                </span>
                <div className="flex gap-2">
                  {item.canRestore ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void work(() =>
                          api.removeMcp(
                            projectId,
                            item.server.id,
                            config?.revision ?? 0,
                            operationId(),
                            item.configRevision,
                          ),
                        )
                      }
                    >
                      {t('restore')}
                    </Button>
                  ) : null}
                  {item.server.transport === 'http' &&
                  item.server.auth.kind !== 'none' &&
                  item.fingerprint ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        confirmation.request(
                          t('logoutHint'),
                          () =>
                            void api
                              .signOutMcp(
                                projectId,
                                item.server.id,
                                item.fingerprint!,
                                item.configRevision,
                              )
                              .catch((e) => setError(e.message)),
                        );
                      }}
                    >
                      {t('forgetAuth')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {editor ? (
        <McpEditor
          api={api}
          projectId={projectId}
          revision={config?.revision ?? 0}
          server={editor.server}
          onClose={() => {
            setEditor(null);
            add.current?.focus();
          }}
          onSaved={(saved) => {
            setConfig(saved);
            setSelection(saved.mcpServers?.at(-1)?.id ?? '');
            setEditor(null);
            setProbe(null);
            refresh((n) => n + 1);
            add.current?.focus();
          }}
        />
      ) : null}
      {confirmation.dialog}
    </main>
  );
}
