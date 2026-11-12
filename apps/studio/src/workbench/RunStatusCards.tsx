import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { HarnessDetails, type RunSessionStore } from '@corral/react';
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  fontWeights,
} from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import { compactTarget } from './compactTarget.ts';
import { useSettingsNavigation } from './navigation.ts';
import { ProfileContextDetails } from './ProfileContextDetails.tsx';
import { RunChanges } from './RunChanges.tsx';
import { RuntimeRecovery } from './RuntimeRecovery.tsx';

/**
 * Run info's environment, context, connections and changes, as rows of Run info's one kit
 * accordion: render them inside it.
 */
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
  const noInformation = useTranslations('Usage')('noInformation');
  const branchText = useTranslations('MessageBranch');
  const { mode, workspaces } = useServices();
  const state = useStore(session);
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
    <>
      {lineage?.branchedFrom || lineage?.resumedFrom ? (
        <p className="px-3 py-1 text-caption">
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
        </p>
      ) : null}
      <AccordionItem value="environment" data-testid="status-environment">
        <AccordionTrigger>
          {t('environment')} · {t(projection.mode === 'mock' ? 'simulated' : 'live')}
        </AccordionTrigger>
        <AccordionContent>
          <div className="space-y-1 text-caption text-muted-foreground">
            <p>{t(mode === 'browser' ? 'browser' : 'local')}</p>
            <p>
              {t(definition?.input.taskScope === 'review_only' ? 'readOnly' : 'rolePermissions')}
            </p>
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
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="context" data-testid="status-context">
        <AccordionTrigger>
          {t('context')} ·{' '}
          {record?.contextEstimate
            ? t('estimate', { count: record.contextEstimate.tokens })
            : noInformation}
        </AccordionTrigger>
        <AccordionContent>
          <div className="space-y-2 text-caption">
            <p>
              {node?.label ?? selected ?? noInformation} · {t('lastRequest')}
            </p>
            <p>
              {model?.contextWindow
                ? t('capacity', { value: model.contextWindow.toLocaleString() })
                : t('capacityUnreported')}
            </p>
            <ProfileContextDetails
              policy={model?.contextPolicy}
              runtime={
                projection.mode === 'mock'
                  ? 'mock'
                  : (record?.runtime ?? (role?.harness ? 'pi-sdk' : 'pi-core'))
              }
            />
            <p className="text-muted-foreground">{t('estimateNote')}</p>
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
              />
            ) : null}
            {['interrupted', 'failed', 'cancelled'].includes(projection.status) &&
            projection.mode === 'live' ? (
              <RuntimeRecovery
                key={`${projection.runId}:${projection.lastSeq}`}
                runId={projection.runId}
                sessionId={sessionId}
              />
            ) : null}
          </div>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="connections" data-testid="status-connections">
        <AccordionTrigger>
          {t('connections')} · {Object.keys(projection.modelProfiles).length}
        </AccordionTrigger>
        <AccordionContent>
          <div className="space-y-2 text-caption">
            <p className="text-muted-foreground">{t('connectionNote')}</p>
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
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="changes" data-testid="status-changes">
        <AccordionTrigger>{t('changes')}</AccordionTrigger>
        <AccordionContent>
          <div className="text-caption">
            {sessionId && copy ? (
              <>
                <p className="mb-2 text-muted-foreground">
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
        </AccordionContent>
      </AccordionItem>
    </>
  );
}

/**
 * One line for the execution detail: how much context its last recorded request carried, and
 * compaction while the execution can still use it. Run-wide diagnostics stay in Run info.
 */
export function ExecutionContext({
  session,
  executionId,
}: {
  session: RunSessionStore;
  executionId: string;
}) {
  const t = useTranslations('RunStatus');
  const noInformation = useTranslations('Usage')('noInformation');
  const { projection, events } = useStore(session);
  if (!projection) return null;
  const execution = projection.executions[executionId];
  const request = events
    .filter(
      (event) =>
        event.type === 'model.request_recorded' &&
        projection.modelCalls[event.payload.modelCallId]?.executionId === executionId,
    )
    .at(-1);
  const estimate =
    request?.type === 'model.request_recorded' ? request.payload.contextEstimate : undefined;
  const open =
    execution &&
    !TERMINAL_EXECUTION_STATUSES.has(execution.status) &&
    !TERMINAL_RUN_STATUSES.has(projection.status);
  if (!estimate && !open) return null;
  return (
    <section data-testid="execution-context" className="grid gap-1 text-caption">
      <p>
        <span style={{ fontVariationSettings: fontWeights.semibold }}>{t('contextOnly')}</span> ·{' '}
        {estimate ? t('estimate', { count: estimate.tokens }) : noInformation}
      </p>
      {open ? <ContextCompaction session={session} executionId={executionId} /> : null}
    </section>
  );
}

function ContextCompaction({
  session,
  executionId,
}: {
  session: RunSessionStore;
  executionId: string;
}) {
  const t = useTranslations('RunStatus');
  const state = useStore(session);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const execution = state.projection?.executions[executionId];
  const decision = compactTarget(state.projection, executionId);
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
      {decision.ok ? (
        <>
          <p className="text-muted-foreground">{t('compactHint')}</p>
          <Button
            variant="tertiary"
            disabled={busy || decision.pending}
            onClick={() => {
              const current = session.getState();
              const next = compactTarget(current.projection, executionId);
              if (!next.ok || next.pending) return;
              setBusy(true);
              setError(null);
              void current
                .sendCommand({
                  type: 'compact_context',
                  expectedControlRevision: next.expectedControlRevision,
                  payload: { executionId: next.executionId, attemptNo: next.attemptNo },
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
        <p className="text-muted-foreground">{t(decision.reason)}</p>
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
