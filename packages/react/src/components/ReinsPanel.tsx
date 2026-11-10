import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button, fontWeights, Textarea } from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { CommandReceipts } from './CommandReceipts.tsx';
import { ExecutionSteering } from './ExecutionSteering.tsx';
import { SettingsPatchPanel } from './SettingsPatchPanel.tsx';

export interface SteerTarget {
  executionId: string;
  nodeLabel: string;
  /** Finished targets stay visible read-only so undelivered instructions are not hidden. */
  finished: boolean;
}

/**
 * Steering one execution, a part of Reins that the screen names by its action. The header always
 * says who receives the instruction, when it takes effect and how far it reaches. Directive badges
 * change only on committed events.
 */
export function ReinsPanel({
  session,
  target,
  compact = false,
}: {
  session: RunSessionStore;
  target: SteerTarget | null;
  compact?: boolean;
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
        <h2
          id={`${inputId}-heading`}
          className="text-subtitle"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {t('heading')}
        </h2>
        <p className="text-body text-muted-foreground">{t('noTarget')}</p>
        {compact ? null : <SettingsPatchPanel key={projection?.runId} session={session} />}
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

  const compose =
    !target.finished || draft ? (
      <div className="mt-2.5 flex flex-col gap-1 border-t border-border py-2.5 pr-3 pl-3.5">
        <label
          htmlFor={inputId}
          className="text-caption"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
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
        <p id={hintId} className="text-caption text-muted-foreground">
          {t('instructionHint')}
        </p>
        {!draftMatches && draft ? (
          <>
            <p role="status" className="text-caption text-warning">
              {t('draftTargetChanged', {
                target: `${draft.nodeLabel} · ${draft.executionId}`,
              })}
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
    ) : null;

  return (
    <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-3">
      <h2
        id={`${inputId}-heading`}
        className="text-subtitle"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {t('heading')} · <span>{target.nodeLabel}</span>
      </h2>
      {compact ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body">
            <span>
              {projection?.executionOrder.includes(target.executionId)
                ? t('executionNumber', {
                    number: projection.executionOrder.indexOf(target.executionId) + 1,
                  })
                : target.executionId}
            </span>
            <span className="text-muted-foreground">{t('deliveryValue')}</span>
            <span className="text-muted-foreground">{t('scopeValue')}</span>
          </div>
          {compose}
          {target.finished ? (
            <p className="text-body text-muted-foreground">{t('finished')}</p>
          ) : null}
          {(projection?.directiveOrder ?? []).some(
            (id) => projection?.directives[id]?.targetExecutionId === target.executionId,
          ) ? (
            <details>
              <summary>{t('history')}</summary>
              <ExecutionSteering session={session} target={target} compose={null} planSlot={null} />
            </details>
          ) : null}
        </>
      ) : (
        <ExecutionSteering session={session} target={target} compose={compose}>
          <div className="px-3.5 pb-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
              <dt className="text-muted-foreground">{t('target')}</dt>
              <dd>
                {target.nodeLabel} · execution {target.executionId}
              </dd>
              <dt className="text-muted-foreground">{t('delivery')}</dt>
              <dd>{t('deliveryValue')}</dd>
              <dt className="text-muted-foreground">{t('scope')}</dt>
              <dd>{t('scopeValue')}</dd>
            </dl>

            {target.finished ? (
              <p className="text-caption text-muted-foreground">{t('finished')}</p>
            ) : null}
          </div>
        </ExecutionSteering>
      )}

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
        <div className="flex flex-col gap-2 rounded border border-danger p-2 text-caption">
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
        <div className="flex flex-col gap-2 text-caption">
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
    </section>
  );
}
