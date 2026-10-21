import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { BudgetInspector, HarnessDetails, type RunSessionStore } from '@corral/react';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useModelPrices } from '../prices.ts';
import { useServices } from '../services.tsx';
import { useSettingsNavigation } from './navigation.ts';
import { ProfileContextDetails } from './ProfileContextDetails.tsx';
import { RunChanges } from './RunChanges.tsx';
import { RuntimeRecovery } from './RuntimeRecovery.tsx';

export function RunStatusCards({
  session,
  sessionId,
  executionId,
}: {
  session: RunSessionStore;
  sessionId: string | null;
  executionId: string | null;
}) {
  const navigation = useSettingsNavigation();
  const t = useTranslations('RunStatus');
  const branchText = useTranslations('MessageBranch');
  const { mode, workspaces } = useServices();
  const state = useStore(session);
  const prices = useModelPrices();
  const [copy, setCopy] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    setCopy(null);
    if (sessionId)
      void workspaces
        ?.worktree(sessionId)
        .then((value) => {
          if (current) setCopy(Boolean(value && !value.missing));
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [sessionId, workspaces]);
  const { projection, events, definition } = state;
  if (!projection) return null;
  const selected = executionId ?? projection.executionOrder.at(-1);
  const execution = selected ? projection.executions[selected] : null;
  const node = definition?.nodes.find((item) => item.id === execution?.nodeId);
  const role =
    node?.type === 'agent' ? definition?.roles.find((item) => item.id === node.roleId) : null;
  const request = events
    .filter(
      (event) =>
        event.type === 'model.request_recorded' &&
        projection.modelCalls[event.payload.modelCallId]?.executionId === selected,
    )
    .at(-1);
  const record = request?.type === 'model.request_recorded' ? request.payload : null;
  const model = record
    ? projection.modelProfiles[projection.modelCalls[record.modelCallId]?.profile ?? '']
    : role
      ? projection.modelProfiles[role.modelProfile]
      : null;
  const harnesses = events.find((event) => event.type === 'run.started')?.payload.harnesses;
  const lineage = events.find((event) => event.type === 'run.started')?.payload;
  const failedLoads = events.filter((event) => event.type === 'harness.load_failed');
  return (
    <div className="grid gap-2 text-xs">
      {lineage?.branchedFrom || lineage?.resumedFrom ? (
        <Link
          to="/runs/$runId"
          params={{ runId: (lineage.branchedFrom ?? lineage.resumedFrom)!.runId }}
          search={
            lineage.branchedFrom?.artifactVersionId
              ? { view: 'results', result: lineage.branchedFrom.artifactVersionId }
              : { view: 'run' }
          }
          className="underline"
        >
          {branchText('source')}
        </Link>
      ) : null}
      <details data-testid="status-environment" className="rounded fill-group p-2">
        <summary className="cursor-pointer font-medium">
          {t('environment')} · {t(projection.mode === 'mock' ? 'simulated' : 'live')}
        </summary>
        <div className="mt-2 space-y-1 text-muted">
          <p>{t(mode === 'browser' ? 'browser' : 'local')}</p>
          <p>{t(definition?.input.taskScope === 'review_only' ? 'readOnly' : 'rolePermissions')}</p>
          <p>
            {t(
              Object.values(projection.modelProfiles).some(
                (profile) => profile.workerIsolation === 'linux-bwrap',
              )
                ? 'linuxIsolationRequested'
                : 'noOsIsolation',
            )}
          </p>
          <p>
            {t(
              sessionId
                ? copy === null
                  ? 'unknownCopy'
                  : copy
                    ? 'managedCopy'
                    : 'noCopy'
                : 'noSession',
            )}
          </p>
        </div>
      </details>
      <details data-testid="status-context" className="rounded fill-group p-2">
        <summary className="cursor-pointer font-medium">
          {t('context')} ·{' '}
          {record?.contextEstimate
            ? t('estimate', { count: record.contextEstimate.tokens })
            : t('unknown')}
        </summary>
        <div className="mt-2 space-y-2">
          <p>
            {node?.label ?? selected ?? t('unknown')} · {t('lastRequest')}
          </p>
          <p>{t('capacity', { value: model?.contextWindow?.toLocaleString() ?? t('unknown') })}</p>
          <ProfileContextDetails
            policy={model?.contextPolicy}
            runtime={
              projection.mode === 'mock'
                ? 'mock'
                : (record?.runtime ?? (role?.harness ? 'pi-sdk' : 'pi-core'))
            }
          />
          <p className="text-muted">{t('estimateNote')}</p>
          {record ? (
            <p>
              {record.contextBytes.toLocaleString()} B ·{' '}
              <code>{record.contextHash.slice(0, 12)}</code>
            </p>
          ) : null}
          {selected ? (
            <ContextCompaction
              key={`${state.runId}:${selected}`}
              session={session}
              executionId={selected}
              supported={Boolean(role?.harness) && projection.mode === 'live'}
            />
          ) : null}
          <BudgetInspector session={session} prices={prices} />
          {['interrupted', 'failed', 'cancelled'].includes(projection.status) &&
          projection.mode === 'live' ? (
            <RuntimeRecovery
              key={`${projection.runId}:${projection.lastSeq}`}
              runId={projection.runId}
              sessionId={sessionId}
            />
          ) : null}
        </div>
      </details>
      <details data-testid="status-connections" className="rounded fill-group p-2">
        <summary className="cursor-pointer font-medium">
          {t('connections')} · {Object.keys(projection.modelProfiles).length}
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-muted">{t('connectionNote')}</p>
          <ul>
            {Object.values(projection.modelProfiles).map((profile) => (
              <li key={profile.profile}>
                {profile.profile} · {profile.modelId ?? t('simulated')} ·{' '}
                {t(`auth.${profile.auth}`)}
              </li>
            ))}
          </ul>
          <p>{t('pinnedProfiles', { count: Object.keys(harnesses ?? {}).length })}</p>
          {failedLoads.length ? (
            <p role="status" className="text-danger">
              {t('failedLoads', { count: failedLoads.length })}
            </p>
          ) : null}
          <Link className="underline" {...navigation.link('models')}>
            {t('modelSettings')}
          </Link>
          <HarnessDetails session={session} />
        </div>
      </details>
      <details data-testid="status-changes" className="rounded fill-group p-2">
        <summary className="cursor-pointer font-medium">{t('changes')}</summary>
        <div className="mt-2">
          {sessionId && copy ? (
            <>
              <p className="mb-2 text-muted">
                {t(TERMINAL_RUN_STATUSES.has(projection.status) ? 'fixedRun' : 'changesSoFar')}
              </p>
              <RunChanges
                key={`${projection.runId}:${projection.status}`}
                sessionId={sessionId}
                runId={projection.runId}
              />
            </>
          ) : (
            <p>{t(copy === null && sessionId ? 'unknownCopy' : 'noCopy')}</p>
          )}
        </div>
      </details>
    </div>
  );
}

function ContextCompaction({
  session,
  executionId,
  supported,
}: {
  session: RunSessionStore;
  executionId: string;
  supported: boolean;
}) {
  const t = useTranslations('RunStatus');
  const state = useStore(session);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const execution = state.projection?.executions[executionId];
  const event = state.events
    .filter(
      (event) =>
        event.type === 'context.compaction_changed' && event.payload.executionId === executionId,
    )
    .at(-1);
  const phase = event?.type === 'context.compaction_changed' ? event.payload.phase : null;
  const pending = phase === 'queued' || phase === 'started';
  const ended =
    !execution ||
    TERMINAL_EXECUTION_STATUSES.has(execution.status) ||
    !state.projection ||
    TERMINAL_RUN_STATUSES.has(state.projection.status);
  return (
    <div className="space-y-1">
      {supported ? (
        <>
          <p className="text-muted">{t('compactHint')}</p>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || ended || pending}
            onClick={() => {
              if (!execution || !state.projection) return;
              setBusy(true);
              setError(null);
              void state
                .sendCommand({
                  type: 'compact_context',
                  expectedControlRevision: state.projection.controlRevision,
                  payload: { executionId, attemptNo: execution.attemptNo },
                })
                .then((receipt) => {
                  if (receipt.error) setError(receipt.error.message);
                })
                .catch((failure) =>
                  setError(failure instanceof Error ? failure.message : t('compactUnavailable')),
                )
                .finally(() => setBusy(false));
            }}
          >
            {t('compactRequest')}
          </Button>
        </>
      ) : (
        <p className="text-muted">{t('compactUnavailable')}</p>
      )}
      {phase ? (
        <p role="status">
          {pending && ended ? t('compactUnconfirmed') : t(`compactPhase.${phase}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
