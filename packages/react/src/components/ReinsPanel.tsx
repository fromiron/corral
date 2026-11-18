import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button, cn, fontWeights, KitBadge, Textarea } from '../design-kit/index.ts';
import { keepInput, keptInput } from '../keptInputs.ts';
import type { RunSessionStore } from '../run/session.ts';
import { CommandReceipts } from './CommandReceipts.tsx';
import { ExecutionSteering } from './ExecutionSteering.tsx';
import { SettingsPatchPanel } from './SettingsPatchPanel.tsx';
import { TermHint } from './TermHint.tsx';

export interface SteerTarget {
  executionId: string;
  nodeLabel: string;
  /** Finished targets stay visible read-only so undelivered instructions are not hidden. */
  finished: boolean;
}

/**
 * Steering one execution: the Reins area, titled by the name and its target. The header always
 * says who receives the instruction, when it takes effect and how far it reaches. Directive badges
 * change only on committed events.
 */
interface Draft {
  runId: string | null;
  executionId: string;
  nodeLabel: string;
  text: string;
  commandId?: string;
}
const draftKey = (runId: string | null, executionId: string) =>
  `reins:${runId ?? ''}:${executionId}`;

/**
 * The areas on screen, told when a draft sent from one of them is settled by its answer: an area
 * opened again for that execution before the answer starts from the same kept draft, and takes
 * what the answer leaves (nothing, or the draft with its lost command).
 */
const settledDrafts = new Set<(sent: Draft, next: Draft | null) => void>();

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
  const name = useTranslations('Terms');
  const inputId = useId();
  const [draft, setDraftState] = useState<Draft | null>(() =>
    target
      ? (keptInput<Draft>(draftKey(session.getState().runId, target.executionId)) ?? null)
      : null,
  );
  // An unsent instruction is kept for its execution after this area goes, until a reload: opening
  // 지시하기 for that execution again has it (features/session-panel.md 닫기와 패널 여닫기).
  // The kept entry is written beside the state, never inside an updater: an answer that arrives
  // after the area went still settles what is kept.
  const current = useRef(draft);
  current.current = draft;
  const setDraft = useCallback((next: Draft | null) => {
    const before = current.current;
    if (before) keepInput(draftKey(before.runId, before.executionId), null);
    if (next) keepInput(draftKey(next.runId, next.executionId), next);
    current.current = next;
    setDraftState(next);
  }, []);
  /** Settles a draft sent earlier: what is kept for it, and the area if it still shows it. */
  const settle = useCallback((sent: Draft, next: Draft | null) => {
    const key = draftKey(sent.runId, sent.executionId);
    if (keptInput<Draft>(key) === sent) keepInput(key, next);
    for (const area of [...settledDrafts]) area(sent, next);
  }, []);
  useEffect(() => {
    const take = (sent: Draft, next: Draft | null) => {
      if (current.current === sent) current.current = next;
      setDraftState((shown) => (shown === sent ? next : shown));
    };
    settledDrafts.add(take);
    return () => {
      settledDrafts.delete(take);
    };
  }, []);
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
  const targetKey = target ? draftKey(runId, target.executionId) : null;
  useEffect(() => {
    if (!targetKey) return;
    const kept = keptInput<Draft>(targetKey);
    if (kept) setDraftState((current) => current ?? kept);
  }, [targetKey]);
  useEffect(() => {
    const shown = current.current;
    if (recovered && recovered.status !== 'rejected' && shown?.commandId === recovered.commandId)
      settle(shown, null);
  }, [recovered, settle]);

  // The area's name, Reins, with its explanation right after the title, beside it rather than in
  // it, so the heading names only the area (glossary.md, features/term-hints.md). A long role name
  // wraps the title: the row takes the heading's line height and the icon centres on one such
  // line from the top, so it stands on the first line, where it stands on a one-line title.
  const title = (role: string | null) => (
    <div className="flex min-w-0 flex-nowrap items-start gap-0.5 text-subtitle">
      <h2
        id={`${inputId}-heading`}
        className="min-w-0 text-subtitle"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {role === null ? (
          name('reins.name')
        ) : (
          <>
            {name('reins.name')} · <span>{role}</span>
          </>
        )}
      </h2>
      <TermHint term="reins" firstLine />
    </div>
  );

  if (!target) {
    return (
      <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-2">
        {title(null)}
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
    // A draft whose answer was lost goes again as that same command, never under a new id.
    const lost = draft?.commandId
      ? session.getState().unconfirmedCommands[draft.commandId]
      : undefined;
    if (draft && lost) {
      try {
        const receipt = await session.getState().retryCommand(lost.command.commandId);
        if (receipt.status !== 'rejected') settle(draft, null);
      } catch {
        // Still lost: the draft keeps its command for the next try.
      }
      return;
    }
    try {
      const receipt = await steer(target.executionId, instruction);
      if (receipt.status !== 'rejected' && draft) settle(draft, null);
    } catch {
      const pending = Object.values(session.getState().unconfirmedCommands).find(
        ({ command }) =>
          command.runId === draft?.runId &&
          command.type === 'steer' &&
          command.payload.targetExecutionId === draft.executionId &&
          command.payload.text === instruction,
      );
      if (pending && draft) settle(draft, { ...draft, commandId: pending.command.commandId });
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
      <div
        data-reins-compose
        className={cn(
          'mt-2.5 flex flex-col gap-1 border-t border-border py-2.5',
          // Inside the full panel's activity card it takes the card's inset; the compact form
          // stands in the page, its field flush with the heading and the lines around it.
          compact ? null : 'pr-3 pl-3.5',
        )}
      >
        {/* The heading above already says what this field is; the label stays its name. */}
        <label htmlFor={inputId} className="sr-only">
          {t('instruction')}
        </label>
        <Textarea
          id={inputId}
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
          className="self-end"
        >
          {pending ? t('sending') : t('send')}
        </Button>
      </div>
    ) : null;

  const heading = title(target.nodeLabel);
  return (
    <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-3">
      {compact ? (
        // When the instruction arrives and what it reaches sit beside the heading as chips.
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {heading}
          {(
            [
              ['delivery', 'deliveryValue'],
              ['scope', 'scopeValue'],
            ] as const
          ).map(([name, value]) => (
            <KitBadge key={name} data-reins-chip>
              <span className="sr-only">{t(name)}: </span>
              {t(value)}
            </KitBadge>
          ))}
        </div>
      ) : (
        heading
      )}
      {compact ? (
        <>
          <p className="text-body">
            {projection?.executionOrder.includes(target.executionId)
              ? t('executionNumber', {
                  number: projection.executionOrder.indexOf(target.executionId) + 1,
                })
              : target.executionId}
          </p>
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
            className="text-destructive-foreground"
          >
            {t('confirmCancelExecution')}
          </Button>
          <Button type="button" onClick={() => setCancelTarget(null)} variant="secondary">
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
