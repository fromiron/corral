import type { HarnessApi } from '@corral/client';
import { type ProjectToolConfigRevision, RegisteredLspServer } from '@corral/contracts';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';

const field = 'w-full rounded-md border border-line bg-surface p-2 text-sm';
const empty = { id: '', name: '', argv: '', languages: '', extensions: '', seconds: '30' };
export function ProjectToolSettings({
  api,
  projectId,
  config,
  onChange,
}: {
  api: HarnessApi;
  projectId: string;
  config: ProjectToolConfigRevision | null;
  onChange(config: ProjectToolConfigRevision): void;
}) {
  const t = useTranslations('Harness'),
    heading = useId();
  const [draft, setDraft] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [launches, setLaunches] = useState<
    Record<string, Awaited<ReturnType<HarnessApi['inspectProjectTool']>>>
  >({});
  async function work(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (error) {
      setError(error instanceof Error ? error.message : t('error'));
    } finally {
      setBusy(false);
    }
  }
  async function save(servers: RegisteredLspServer[]) {
    const saved = await api.saveProjectTools(projectId, config?.revision ?? 0, {
      checks: config?.checks ?? [],
      lspServers: servers,
      ...(config?.mcpServers ? { mcpServers: config.mcpServers } : {}),
    });
    onChange(saved);
    setLaunches({});
    setEditing(null);
    setDraft(empty);
    setNotice(t('toolsSaved', { revision: saved.revision }));
  }
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-5" aria-labelledby={heading}>
      <h3 id={heading} className="text-lg font-semibold">
        {t('projectTools')}
      </h3>
      <p className="text-xs text-muted">{t('checkTrustHint')}</p>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {busy || notice ? (
        <p role="status" className="text-sm">
          {busy ? t('busy') : notice}
        </p>
      ) : null}
      {(
        [
          ['check', config?.checks ?? []],
          ['lsp', config?.lspServers ?? []],
        ] as const
      ).map(([kind, tools]) => (
        <div key={kind} className="flex flex-col gap-3">
          <h4 className="font-medium">{t(kind === 'check' ? 'projectChecks' : 'projectLsp')}</h4>
          {kind === 'check' ? (
            <Link
              to="/settings"
              search={{ section: 'workspace' }}
              className="text-sm text-accent underline"
            >
              {t('manageChecks')}
            </Link>
          ) : (
            <p className="text-xs text-muted">{t('lspSetupHint')}</p>
          )}
          {!tools.length ? (
            <p className="text-xs text-muted">
              {t(kind === 'check' ? 'noProjectChecks' : 'noProjectLsp')}
            </p>
          ) : null}
          {tools.map((tool) => {
            const key = `${kind}:${tool.id}`,
              launch = launches[key];
            return (
              <div key={key} className="flex flex-col gap-2 border-b border-line pb-3">
                <p className="text-sm font-medium">
                  {tool.name} <span className="text-muted">{tool.id}</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void work(async () => {
                        const inspected = await api.inspectProjectTool(projectId, kind, tool.id);
                        setLaunches((current) => ({ ...current, [key]: inspected }));
                      })
                    }
                  >
                    {t('reviewCheck', { name: tool.name })}
                  </Button>
                  {kind === 'lsp' && 'languageIds' in tool ? (
                    <>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setEditing(tool.id);
                          setDraft({
                            id: tool.id,
                            name: tool.name,
                            argv: tool.argv.join('\n'),
                            languages: tool.languageIds.join(', '),
                            extensions: tool.fileExtensions.join(', '),
                            seconds: String(tool.timeoutMs / 1000),
                          });
                        }}
                      >
                        {t('editLsp', { name: tool.name })}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void work(() =>
                            save(
                              (config?.lspServers ?? []).filter((server) => server.id !== tool.id),
                            ),
                          )
                        }
                      >
                        {t('removeLsp', { name: tool.name })}
                      </Button>
                    </>
                  ) : null}
                </div>
                {launch ? (
                  <>
                    <code className="break-all text-xs">{JSON.stringify(launch.command.argv)}</code>
                    <p className="break-all font-mono text-2xs text-muted">
                      SHA-256 {launch.fingerprint}
                    </p>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void work(async () => {
                          const saved = await api.trustProjectTool(
                            projectId,
                            kind,
                            tool.id,
                            launch.fingerprint,
                            !launch.trustedAt,
                          );
                          setLaunches((current) => ({
                            ...current,
                            [key]: { ...launch, ...saved },
                          }));
                        })
                      }
                    >
                      {t(launch.trustedAt ? 'revokeCheckTrust' : 'trustCheck')}
                    </Button>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
      <fieldset disabled={busy} className="flex flex-col gap-3">
        <legend className="mb-3 font-medium">{t('configureLsp')}</legend>
        {(
          [
            ['id', 'lspId'],
            ['name', 'lspName'],
            ['languages', 'lspLanguages'],
            ['extensions', 'lspExtensions'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex flex-col gap-1 text-sm">
            {t(label)}
            <input
              className={field}
              value={draft[key]}
              disabled={key === 'id' && editing !== null}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [key]: event.target.value }))
              }
            />
          </label>
        ))}
        <label className="flex flex-col gap-1 text-sm">
          {t('lspArgv')}
          <textarea
            className={field}
            rows={3}
            value={draft.argv}
            onChange={(event) => setDraft((current) => ({ ...current, argv: event.target.value }))}
          />
        </label>
        <p className="text-xs text-muted">{t('lspArgvHint')}</p>
        <label className="flex flex-col gap-1 text-sm">
          {t('lspTimeout')}
          <input
            type="number"
            min={1}
            max={1800}
            className={field}
            value={draft.seconds}
            onChange={(event) =>
              setDraft((current) => ({ ...current, seconds: event.target.value }))
            }
          />
        </label>
        <div className="flex gap-2">
          <Button
            disabled={
              !draft.id.trim() ||
              !draft.name.trim() ||
              !draft.argv.trim() ||
              !draft.languages.trim() ||
              !draft.extensions.trim()
            }
            onClick={() =>
              void work(async () => {
                const parsed = RegisteredLspServer.safeParse({
                  id: draft.id.trim(),
                  name: draft.name,
                  argv: draft.argv.split('\n').map((value) => value.trim()),
                  languageIds: draft.languages.split(/[\s,]+/).filter(Boolean),
                  fileExtensions: draft.extensions.split(/[\s,]+/).filter(Boolean),
                  timeoutMs: Number(draft.seconds) * 1000,
                });
                if (!parsed.success) throw new Error(t('invalidLsp'));
                if (!editing && config?.lspServers.some((server) => server.id === parsed.data.id))
                  throw new Error(t('duplicateLsp'));
                await save([
                  ...(config?.lspServers ?? []).filter((server) => server.id !== editing),
                  parsed.data,
                ]);
              })
            }
          >
            {t('saveLsp')}
          </Button>
          {editing ? (
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(null);
                setDraft(empty);
              }}
            >
              {t('cancelLsp')}
            </Button>
          ) : null}
        </div>
      </fieldset>
    </section>
  );
}
