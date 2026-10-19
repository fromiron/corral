import type { HarnessApi, McpProbeResult } from '@corral/client';
import type { RegisteredMcpServer } from '@corral/contracts';
import { Button, Select } from '@corral/react/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { field, operationId } from '../workbench/harness/Target.tsx';

export function McpConnection({
  api,
  projectId,
  server,
  manage = true,
  onProbe,
  disabled = false,
}: {
  api: HarnessApi;
  projectId: string;
  server: RegisteredMcpServer;
  manage?: boolean;
  onProbe(result: McpProbeResult | null): void;
  disabled?: boolean;
}) {
  const t = useTranslations('Harness'),
    r = useTranslations('Resources');
  const { repository, workspaces } = useServices();
  const [copies, setCopies] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let owned = true;
    if (server.transport === 'stdio' && workspaces)
      void repository
        .listSessions(projectId)
        .then(async (sessions) => {
          const list = await Promise.all(
            sessions.map(async (session) => {
              const copy = await workspaces.worktree(session.sessionId).catch(() => null);
              return copy && !copy.missing ? { id: session.sessionId, name: session.title } : null;
            }),
          );
          if (owned)
            setCopies(
              list.filter((value): value is { id: string; name: string } => value !== null),
            );
        })
        .catch((e) => owned && setError(e.message));
    return () => {
      owned = false;
    };
  }, [projectId, repository, workspaces, server.transport]);
  const [sessionId, setSessionId] = useState('');
  const [probeId, setProbeId] = useState<string | null>(null);
  const probeRef = useRef<string | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
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
      if (probeRef.current) void api.cancelMcpProbe(probeRef.current).catch(() => {});
    };
  }, [api]);
  useEffect(() => {
    let owned = true;
    setLaunch(null);
    setStatus(null);
    void Promise.all([
      api.inspectMcpServer(projectId, server.id, sessionId ? { sessionId } : {}),
      api.mcpAuthStatus(projectId, server.id),
    ]).then(
      ([launch, status]) => {
        if (owned) {
          setLaunch(launch);
          setStatus(status);
        }
      },
      (e) => owned && setError(e.message),
    );
    return () => {
      owned = false;
    };
  }, [api, projectId, server.id, sessionId]);
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
        if (next.state === 'ready') {
          const value = await api.mcpAuthStatus(projectId, server.id);
          if (!ended) setStatus(value);
        } else if (next.state === 'failed') setError(t('mcpLoginFailed'));
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
      {server.transport === 'stdio' ? (
        <div className="flex flex-col gap-1 text-sm">
          {r('workingCopy')}
          <Select
            label={r('workingCopy')}
            value={sessionId}
            disabled={disabled || busy || !!probeId}
            className="h-9 w-full"
            onValueChange={(value) => {
              setSessionId(value);
              onProbe(null);
            }}
            options={[
              { value: '', label: r('chooseCopy') },
              ...copies.map((copy) => ({ value: copy.id, label: copy.name })),
            ]}
          />
          {!copies.length ? <span className="text-xs text-muted">{r('copyRequired')}</span> : null}
        </div>
      ) : null}
      {manage ? (
        <>
          <p className="break-all font-mono text-xs">
            {server.transport === 'stdio' ? server.argv.join(' ') : server.url}
          </p>
          <Button
            variant="outline"
            disabled={disabled || busy || !!probeId}
            onClick={() =>
              void work(async () => {
                setLaunch(
                  await api.inspectMcpServer(projectId, server.id, sessionId ? { sessionId } : {}),
                );
                setStatus(await api.mcpAuthStatus(projectId, server.id));
              })
            }
          >
            {t('reviewCheck', { name: server.name })}
          </Button>
          {launch ? (
            <>
              <details className="text-xs text-muted">
                <summary>{r('launchDetails')}</summary>
                <p className="break-all font-mono">{launch.fingerprint}</p>
              </details>
              <Button
                variant="outline"
                disabled={disabled || busy || !!probeId}
                onClick={() =>
                  void work(async () => {
                    await api.trustMcpServer(
                      projectId,
                      server.id,
                      launch.fingerprint,
                      !launch.trustedAt,
                      sessionId || undefined,
                    );
                    setLaunch(
                      await api.inspectMcpServer(
                        projectId,
                        server.id,
                        sessionId ? { sessionId } : {},
                      ),
                    );
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
                        disabled={disabled || busy || !launch.trustedAt || !token}
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
                      disabled={disabled || busy || !launch.trustedAt || !!login}
                      onClick={() =>
                        void work(async () => {
                          const next = await api.signInMcp(
                            projectId,
                            server.id,
                            launch.fingerprint,
                          );
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
                      disabled={disabled || busy || !!probeId}
                      onClick={() =>
                        void work(async () => {
                          setStatus(
                            await api.signOutMcp(
                              projectId,
                              server.id,
                              launch.fingerprint,
                              launch.configRevision,
                            ),
                          );
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
        </>
      ) : (
        <p className="text-xs text-muted">{r('configureMcpFirst')}</p>
      )}
      <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
        <p className="text-xs text-muted">{r('probeHint')}</p>
        <Button
          variant="outline"
          disabled={
            disabled ||
            busy ||
            !!probeId ||
            !launch?.trustedAt ||
            status?.state === 'missing' ||
            (server.transport === 'stdio' && !sessionId)
          }
          onClick={() => {
            if (!launch) return;
            const id = operationId();
            probeRef.current = id;
            setProbeId(id);
            setError('');
            onProbe(null);
            void api
              .probeMcp(projectId, server.id, {
                operationId: id,
                configRevision: launch.configRevision,
                fingerprint: launch.fingerprint,
                ...(sessionId ? { sessionId } : {}),
              })
              .then(
                (result) => {
                  if (active.current && probeRef.current === id && sessionRef.current === sessionId)
                    onProbe(result);
                },
                (e) => {
                  if (active.current && probeRef.current === id) setError(e.message);
                },
              )
              .finally(() => {
                if (active.current && probeRef.current === id) {
                  setProbeId(null);
                  probeRef.current = null;
                }
              });
          }}
        >
          {r(probeId ? 'probeRunning' : 'probe')}
        </Button>
        {probeId ? (
          <Button
            variant="ghost"
            onClick={() => {
              void api.cancelMcpProbe(probeId).catch((e) => active.current && setError(e.message));
            }}
          >
            {r('cancelProbe')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
