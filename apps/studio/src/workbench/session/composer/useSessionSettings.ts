import type { AutoModelChoice } from '@corral/contracts';
import type { SessionAdvisor, WorkSession } from '@corral/core';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../../../services.tsx';
import { autoChoiceFor } from '../../autoChoice.ts';
import type { ProfileInfo } from '../../useModels.ts';
import type { Ref } from './send.ts';

// What the composer saves with the session: the auto model and reasoning, the team, whether the
// server starts queued requests, and the conversation's advisor.

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

  // The conversation's advisor (features/advisor.md "두는 곳" 대화): shown as the session's record
  // says, never before a save confirms it. While it saves, the composer is held: the ref stops a
  // second press or a send in the same moment, and busy holds Send and the other settings on the
  // screen. A conflict or a lost answer reads the session again and shows what it says; nothing is
  // sent again by itself. When that read fails too, the setting is not known: the screen says only
  // that, and a request first reads the session (a later read from anywhere also settles it).
  const tc = useTranslations('Composer');
  const [confirmedAdvisor, setConfirmedAdvisor] = useState<{
    revision: number;
    value: SessionAdvisor | null;
  } | null>(null);
  const advisor =
    confirmedAdvisor && confirmedAdvisor.revision > session.revision
      ? confirmedAdvisor.value
      : (session.advisor ?? null);
  const [advisorSaving, setAdvisorSaving] = useState(false);
  const [advisorProblem, setAdvisorProblem] = useState<string | null>(null);
  // The session as it was read when the setting became unknown; another read of it settles it.
  const [unknownSince, setUnknownSince] = useState<WorkSession | null>(null);
  const advisorUnknown = unknownSince !== null && unknownSince === session;

  /** Reads the session again; whether it was read. */
  const readAdvisor = async (): Promise<boolean> => {
    try {
      const fresh = await repository.getSession(session.sessionId);
      if (!fresh) return false;
      if (mounted.current) {
        setConfirmedAdvisor({ revision: fresh.revision, value: fresh.advisor ?? null });
        setUnknownSince(null);
      }
      return true;
    } catch {
      return false;
    }
  };
  /** After an answer that does not say what the session holds: read it, or call it unknown. */
  const settle = async (known: string) => {
    if (await readAdvisor()) {
      if (mounted.current) setAdvisorProblem(known);
      await router.invalidate();
    } else if (mounted.current) {
      setUnknownSince(session);
      setAdvisorProblem(tc('advisor.unconfirmed'));
    }
  };
  /** Holds the composer while `work` runs. */
  const holding = async <T>(work: () => Promise<T>, otherwise: T): Promise<T> => {
    if (autoSaving.current) return otherwise;
    autoSaving.current = true;
    setBusy(true);
    setAdvisorSaving(true);
    try {
      return await work();
    } finally {
      autoSaving.current = false;
      if (mounted.current) {
        setBusy(false);
        setAdvisorSaving(false);
      }
    }
  };

  const updateAdvisor = async (next: SessionAdvisor | null) => {
    if (busy) return;
    await holding(async () => {
      setAdvisorProblem(null);
      const result = await repository
        .updateSession(session.sessionId, {
          advisor: next,
          expectedRevision: Math.max(session.revision, confirmedAdvisor?.revision ?? 0),
        })
        .catch(() => null);
      if (!mounted.current) return;
      // The REST client answers a dropped connection or a server failure with
      // storage_unavailable: whether the save landed is not known either way.
      if (result === null || (!result.ok && result.error === 'storage_unavailable'))
        await settle(tc('advisor.lost'));
      else if (result.ok) {
        setConfirmedAdvisor({
          revision: result.session.revision,
          value: result.session.advisor ?? null,
        });
        setUnknownSince(null);
        await router.invalidate();
      } else if (result.error === 'revision_conflict') await settle(tc('advisor.conflict'));
      else setAdvisorProblem(tc('advisor.failed', { message: result.message }));
    }, undefined);
  };

  /** Reads the session again while the setting is unknown; whether it is known now. */
  const recheckAdvisor = () =>
    holding(async () => {
      const known = await readAdvisor();
      if (!mounted.current) return known;
      setAdvisorProblem(known ? null : tc('advisor.unconfirmed'));
      if (known) await router.invalidate();
      return known;
    }, false);

  return {
    autoChoice,
    updateAuto,
    updateTeam,
    autoStart,
    updateAutoStart,
    advisor,
    advisorUnknown,
    advisorSaving,
    // Once something else settles an unknown setting, its "not confirmed" goes with it.
    advisorProblem:
      advisorUnknown || advisorProblem !== tc('advisor.unconfirmed') ? advisorProblem : null,
    updateAdvisor,
    recheckAdvisor,
  };
}
