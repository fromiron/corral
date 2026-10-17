import type { HarnessApi } from '@corral/client';
import { type ProjectToolConfigRevision, RegisteredMcpServer } from '@corral/contracts';
import { Button } from '@corral/react/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

const field = 'w-full rounded-md border border-line bg-surface p-2 text-sm';
const empty = {
  id: '',
  name: '',
  transport: 'stdio',
  argv: '',
  url: '',
  auth: 'none',
  credentialRef: '',
  scope: '',
  clientId: '',
  exposure: 'direct',
  seconds: '30',
};
export function McpSettings({
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
  const t = useTranslations('Harness');
  const [draft, setDraft] = useState(empty),
    [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function save(servers: RegisteredMcpServer[]) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await api.saveProjectTools(projectId, config?.revision ?? 0, {
        checks: config?.checks ?? [],
        lspServers: config?.lspServers ?? [],
        mcpServers: servers,
      });
      onChange(saved);
      setDraft(empty);
      setEditing(null);
      setNotice(t('toolsSaved', { revision: saved.revision }));
    } catch (error) {
      setError(error instanceof Error ? error.message : t('error'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-5" aria-label={t('projectMcp')}>
      <h4 className="font-medium">{t('projectMcp')}</h4>
      <p className="text-xs text-muted">{t('mcpSetupHint')}</p>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {!config?.mcpServers?.length ? (
        <p className="text-xs text-muted">{t('noProjectMcp')}</p>
      ) : null}
      {(config?.mcpServers ?? []).map((server) => (
        <div
          key={`${config?.revision}:${server.id}`}
          className="flex flex-col gap-2 border-b border-line pb-3"
        >
          <McpConnection api={api} projectId={projectId} server={server} />
          <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(server.id);
                setDraft({
                  ...empty,
                  id: server.id,
                  name: server.name,
                  transport: server.transport,
                  exposure: server.exposure,
                  seconds: String(server.timeoutMs / 1000),
                  ...(server.transport === 'stdio'
                    ? { argv: server.argv.join('\n') }
                    : {
                        url: server.url,
                        auth: server.auth.kind,
                        ...(server.auth.kind !== 'none'
                          ? { credentialRef: server.auth.credentialRef }
                          : {}),
                        ...(server.auth.kind === 'oauth'
                          ? { scope: server.auth.scope, clientId: server.auth.clientId ?? '' }
                          : {}),
                      }),
                });
              }}
            >
              {t('editLsp', { name: server.name })}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void save((config?.mcpServers ?? []).filter((item) => item.id !== server.id))
              }
            >
              {t('removeLsp', { name: server.name })}
            </Button>
          </div>
        </div>
      ))}
      <fieldset disabled={busy} className="flex flex-col gap-3">
        <legend className="py-2 font-medium">{t('configureMcp')}</legend>
        {(['id', 'name'] as const).map((key) => (
          <label key={key} className="flex flex-col gap-1 text-sm">
            {t(key === 'id' ? 'mcpId' : 'mcpName')}
            <input
              className={field}
              value={draft[key]}
              disabled={key === 'id' && !!editing}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </label>
        ))}
        <label className="flex flex-col gap-1 text-sm">
          {t('mcpTransport')}
          <select
            className={field}
            value={draft.transport}
            onChange={(e) => setDraft({ ...draft, transport: e.target.value })}
          >
            <option value="stdio">{t('mcpStdio')}</option>
            <option value="http">{t('mcpHttp')}</option>
          </select>
        </label>
        {draft.transport === 'stdio' ? (
          <>
            <label className="flex flex-col gap-1 text-sm">
              {t('mcpArgv')}
              <textarea
                className={field}
                rows={3}
                value={draft.argv}
                onChange={(e) => setDraft({ ...draft, argv: e.target.value })}
              />
            </label>
            <p className="text-xs text-muted">{t('mcpArgvHint')}</p>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              {t('mcpUrl')}
              <input
                type="url"
                className={field}
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('mcpAuth')}
              <select
                className={field}
                value={draft.auth}
                onChange={(e) => setDraft({ ...draft, auth: e.target.value })}
              >
                <option value="none">{t('mcpAuthNone')}</option>
                <option value="bearer">{t('mcpAuthBearer')}</option>
                <option value="oauth">OAuth</option>
              </select>
            </label>
            {draft.auth !== 'none' ? (
              <label className="flex flex-col gap-1 text-sm">
                {t('mcpCredentialRef')}
                <input
                  className={field}
                  value={draft.credentialRef}
                  onChange={(e) => setDraft({ ...draft, credentialRef: e.target.value })}
                />
              </label>
            ) : null}
            {draft.auth === 'oauth' ? (
              <>
                {(['scope', 'clientId'] as const).map((key) => (
                  <label key={key} className="flex flex-col gap-1 text-sm">
                    {t(key === 'scope' ? 'mcpScope' : 'mcpClientId')}
                    <input
                      className={field}
                      value={draft[key]}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    />
                  </label>
                ))}
              </>
            ) : null}
          </>
        )}
        <label className="flex flex-col gap-1 text-sm">
          {t('mcpExposure')}
          <select
            className={field}
            value={draft.exposure}
            onChange={(e) => setDraft({ ...draft, exposure: e.target.value })}
          >
            <option value="direct">{t('mcpDirect')}</option>
            <option value="codemode">{t('mcpCodemode')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('mcpTimeout')}
          <input
            className={field}
            type="number"
            min={1}
            max={300}
            value={draft.seconds}
            onChange={(e) => setDraft({ ...draft, seconds: e.target.value })}
          />
        </label>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              const parsed = RegisteredMcpServer.safeParse({
                id: draft.id.trim(),
                name: draft.name.trim(),
                transport: draft.transport,
                exposure: draft.exposure,
                timeoutMs: Number(draft.seconds) * 1000,
                ...(draft.transport === 'stdio'
                  ? {
                      argv: draft.argv
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean),
                    }
                  : {
                      url: draft.url.trim(),
                      auth: {
                        kind: draft.auth,
                        ...(draft.auth !== 'none'
                          ? { credentialRef: draft.credentialRef.trim() }
                          : {}),
                        ...(draft.auth === 'oauth'
                          ? {
                              scope: draft.scope.trim(),
                              ...(draft.clientId.trim() ? { clientId: draft.clientId.trim() } : {}),
                            }
                          : {}),
                      },
                    }),
              });
              if (!parsed.success) {
                setError(t('invalidMcp'));
                return;
              }
              if (!editing && config?.mcpServers?.some((server) => server.id === parsed.data.id)) {
                setError(t('duplicateLsp'));
                return;
              }
              void save([
                ...(config?.mcpServers ?? []).filter((server) => server.id !== editing),
                parsed.data,
              ]);
            }}
          >
            {t('saveMcp')}
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

function McpConnection({
  api,
  projectId,
  server,
}: {
  api: HarnessApi;
  projectId: string;
  server: RegisteredMcpServer;
}) {
  const t = useTranslations('Harness');
  const [launch, setLaunch] = useState<Awaited<ReturnType<HarnessApi['inspectMcpServer']>> | null>(
    null,
  );
  const [status, setStatus] = useState<Awaited<ReturnType<HarnessApi['mcpAuthStatus']>> | null>(
    null,
  );
  const [login, setLogin] = useState<{ loginId: string; url: string } | null>(null);
  const [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!login) return;
    let ended = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api.mcpLoginStatus(login.loginId);
        if (ended) return;
        if (next.state === 'pending') {
          timer = setTimeout(() => void poll(), 1000);
          return;
        }
        if (next.state === 'ready') setStatus(await api.mcpAuthStatus(projectId, server.id));
        else if (next.state === 'failed') setError(t('mcpLoginFailed'));
        if (!ended) setLogin(null);
      } catch {
        if (!ended) {
          setError(t('mcpLoginFailed'));
          setLogin(null);
        }
      }
    };
    void poll();
    return () => {
      ended = true;
      clearTimeout(timer);
      void api.cancelMcpLogin(login.loginId).catch(() => {});
    };
  }, [api, projectId, server.id, login, t]);
  async function work(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (error) {
      setError(error instanceof Error ? error.message : t('error'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">
        {server.name} <span className="text-muted">{server.id}</span>
      </p>
      <p className="break-all font-mono text-xs">
        {server.transport === 'stdio' ? server.argv.join(' ') : server.url}
      </p>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() =>
          void work(async () => {
            setLaunch(await api.inspectMcpServer(projectId, server.id));
            setStatus(await api.mcpAuthStatus(projectId, server.id));
          })
        }
      >
        {t('reviewCheck', { name: server.name })}
      </Button>
      {launch ? (
        <>
          <p className="break-all font-mono text-xs">{launch.fingerprint}</p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                await api.trustMcpServer(
                  projectId,
                  server.id,
                  launch.fingerprint,
                  !launch.trustedAt,
                );
                setLaunch(await api.inspectMcpServer(projectId, server.id));
              })
            }
          >
            {t(launch.trustedAt ? 'revokeCheckTrust' : 'trustCheck')}
          </Button>
          {status ? (
            <p role="status" className="text-sm">
              {t(
                status.state === 'ready'
                  ? 'mcpReady'
                  : status.state === 'missing'
                    ? 'mcpMissing'
                    : 'mcpNoAuth',
              )}
            </p>
          ) : null}
          {server.transport === 'http' && server.auth.kind !== 'none' ? (
            <>
              <p className="text-xs text-muted">{t('mcpAuthHint')}</p>
              {server.auth.kind === 'bearer' ? (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    {t('mcpToken')}
                    <input
                      type="password"
                      autoComplete="off"
                      className={field}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                  </label>
                  <Button
                    disabled={busy || !launch.trustedAt || !token}
                    onClick={() =>
                      void work(async () => {
                        try {
                          setStatus(
                            await api.saveMcpBearer(
                              projectId,
                              server.id,
                              launch.fingerprint,
                              token,
                            ),
                          );
                        } finally {
                          setToken('');
                        }
                      })
                    }
                  >
                    {t('mcpSaveToken')}
                  </Button>
                </>
              ) : (
                <Button
                  disabled={busy || !launch.trustedAt || !!login}
                  onClick={() =>
                    void work(async () => {
                      const next = await api.signInMcp(projectId, server.id, launch.fingerprint);
                      if (active.current) setLogin(next);
                      else await api.cancelMcpLogin(next.loginId);
                    })
                  }
                >
                  {t('mcpSignIn', { name: server.name })}
                </Button>
              )}
              {login ? (
                <div className="flex flex-wrap items-center gap-3">
                  <a
                    href={login.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-accent underline"
                  >
                    {t('mcpContinue')}
                  </a>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void work(async () => {
                        await api.cancelMcpLogin(login.loginId);
                        setLogin(null);
                      })
                    }
                  >
                    {t('mcpCancel')}
                  </Button>
                </div>
              ) : null}
              {status?.state === 'ready' ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      setStatus(await api.signOutMcp(projectId, server.id, launch.fingerprint));
                      setLogin(null);
                    })
                  }
                >
                  {t('mcpSignOut', { name: server.name })}
                </Button>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
