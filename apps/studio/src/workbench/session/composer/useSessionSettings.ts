import type { AutoModelChoice } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useServices } from '../../../services.tsx';
import { autoChoiceFor } from '../../autoChoice.ts';
import type { ProfileInfo } from '../../useModels.ts';
import type { Ref } from './send.ts';

// What the composer saves with the session: the auto model and reasoning, and the team.

export function useSessionSettings({
  session,
  profiles,
  busy,
  setBusy,
  setError,
  autoSaving,
  mounted,
  failed,
}: {
  session: WorkSession;
  profiles: ProfileInfo[] | null;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  autoSaving: Ref<boolean>;
  mounted: Ref<boolean>;
  failed: (message: string) => string;
}) {
  const { repository } = useServices();
  const router = useRouter();
  const [confirmedAuto, setConfirmedAuto] = useState<{
    revision: number;
    choice: AutoModelChoice;
  } | null>(null);
  const autoChoice = autoChoiceFor(
    confirmedAuto && confirmedAuto.revision > session.revision
      ? confirmedAuto.choice
      : session.auto,
    profiles,
  );

  /** Saves the auto model and reasoning with the session. */
  const updateAuto = async (auto: AutoModelChoice) => {
    if (autoSaving.current || busy) return;
    autoSaving.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await repository.updateSession(session.sessionId, {
        auto,
        expectedRevision: Math.max(session.revision, confirmedAuto?.revision ?? 0),
      });
      if (!mounted.current) return;
      if (!result.ok) throw new Error(result.message);
      setConfirmedAuto({ revision: result.session.revision, choice: auto });
      await router.invalidate();
    } catch (failure) {
      if (mounted.current)
        setError(failed(failure instanceof Error ? failure.message : String(failure)));
    } finally {
      autoSaving.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const updateTeam = async (corralId: string) => {
    const result = await repository.updateSession(session.sessionId, {
      corralId: corralId || null,
      expectedRevision: session.revision,
    });
    if (!result.ok) setError(failed(result.message));
    else await router.invalidate();
  };

  // Whether the server starts the next queued request when the run ends: a session setting
  // (features/composer-flow.md "대기 요청과 넘겨받기"), shown as saved once the save confirms.
  const [confirmedAutoStart, setConfirmedAutoStart] = useState<{
    revision: number;
    value: boolean;
  } | null>(null);
  const autoStart =
    confirmedAutoStart && confirmedAutoStart.revision > session.revision
      ? confirmedAutoStart.value
      : session.autoStart;
  const updateAutoStart = async (value: boolean) => {
    setError(null);
    try {
      const result = await repository.updateSession(session.sessionId, {
        autoStart: value,
        expectedRevision: Math.max(session.revision, confirmedAutoStart?.revision ?? 0),
      });
      if (!mounted.current) return;
      if (!result.ok) throw new Error(result.message);
      setConfirmedAutoStart({ revision: result.session.revision, value });
      await router.invalidate();
    } catch (failure) {
      if (mounted.current)
        setError(failed(failure instanceof Error ? failure.message : String(failure)));
    }
  };

  return { autoChoice, updateAuto, updateTeam, autoStart, updateAutoStart };
}
