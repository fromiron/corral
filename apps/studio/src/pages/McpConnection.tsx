import type { HarnessApi, McpProbeResult } from '@corral/client';
import type { RegisteredMcpServer } from '@corral/contracts';
import { Button, Input, Select } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { operationId } from '../workbench/harness/Target.tsx';
import { mcpFailureKind } from '../workbench/mcpFailure.ts';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';

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
    r = useTranslations('Resources'),
    n = useTranslations('Navigation'),
    f = useTranslations('Failure');
  const navigation = useSettingsNavigation();
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
  useSettingsForm({ dirty: Boolean(token), pending: busy });
  const runSettingsTask = useSettingsTask(`mcp-auth:${projectId}:${server.id}`);
  async function work(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await runSettingsTask(task);
    } catch (error) {
      setError(error instanceof Error ? error.message : t('error'));
    } finally {
      setBusy(false);
    }
  }
  const failureKind = mcpFailureKind(error);
  return (
    <div className="flex flex-col gap-6">
      {server.transport === 'stdio' ? (
        <section className="settings-row">
          <div>
            <h3>{r('workingCopy')}</h3>
            {!copies.length ? <p>{r('copyRequired')}</p> : null}
          </div>
          <Select
            label={r('workingCopy')}
            value={sessionId}
            disabled={disabled || busy || !!probeId}
            className="h-9 w-full sm:w-72"
            onValueChange={(value) => {
              setSessionId(value);
              onProbe(null);
            }}
            options={[
              { value: '', label: r('chooseCopy') },
              ...copies.map((copy) => ({ value: copy.id, label: copy.name })),
            ]}
          />
        </section>
      ) : null}
      {manage ? (
        <>
          <section className="settings-surface">
            <p className="break-all font-mono text-xs">
              {server.transport === 'stdio' ? server.argv.join(' ') : server.url}
            </p>
          </section>
          <section className="settings-row">
            <div>
              <h3>{t('reviewCheck', { name: server.name })}</h3>
            </div>
            <Button
              variant="tertiary"
              disabled={disabled || busy || !!probeId}
              onClick={() =>
                void work(async () => {
                  setLaunch(
                    await api.inspectMcpServer(
                      projectId,
                      server.id,
                      sessionId ? { sessionId } : {},
                    ),
                  );
                  setStatus(await api.mcpAuthStatus(projectId, server.id));
                })
              }
            >
              {t('reviewCheck', { name: server.name })}
            </Button>
          </section>
          {launch ? (
            <>
              <section className="settings-row">
                <div>
                  <h3>{t(launch.trustedAt ? 'revokeCheckTrust' : 'trustCheck')}</h3>
                  <p className="break-all font-mono">{launch.fingerprint}</p>
                </div>
                <Button
                  variant="tertiary"
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
              </section>
              {/* Each state on its own line with its next step; none implies another (#82). */}
              <section aria-label={t('mcpStatusHeading')} className="settings-surface text-sm">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t('mcpStatusHeading')}
                </h3>
                <ul className="mt-1 flex flex-col gap-0.5">
                  <li>✓ {t('mcpStepRegistered')}</li>
                  <li className={launch.trustedAt ? undefined : 'text-warning'}>
                    {launch.trustedAt ? `✓ ${t('mcpStepTrust')}` : `• ${t('mcpStepTrustNeeded')}`}
                  </li>
                  {status ? (
                    <li
                      role="status"
                      className={status.state === 'missing' ? 'text-warning' : undefined}
                    >
                      {status.state === 'missing' ? '•' : '✓'}{' '}
                      {t('mcpStepAuth', {
                        state: t(
                          status.state === 'ready'
                            ? 'mcpReady'
                            : status.state === 'missing'
                              ? 'mcpMissing'
                              : 'mcpNoAuth',
                        ),
                      })}
                    </li>
                  ) : null}
                  <li>
                    • {t('mcpStepStyle')}{' '}
                    <Link {...navigation.link('harness')} className="underline">
                      {n('addToWorkStyle')}
                    </Link>
                  </li>
                </ul>
              </section>
              {server.transport === 'http' && server.auth.kind !== 'none' ? (
                <>
                  {server.auth.kind === 'bearer' ? (
                    <section className="settings-row">
                      <div>
                        <h3>{t('mcpToken')}</h3>
                        <p>{t('mcpAuthHint')}</p>
                      </div>
                      <div className="flex w-full flex-col gap-2 sm:w-72">
                        <Input
                          type="password"
                          autoComplete="off"
                          aria-label={t('mcpToken')}
                          value={token}
                          onChange={(e) => setToken(e.target.value)}
                        />
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
                      </div>
                    </section>
                  ) : (
                    <section className="settings-row">
                      <div>
                        <h3>{t('mcpSignIn', { name: server.name })}</h3>
                        <p>{t('mcpAuthHint')}</p>
                      </div>
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
                    </section>
                  )}
                  {login ? (
                    <section className="settings-row">
                      <div>
                        <h3>{t('mcpContinue')}</h3>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="tertiary"
                          render={<a href={login.url} target="_blank" rel="noreferrer" />}
                        >
                          {t('mcpContinue')}
                        </Button>
                        <Button
                          variant="tertiary"
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
                    </section>
                  ) : null}
                  {status?.state === 'ready' ? (
                    <section className="settings-row">
                      <div>
                        <h3>{t('mcpSignOut', { name: server.name })}</h3>
                      </div>
                      <Button
                        variant="tertiary"
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
                    </section>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{r('configureMcpFirst')}</p>
      )}
      <section className="settings-row">
        <div>
          <h3>{r('probeHint')}</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="tertiary"
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
                    if (
                      active.current &&
                      probeRef.current === id &&
                      sessionRef.current === sessionId
                    )
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
                void api
                  .cancelMcpProbe(probeId)
                  .catch((e) => active.current && setError(e.message));
              }}
            >
              {r('cancelProbe')}
            </Button>
          ) : null}
        </div>
      </section>
      {error ? (
        <div role="alert" className="text-sm text-danger">
          <p>{failureKind ? r(`probeFailure.${failureKind}`) : error}</p>
          {failureKind ? (
            <details className="text-muted-foreground">
              <summary>{f('diagnostics')}</summary>
              <code>{error}</code>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
