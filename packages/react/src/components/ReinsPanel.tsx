import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button, Textarea } from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { CommandReceipts } from './CommandReceipts.tsx';
import { SettingsPatchPanel } from './SettingsPatchPanel.tsx';
import { StatusBadge } from './StatusBadge.tsx';

export interface SteerTarget {
  executionId: string;
  nodeLabel: string;
  /** Finished targets stay visible read-only so undelivered instructions are not hidden. */
  finished: boolean;
}

/**
 * Reins for one execution. The header always says who receives the instruction,
 * when it takes effect and how far it reaches. Directive badges change only on committed events.
 */
export function ReinsPanel({
  session,
  target,
}: {
  session: RunSessionStore;
  target: SteerTarget | null;
}) {
  const t = useTranslations('Reins');
  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState<{
    runId: string | null;
    executionId: string;
    nodeLabel: string;
    text: string;
    commandId?: string;
  } | null>(null);
  // Pinned to the run and execution it was opened for.
  const [cancelTarget, setCancelTarget] = useState<{
    runId: string | null;
    executionId: string;
  } | null>(null);
  const [restartInstructions, setRestartInstructions] = useState<Record<string, string>>({});
  const runId = useStore(session, (s) => s.runId);
  const steer = useStore(session, (s) => s.steer);
  const pending = useStore(session, (s) => s.pendingCommandIds.length > 0);
  const projection = useStore(session, (s) => s.projection);
  const recovered = useStore(session, (s) =>
    draft?.commandId ? s.receipts[draft.commandId] : undefined,
  );
  const text = draft?.text ?? '';
  useEffect(() => {
    if (recovered && recovered.status !== 'rejected')
      setDraft((current) => (current?.commandId === recovered.commandId ? null : current));
  }, [recovered]);

  if (!target) {
    return (
      <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-2">
        <h2 id={`${inputId}-heading`} className="text-sm font-semibold">
          {t('heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('noTarget')}</p>
        <SettingsPatchPanel key={projection?.runId} session={session} />
      </section>
    );
  }

  const draftMatches =
    !draft || (draft.runId === runId && draft.executionId === target.executionId);
  const restartKey = `${runId}:${target.executionId}`;
  const restartInstruction = restartInstructions[restartKey] ?? '';
  const paused = projection?.status === 'paused' || projection?.status === 'pausing';

  const send = async () => {
    const instruction = text.trim();
    if (!instruction || pending || !draftMatches || target.finished) return;
    // The view may have moved to another run since this render.
    if (draft && session.getState().runId !== draft.runId) return;
    try {
      const receipt = await steer(target.executionId, instruction);
      if (receipt.status !== 'rejected')
        setDraft((current) => (current === draft ? null : current));
    } catch {
      const pending = Object.values(session.getState().unconfirmedCommands).find(
        ({ command }) =>
          command.runId === draft?.runId &&
          command.type === 'steer' &&
          command.payload.targetExecutionId === draft.executionId &&
          command.payload.text === instruction,
      );
      if (pending)
        setDraft((current) =>
          current && current === draft
            ? { ...current, commandId: pending.command.commandId }
            : current,
        );
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // IME: the Enter that confirms a Korean/Japanese composition must not send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void send();
  };

  const directives = (projection?.directiveOrder ?? [])
    .map((id) => projection?.directives[id])
    .filter((d) => d?.targetExecutionId === target.executionId);
  const execution = projection?.executions?.[target.executionId];
  const task = execution ? projection?.tasks?.[execution.taskId] : undefined;
  const runOpen = projection && !TERMINAL_RUN_STATUSES.has(projection.status);
  const parent = execution?.parentExecutionId
    ? projection?.executions[execution.parentExecutionId]
    : null;
  const canRestart =
    runOpen &&
    execution?.status === 'cancelled' &&
    task?.status === 'blocked' &&
    task.activeExecutionId === null &&
    task.attemptCount === execution.attemptNo &&
    parent?.status === 'waiting_children' &&
    parent.waitingOn?.targetIds.includes(execution.executionId);
  const sendCommand = (
    command: Parameters<ReturnType<typeof session.getState>['sendCommand']>[0],
  ) => {
    void session
      .getState()
      .sendCommand(command)
      .catch(() => undefined);
  };

  return (
    <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-3">
      <h2 id={`${inputId}-heading`} className="text-sm font-semibold">
        {t('heading')}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t('target')}</dt>
        <dd>
          {target.nodeLabel} · execution {target.executionId}
        </dd>
        <dt className="text-muted-foreground">{t('delivery')}</dt>
        <dd>{t('deliveryValue')}</dd>
        <dt className="text-muted-foreground">{t('scope')}</dt>
        <dd>{t('scopeValue')}</dd>
      </dl>

      {target.finished ? <p className="text-xs text-muted-foreground">{t('finished')}</p> : null}
      {!target.finished || draft ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-xs font-medium">
            {t('instruction')}
          </label>
          <Textarea
            id={inputId}
            aria-describedby={hintId}
            value={text}
            onChange={(event) =>
              setDraft(
                event.target.value
                  ? {
                      runId: draft?.runId ?? runId,
                      executionId: draft?.executionId ?? target.executionId,
                      nodeLabel: draft?.nodeLabel ?? target.nodeLabel,
                      text: event.target.value,
                    }
                  : null,
              )
            }
            onKeyDown={onKeyDown}
            rows={3}
          />
          <p id={hintId} className="text-xs text-muted-foreground">
            {t('instructionHint')}
          </p>
          {!draftMatches && draft ? (
            <>
              <p role="status" className="text-xs text-warning">
                {t('draftTargetChanged', { target: `${draft.nodeLabel} · ${draft.executionId}` })}
              </p>
              <Button
                type="button"
                disabled={pending || target.finished}
                variant="tertiary"
                size="compact"
                onClick={() =>
                  setDraft({
                    ...draft,
                    commandId: undefined,
                    runId,
                    executionId: target.executionId,
                    nodeLabel: target.nodeLabel,
                  })
                }
              >
                {t('useDraftHere')}
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            onClick={() => void send()}
            disabled={pending || text.trim() === '' || !draftMatches || target.finished}
            variant="primary"
            size="compact"
            className="self-end"
          >
            {pending ? t('sending') : t('send')}
          </Button>
        </div>
      ) : null}

      {runOpen && !target.finished ? (
        <Button
          type="button"
          disabled={pending || execution?.status === 'cancelling'}
          onClick={() => setCancelTarget({ runId, executionId: target.executionId })}
          variant="tertiary"
          size="compact"
          className="self-start text-destructive-foreground"
        >
          {t('cancelExecution')}
        </Button>
      ) : null}
      {cancelTarget?.runId === runId &&
      cancelTarget.executionId === target.executionId &&
      !target.finished ? (
        <div className="flex flex-col gap-2 rounded border border-danger p-2 text-xs">
          <p>{t('cancelExecutionExplain', { executionId: target.executionId })}</p>
          <Button
            type="button"
            disabled={pending}
            onClick={() => {
              setCancelTarget(null);
              if (session.getState().runId !== cancelTarget?.runId) return;
              sendCommand({
                type: 'cancel',
                payload: {
                  scope: { kind: 'execution', executionId: target.executionId },
                  reason: 'User cancelled the selected execution',
                },
              });
            }}
            variant="tertiary"
            size="compact"
            className="text-destructive-foreground"
          >
            {t('confirmCancelExecution')}
          </Button>
          <Button
            type="button"
            onClick={() => setCancelTarget(null)}
            variant="secondary"
            size="compact"
          >
            {t('keepRunning')}
          </Button>
        </div>
      ) : null}
      {canRestart && execution && projection ? (
        <div className="flex flex-col gap-2 text-xs">
          <p className="text-muted-foreground">{t('restartExplain')}</p>
          {paused ? <p className="text-warning">{t('resumeBeforeRestart')}</p> : null}
          <label htmlFor={`${inputId}-restart`}>{t('restartInstruction')}</label>
          <Textarea
            id={`${inputId}-restart`}
            value={restartInstruction}
            onChange={(event) =>
              setRestartInstructions({ ...restartInstructions, [restartKey]: event.target.value })
            }
          />
          <Button
            type="button"
            disabled={pending || paused || !restartInstruction.trim()}
            onClick={() =>
              sendCommand({
                type: 'restart_task',
                expectedControlRevision: projection.controlRevision,
                payload: {
                  taskId: execution.taskId,
                  previousExecutionId: execution.executionId,
                  instruction: restartInstruction.trim(),
                },
              })
            }
            variant="primary"
            size="compact"
          >
            {t('restart')}
          </Button>
        </div>
      ) : null}
      <CommandReceipts session={session} target={`execution:${target.executionId}`} />
      <SettingsPatchPanel
        key={`${projection?.runId}:${execution?.nodeId}`}
        session={session}
        nodeId={execution?.nodeId}
      />

      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold">{t('history')}</h3>
        {directives.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noHistory')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {directives.map((d) =>
              d ? (
                <li
                  key={d.directiveId}
                  id={`directive-${d.directiveId}`}
                  className="flex flex-col gap-1 border-b border-border py-2 text-xs last:border-0"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="break-words">{d.text}</span>
                    <StatusBadge status={d.status} />
                  </div>
                  <span className="font-mono text-muted-foreground">{d.directiveId}</span>
                  {d.reason ? <p className="text-warning">{d.reason}</p> : null}
                  {d.modelCallId && d.contextSnapshotId ? (
                    <p className="text-muted-foreground">
                      {t('requestLink', { request: d.modelCallId, snapshot: d.contextSnapshotId })}
                    </p>
                  ) : null}
                  {d.status === 'delivered' &&
                  Object.values(projection?.artifacts ?? {}).some(
                    (a) => a.modelCallId === d.modelCallId,
                  ) ? (
                    <p>
                      {t('produced', {
                        versions: Object.values(projection?.artifacts ?? {})
                          .filter((a) => a.modelCallId === d.modelCallId)
                          .map((a) => a.artifactVersionId)
                          .join(', '),
                      })}
                    </p>
                  ) : null}
                </li>
              ) : null,
            )}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t('deliveredNote')}</p>
      </div>
    </section>
  );
}
