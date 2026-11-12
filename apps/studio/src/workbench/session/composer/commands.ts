import type { CorralSummary, RunSummary } from '@corral/core';
import type { AppCommand } from '../../../commandRegistry.ts';
import type { StudioServices } from '../../../services.tsx';
import { shortcutLabel } from '../../../shortcuts.ts';
import { compactTarget } from '../../compactTarget.ts';
import type { IntentChoice } from '../../composerIntent.ts';

// The composer's slash commands (`/next`, `/steer`, `/pause`, `/resume`, `/compact`, `/stop`,
// `/team`, `/model`) and the run commands they send.

type Say = (key: string, values?: Record<string, string | number>) => string;

export interface RunCommandDeps {
  services: Pick<StudioServices, 'transport'>;
  newId: () => string;
  setError: (message: string | null) => void;
  onChange: () => void;
}

/** Pauses, resumes or cancels the session's run. */
export async function runCommand(
  deps: RunCommandDeps,
  type: 'pause' | 'resume' | 'cancel',
  runId: string | undefined,
) {
  if (!runId) return;
  const receipt = await deps.services.transport
    .sendCommand(
      type === 'cancel'
        ? {
            schemaVersion: '0.1',
            commandId: deps.newId(),
            runId,
            type,
            payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
          }
        : {
            schemaVersion: '0.1',
            commandId: deps.newId(),
            runId,
            type,
            payload: { scope: 'run' },
          },
    )
    .catch((failure: unknown) => ({
      error: { message: failure instanceof Error ? failure.message : String(failure) },
    }));
  if (receipt.error) deps.setError(receipt.error.message);
  deps.onChange();
}

/** Compacts the context of the run's open execution, or says why it cannot now. */
export async function compactContext(
  deps: Omit<RunCommandDeps, 'onChange'> & { ownActive: RunSummary | null; tStatus: Say },
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

/** The composer's commands for the command menu and the slash list. */
export function composerCommands({
  t,
  tc,
  tr,
  tStatus,
  allowed,
  ownActive,
  corrals,
  chooseIntent,
  focus,
  run,
  compact,
  requestStop,
  openTeam,
  openModels,
}: {
  t: Say;
  tc: Say;
  tr: Say;
  tStatus: Say;
  allowed: IntentChoice[];
  ownActive: RunSummary | null;
  corrals: CorralSummary[];
  chooseIntent: (value: IntentChoice) => void;
  focus: () => void;
  run: (type: 'pause' | 'resume') => void;
  compact: () => void;
  requestStop: () => void;
  openTeam: () => void;
  openModels: () => void;
}): AppCommand[] {
  const why = (allowedHere: boolean) => (allowedHere ? undefined : tc('notNow'));
  return [
    ...(['next', 'steer'] as const).map(
      (value): AppCommand => ({
        id: `intent:${value}`,
        title: t(`intent.${value}`),
        group: tc('groupRequest'),
        slash: value,
        keywords: [t(`intentShort.${value}`)],
        disabled: !allowed.includes(value),
        ...(allowed.includes(value) ? {} : { hint: tc('notNow') }),
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
      id: 'composer:focus',
      title: tc('focus'),
      group: tc('groupRequest'),
      shortcutId: 'composer.focus',
      shortcut: shortcutLabel('composer.focus'),
      run: focus,
    },
  ];
}
