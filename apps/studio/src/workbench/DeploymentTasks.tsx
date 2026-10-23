import type {
  DeploymentList,
  DeploymentPlan,
  DeploymentView,
  WorkspaceTarget,
} from '@corral/client';
import { ApiError } from '@corral/client';
import { DeploymentReadback } from '@corral/contracts';
import { Button, Select } from '@corral/react/ui';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import type { WorkspacesClient } from '../demo/workspaces-client.ts';
import { useServices } from '../services.tsx';
import { type DocumentBuffer, documentStore } from './documents/store.ts';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

const sameTarget = (a: WorkspaceTarget, b: WorkspaceTarget) =>
  a.hostId === b.hostId &&
  a.projectId === b.projectId &&
  a.bindingId === b.bindingId &&
  a.sessionId === b.sessionId &&
  a.copyGeneration === b.copyGeneration;

export function DeploymentTasks({
  sessionId,
  projectId,
}: {
  sessionId: string;
  projectId: string;
}) {
  const { workspaces, workspaceId, mode } = useServices();
  const query = useMemo(
    () => ({ workspaces, workspaceId, sessionId }),
    [workspaces, workspaceId, sessionId],
  );
  const [ready, setReady] = useState<typeof query | null>(null);
  useEffect(() => {
    if (!workspaces?.deployments || mode !== 'server' || !workspaceId) return;
    let live = true;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const copy = await workspaces.worktree(sessionId);
        if (live && request === revision) setReady(copy && !copy.missing ? query : null);
      } catch {
        if (live && request === revision) setReady(null);
      }
    };
    void refresh();
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    return () => {
      live = false;
      window.removeEventListener(WORKSPACE_CHANGED, refresh);
    };
  }, [workspaces, workspaceId, sessionId, mode, query]);
  if (!workspaces?.deployments || mode !== 'server' || !workspaceId) return null;
  if (ready !== query) return null;
  return (
    <Tasks
      key={`${workspaceId}:${projectId}:${sessionId}`}
      sessionId={sessionId}
      projectId={projectId}
      api={workspaces}
      workspaceId={workspaceId}
    />
  );
}

function Tasks({
  sessionId,
  projectId,
  api,
  workspaceId,
}: {
  sessionId: string;
  projectId: string;
  api: WorkspacesClient;
  workspaceId: string;
}) {
  const t = useTranslations('Deployment');
  const context = useMemo(
    () => ({ api, workspaceId, sessionId, projectId }),
    [api, workspaceId, sessionId, projectId],
  );
  const current = useRef(context);
  current.current = context;
  const owner = useMemo(() => documentStore(api), [api]);
  const { documents } = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState);
  const [list, setList] = useState<DeploymentList | null>(null);
  const [profileId, setProfile] = useState('');
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [allowDirty, setAllowDirty] = useState(false);
  const [receipt, setReceipt] = useState<DeploymentView | null>(null);
  const [attempt, setAttempt] = useState<{ operationId: string; target: WorkspaceTarget } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef<typeof context | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    pending.current = null;
    setBusy(false);
    setError('');
    setList(null);
    setPlan(null);
    setReceipt(null);
    setAttempt(null);
    void api.deployments(sessionId).then(
      (value) => {
        if (!live) return;
        setList(value);
        setProfile(value.profiles[0]?.id ?? '');
        const last = value.deployments[0];
        if (last) {
          setReceipt(last);
          setAttempt({ operationId: last.operationId, target: last.target });
        }
      },
      (reason) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [api, sessionId]);
  const valid = () => alive.current && current.current === context;
  const hasUnsaved = (entries: Record<string, DocumentBuffer>) =>
    Object.values(entries).some(
      (entry) =>
        entry.target.hostId === workspaceId &&
        entry.target.projectId === projectId &&
        entry.target.sessionId === sessionId &&
        (entry.dirty || entry.saving || entry.pendingSave || entry.conflict),
    );
  const unsaved = hasUnsaved(documents);
  async function work(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = context;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      if (valid()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (pending.current === context) {
        pending.current = null;
        if (valid()) setBusy(false);
      }
    }
  }
  async function target() {
    const copy = await api.worktree(sessionId);
    if (!copy || copy.missing) throw new Error(t('noCopy'));
    return {
      hostId: workspaceId,
      projectId,
      sessionId,
      bindingId: copy.bindingId,
      copyGeneration: copy.copyGeneration,
    };
  }
  async function assertTarget(expected: WorkspaceTarget) {
    if (!sameTarget(await target(), expected)) throw new Error(t('changed'));
  }
  function show(value: DeploymentView, expected: { target: WorkspaceTarget; operationId: string }) {
    if (!sameTarget(value.target, expected.target) || value.operationId !== expected.operationId)
      throw new Error(t('changed'));
    if (!valid()) return;
    setReceipt(value);
    setList(
      (list) =>
        list && {
          ...list,
          deployments: [
            value,
            ...list.deployments.filter((item) => item.operationId !== value.operationId),
          ],
        },
    );
  }
  const unresolved = Boolean(
    attempt && (!receipt || receipt.state === 'running' || receipt.state === 'uncertain'),
  );
  const review = () =>
    work(async () => {
      if (unsaved || unresolved) return;
      const scope = await target();
      const value = await api.inspectDeployment(sessionId, { target: scope, profileId });
      if (!sameTarget(value.target, scope) || value.profile.id !== profileId)
        throw new Error(t('changed'));
      if (!valid()) return;
      setPlan(value);
      setReceipt(null);
      setAttempt(null);
      setAllowDirty(false);
    });
  const start = () =>
    work(async () => {
      if (!plan || attempt || unsaved || (plan.source.dirty && !allowDirty)) return;
      await assertTarget(plan.target);
      if (!valid()) return;
      if (hasUnsaved(owner.getState().documents)) throw new Error(t('unsaved'));
      const next = {
        operationId: `deploy_${crypto.randomUUID().replaceAll('-', '')}`,
        target: plan.target,
      };
      setAttempt(next);
      try {
        const value = await api.startDeployment(sessionId, {
          ...next,
          profileId: plan.profile.id,
          fingerprint: plan.fingerprint,
          allowDirty,
        });
        show(value, next);
      } catch (reason) {
        if (valid() && reason instanceof ApiError && reason.status >= 400 && reason.status < 500) {
          setAttempt(null);
          setPlan(null);
        }
        throw reason;
      }
    });
  if (!list)
    return error ? (
      <p role="alert" className="text-xs text-danger">
        {error}
      </p>
    ) : null;
  const selectedPlan = plan ?? receipt?.plan;
  const result =
    receipt?.readback && DeploymentReadback.safeParse(receipt.readback).success
      ? receipt.readback
      : null;
  return (
    <section
      aria-label={t('title')}
      className="flex min-w-0 flex-col gap-2 border-b border-line pb-3"
      data-testid="deployment-tasks"
    >
      <h3 className="text-xs font-medium">{t('title')}</h3>
      {list.profiles.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select
            label={t('profile')}
            value={profileId}
            options={list.profiles.map((profile) => ({
              value: profile.id,
              label: `${profile.name} · ${profile.environment}`,
            }))}
            onValueChange={(id) => {
              setProfile(id);
              setPlan(null);
            }}
            disabled={busy || unresolved}
            size="xs"
          />
          <Button
            size="xs"
            variant="outline"
            disabled={busy || unsaved || unresolved || !profileId}
            onClick={() => void review()}
          >
            {t('review')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted">{t('empty')}</p>
      )}
      {unsaved ? (
        <p role="status" className="text-xs text-muted">
          {t('unsaved')}
        </p>
      ) : null}
      {selectedPlan ? (
        <div className="flex min-w-0 flex-col gap-2 text-xs">
          <p>
            {selectedPlan.profile.name} · {selectedPlan.profile.environment}
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
            <dt>{t('commit')}</dt>
            <dd className="break-all font-mono">{selectedPlan.source.commit ?? t('noCommit')}</dd>
            <dt>{t('source')}</dt>
            <dd>{t(selectedPlan.source.dirty ? 'dirty' : 'clean')}</dd>
            <dt>{t('credentials')}</dt>
            <dd className="break-words">{selectedPlan.profile.envRefs.join(', ') || t('none')}</dd>
          </dl>
          <details>
            <summary className="cursor-pointer text-muted">{t('commands')}</summary>
            <dl className="mt-2 flex flex-col gap-1">
              <dt>{t('deployCommand')}</dt>
              <dd className="break-all font-mono">{JSON.stringify(selectedPlan.profile.argv)}</dd>
              <dt>{t('readbackCommand')}</dt>
              <dd className="break-all font-mono">
                {JSON.stringify(selectedPlan.profile.readbackArgv)}
              </dd>
              <dt>{t('tree')}</dt>
              <dd className="break-all font-mono">{selectedPlan.source.tree}</dd>
            </dl>
          </details>
          {plan && !attempt ? (
            <>
              {plan.source.dirty ? (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={allowDirty}
                    disabled={busy}
                    onChange={(event) => setAllowDirty(event.target.checked)}
                  />
                  {t('allowDirty')}
                </label>
              ) : null}
              <p className="text-muted">{t('startHint')}</p>
              <Button
                size="xs"
                disabled={busy || unsaved || (plan.source.dirty && !allowDirty)}
                onClick={() => void start()}
              >
                {t('start')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {attempt ? (
        <div className="flex flex-col gap-2 text-xs">
          <p role="status">{receipt ? t(`state.${receipt.state}`) : t('lost')}</p>
          {receipt?.exitCode !== null && receipt?.exitCode !== undefined ? (
            <p>{t('exitCode', { code: receipt.exitCode })}</p>
          ) : null}
          <p role="status">{result ? t(`result.${result.status}`) : t('unverified')}</p>
          {result ? (
            <p className="break-all">
              {t('deploymentId')}: {result.deploymentId}
            </p>
          ) : null}
          {result?.url ? (
            <a
              className="break-all underline"
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('openResult')}
            </a>
          ) : null}
          {receipt?.reason ? (
            <p className="text-muted">
              {t.has(`reason.${receipt.reason}`) ? t(`reason.${receipt.reason}`) : t('unverified')}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void work(async () =>
                  show(await api.deployment(sessionId, attempt.operationId), attempt),
                )
              }
            >
              {t('refreshReceipt')}
            </Button>
            {receipt?.state === 'uncertain' && receipt.cleanupConfirmed ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || unsaved}
                onClick={() =>
                  void work(async () => {
                    await assertTarget(attempt.target);
                    if (valid())
                      show(
                        await api.checkDeployment(sessionId, attempt.operationId, {
                          target: attempt.target,
                        }),
                        attempt,
                      );
                  })
                }
              >
                {t('checkResult')}
              </Button>
            ) : null}
            {receipt && ['running', 'uncertain'].includes(receipt.state) ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    await assertTarget(attempt.target);
                    if (valid())
                      show(
                        await api.stopDeployment(sessionId, attempt.operationId, {
                          target: attempt.target,
                        }),
                        attempt,
                      );
                  })
                }
              >
                {t(receipt.cleanupConfirmed ? 'finish' : 'stop')}
              </Button>
            ) : null}
          </div>
          {receipt && ['running', 'uncertain', 'cancelled'].includes(receipt.state) ? (
            <p className="text-muted">{t('stopHint')}</p>
          ) : null}
        </div>
      ) : null}
      {list.deployments.length > 1 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted">{t('history')}</summary>
          <ul className="mt-1 flex max-h-36 flex-col gap-1 overflow-auto">
            {list.deployments.map((item) => (
              <li key={item.operationId}>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy || (unresolved && item.operationId !== attempt?.operationId)}
                  onClick={() => {
                    setPlan(null);
                    setReceipt(item);
                    setAttempt({ operationId: item.operationId, target: item.target });
                  }}
                >
                  {item.plan.profile.name} · {item.createdAt}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {busy ? (
        <p role="status" className="text-xs text-muted">
          {t('processing')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
