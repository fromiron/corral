import { ApiError, type ModelsApi } from '@corral/client';
import type { CorralSummary, RunSummary } from '@corral/core';
import type { AppCommand } from '../../../commandRegistry.ts';
import type { StudioServices } from '../../../services.tsx';
import { shortcutLabel } from '../../../shortcuts.ts';
import { compactTarget } from '../../compactTarget.ts';
import type { SendChoice } from '../../composerIntent.ts';
import { parseContextWindow } from '../../contextWindowText.ts';
import { withProfileWindow } from '../../profileWindow.ts';

// The composer's slash commands (`/next`, `/steer`, `/interrupt`, `/pause`, `/resume`,
// `/compact`, `/stop`, `/team`, `/model`, `/autocompaction`) and the commands they send.

type Say = (key: string, values?: Record<string, string | number>) => string;

export interface RunCommandDeps {
  services: Pick<StudioServices, 'transport' | 'runFor'>;
  newId: () => string;
  setError: (message: string | null) => void;
  onChange: () => void;
  /**
   * What became of a run command just pressed: no failure once it is pressed (and when it is
   * received), else a refusal or a lost answer.
   */
  onResult: (runId: string, failure: RunCommandFailure | null) => void;
}

/** A run command the run refused, with its reason, or one whose answer never came. */
export type RunCommandFailure = { kind: 'refused'; message: string } | { kind: 'unconfirmed' };

/**
 * Pauses, resumes or cancels the session's run by the run's own command path, as the run record's
 * controls do (features/composer-flow.md "활동 바"): one command at a time, its receipt kept, and
 * a lost response checked again under its first id, never sent again as a new command.
 */
export async function runCommand(
  deps: RunCommandDeps,
  type: 'pause' | 'resume' | 'cancel',
  runId: string | undefined,
) {
  if (!runId) return;
  const store = deps.services.runFor(runId);
  // A press while a command is being sent is not another command.
  if ((store.getState().pendingCommandIds?.length ?? 0) > 0) return;
  deps.onResult(runId, null);
  // The store is this run's own: opening it names the run before its record is read.
  if (store.getState().runId !== runId) await store.getState().open(runId);
  // A lost answer is kept by the store and checked again under its first id on the next press.
  const receipt = await store
    .getState()
    .sendCommand(
      type === 'cancel'
        ? { type, payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' } }
        : { type, payload: { scope: 'run' } },
    )
    .catch(() => null);
  const failure: RunCommandFailure | null = !receipt
    ? { kind: 'unconfirmed' }
    : receipt.error
      ? { kind: 'refused', message: receipt.error.message }
      : null;
  deps.onResult(runId, failure);
  deps.onChange();
}

/** Compacts the context of the run's open execution, or says why it cannot now. */
export async function compactContext(
  deps: Omit<RunCommandDeps, 'onChange' | 'onResult'> & {
    ownActive: RunSummary | null;
    tStatus: Say;
  },
) {
  const { ownActive, tStatus, setError } = deps;
  if (!ownActive) {
    setError(tStatus('compactNoExecution'));
    return;
  }
  if (ownActive.status === 'cancelling') {
    setError(tStatus('compactCancelling'));
    return;
  }
  const snapshot = await deps.services.transport
    .getSnapshot(ownActive.runId)
    .catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : tStatus('compactUnavailable'));
      return null;
    });
  if (!snapshot || snapshot.projection.runId !== ownActive.runId) return;
  const decision = compactTarget(snapshot.projection, null);
  if (!decision.ok) {
    setError(tStatus(decision.reason));
    return;
  }
  if (decision.pending) {
    setError(tStatus('compactPhase.queued'));
    return;
  }
  const receipt = await deps.services.transport
    .sendCommand({
      schemaVersion: '0.1',
      commandId: deps.newId(),
      runId: ownActive.runId,
      type: 'compact_context',
      expectedControlRevision: decision.expectedControlRevision,
      payload: { executionId: decision.executionId, attemptNo: decision.attemptNo },
    })
    .catch((failure: unknown) => ({
      error: { message: failure instanceof Error ? failure.message : String(failure) },
    }));
  if (receipt.error) setError(receipt.error.message);
}

export async function autoCompaction(
  deps: {
    models: Pick<ModelsApi, 'profiles' | 'config' | 'saveConfig' | 'setModelContextWindow'> | null;
    modelProfile: string;
    tc: Say;
    sourceName: Say;
    setError: (message: string | null) => void;
    setNotice: (message: string | null) => void;
  },
  value: string | undefined,
) {
  const { models, tc } = deps;
  const refuse = (message: string) => {
    deps.setNotice(null);
    deps.setError(message);
  };
  const say = (message: string) => {
    deps.setError(null);
    deps.setNotice(message);
  };
  const wanted =
    value === undefined
      ? undefined
      : value.toLowerCase() === 'off'
        ? null
        : parseContextWindow(value);
  if (wanted === 'invalid') return refuse(tc('autocompaction.invalid'));
  if (!models) return refuse(tc('autocompaction.noModel'));
  const find = async () =>
    (await models.profiles()).find((view) => view.profileId === deps.modelProfile);
  try {
    const chosen = await find();
    if (!chosen) return refuse(tc('autocompaction.noModel'));
    const model = chosen.modelName ?? chosen.modelId;
    const unknown = tc('autocompaction.unknown', { model });
    if (wanted === undefined) {
      const policy = chosen.contextPolicy;
      return say(
        policy
          ? tc('autocompaction.current', {
              model,
              value: policy.contextWindow,
              source: deps.sourceName(`source.${policy.sources.contextWindow}`),
            })
          : unknown,
      );
    }
    const owned = chosen.contextPolicy?.sources.contextWindow === 'profile';
    const save = async () => {
      const config = await models.config();
      if (owned) await models.saveConfig(withProfileWindow(config, chosen.profileId, wanted));
      else
        await models.setModelContextWindow({
          revision: config.revision,
          provider: chosen.provider,
          model: chosen.modelId,
          contextWindow: wanted,
        });
      return config;
    };
    const config = await save().catch((failure: unknown) => {
      if (failure instanceof ApiError && failure.code === 'REVISION_CONFLICT') return save();
      throw failure;
    });
    const modelWide = owned
      ? config.modelContextWindows?.find(
          (entry) => entry.provider === chosen.provider && entry.model === chosen.modelId,
        )?.contextWindow
      : undefined;
    const next = wanted ?? modelWide ?? chosen.contextPolicy?.baseContextWindow ?? null;
    say(next === null ? unknown : tc('autocompaction.next', { model, value: next }));
  } catch (failure) {
    refuse(failure instanceof Error ? failure.message : String(failure));
  }
}

/** The composer's commands for the command menu and the slash list. */
export function composerCommands({
  t,
  tc,
  tr,
  tStatus,
  available,
  ownActive,
  corrals,
  chooseIntent,
  focus,
  run,
  compact,
  autocompaction,
  requestStop,
  openTeam,
  openModels,
}: {
  t: Say;
  tc: Say;
  tr: Say;
  tStatus: Say;
  /** The sends that can be picked now. */
  available: Record<SendChoice, boolean>;
  ownActive: RunSummary | null;
  corrals: CorralSummary[];
  chooseIntent: (value: SendChoice) => void;
  focus: () => void;
  run: (type: 'pause' | 'resume') => void;
  compact: () => void;
  autocompaction: (value?: string) => void;
  requestStop: () => void;
  openTeam: () => void;
  openModels: () => void;
}): AppCommand[] {
  const why = (allowedHere: boolean) => (allowedHere ? undefined : tc('notNow'));
  return [
    // Each picks its send for the next send only (features/composer-flow.md "전송").
    ...(
      [
        ['next', 'queue'],
        ['steer', 'join'],
        ['interrupt', 'interrupt'],
      ] as const
    ).map(
      ([slash, value]): AppCommand => ({
        id: `intent:${slash}`,
        title: tc(`sendAs.${value}`),
        group: tc('groupRequest'),
        slash,
        keywords: [tc(`keyHint.${value}`)],
        disabled: !available[value],
        ...(available[value] ? {} : { hint: tc('notNow') }),
        run: () => {
          chooseIntent(value);
          focus();
        },
      }),
    ),
    {
      id: 'run:pause',
      title: tr('pause'),
      group: tc('groupRun'),
      slash: 'pause',
      disabled: ownActive?.status !== 'running',
      hint: why(ownActive?.status === 'running'),
      run: () => run('pause'),
    },
    {
      id: 'run:resume',
      title: tr('resume'),
      group: tc('groupRun'),
      slash: 'resume',
      disabled: ownActive?.status !== 'paused',
      hint: why(ownActive?.status === 'paused'),
      run: () => run('resume'),
    },
    {
      id: 'run:compact',
      title: tStatus('compactRequest'),
      group: tc('groupRun'),
      slash: 'compact',
      keywords: ['context'],
      run: compact,
    },
    {
      id: 'run:stop',
      title: tr('cancelRun'),
      group: tc('groupRun'),
      slash: 'stop',
      // Found by its name in either language and by the word it had before.
      keywords: ['stop', '중지', 'cancel', '취소'],
      shortcutId: 'run.stop',
      shortcut: shortcutLabel('run.stop'),
      disabled: !ownActive,
      hint: why(Boolean(ownActive)),
      run: requestStop,
    },
    {
      id: 'composer:team',
      title: t('chooseTeam'),
      group: tc('groupRequest'),
      slash: 'team',
      keywords: [t('autoTeam'), ...corrals.map((c) => c.name)],
      run: openTeam,
    },
    {
      id: 'composer:models',
      title: tc('models.title'),
      group: tc('groupRequest'),
      slash: 'model',
      run: openModels,
    },
    {
      id: 'composer:autocompaction',
      title: tc('autocompaction.title'),
      group: tc('groupRequest'),
      slash: 'autocompaction',
      takesValue: true,
      keywords: ['context', 'compaction', '컨텍스트', '압축'],
      run: autocompaction,
    },
    {
      id: 'composer:focus',
      title: tc('focus'),
      group: tc('groupRequest'),
      shortcutId: 'composer.focus',
      shortcut: shortcutLabel('composer.focus'),
      run: focus,
    },
  ];
}
