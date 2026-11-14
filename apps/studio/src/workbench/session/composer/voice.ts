import type { VoiceTranscript, VoiceTranscriptReceipt } from '@corral/client';
import type { PermissionMode } from '@corral/contracts';
import type { RunSummary } from '@corral/core';
import { useRef } from 'react';
import type { StudioServices } from '../../../services.tsx';
import {
  entryStart,
  queuedStart,
  type RecordDeps,
  type Ref,
  recordEntry,
  type StartDeps,
  startNext,
} from './send.ts';

// A finished voice utterance goes the same three ways as typed text: queued, as an
// instruction to the pinned execution, or as a next request.

export interface VoiceDeps extends StartDeps, RecordDeps {
  services: Pick<StudioServices, 'mode' | 'live' | 'startAuto' | 'transport' | 'repository'>;
  messages: { selectedTeamMissing: string; failed: (message: string) => string };
  /** This page's host, which a transcript's target must name. */
  hostId: string;
  ownActive: RunSummary | null;
  targets: { id: string }[];
  permissionMode: PermissionMode | undefined;
  voiceSubmitting: Ref<boolean>;
  autoSaving: Ref<boolean>;
  mounted: Ref<boolean>;
  setBusy: (busy: boolean) => void;
  onSent: (() => void) | undefined;
  invalidate: () => Promise<void>;
  onChange: () => void;
}

export async function performVoice(
  deps: VoiceDeps,
  utterance: VoiceTranscript,
): Promise<VoiceTranscriptReceipt> {
  const { ownActive, permissionMode } = deps;
  if (
    utterance.target.hostId !== deps.hostId ||
    utterance.target.sessionId !== deps.session.sessionId
  )
    return {
      status: 'rejected',
      message: 'The voice destination changed. Reconnect explicitly.',
    };
  if (deps.voiceSubmitting.current || deps.autoSaving.current)
    return {
      status: 'rejected',
      message: 'Another request is being submitted. Retry this same utterance.',
    };
  if (
    !utterance.delivery &&
    utterance.target.runId &&
    (ownActive?.runId !== utterance.target.runId ||
      !utterance.target.executionId ||
      !deps.targets.some((item) => item.id === utterance.target.executionId))
  )
    return {
      status: 'rejected',
      message:
        'The pinned execution cannot receive an instruction (it ended or is waiting for a decision). Choose queue or next request explicitly.',
      alternatives: ['queue', 'next'],
    };
  if (!utterance.delivery && !utterance.target.runId && ownActive)
    return {
      status: 'rejected',
      message:
        'A run started after this call was connected. Queue this utterance or reconnect to select its execution.',
      alternatives: ['queue'],
    };
  deps.voiceSubmitting.current = true;
  deps.setBusy(true);
  deps.onSent?.();
  try {
    if (utterance.delivery === 'queue') {
      await recordEntry(deps, {
        intent: 'queue',
        text: utterance.text,
        state: 'queued',
        commandId: utterance.commandId,
        ...(permissionMode ? { permissionMode } : {}),
        // The server starts it with this once the session's run ends.
        start: queuedStart(deps, utterance.text, permissionMode),
      });
      deps.onChange();
      return { status: 'queued' };
    }
    if (!utterance.delivery && utterance.target.runId && utterance.target.executionId) {
      const receipt = await deps.services.transport.sendCommand({
        schemaVersion: '0.1',
        commandId: utterance.commandId,
        runId: utterance.target.runId,
        type: 'steer',
        payload: {
          targetExecutionId: utterance.target.executionId,
          text: utterance.text,
          delivery: 'next_request',
        },
      });
      await recordEntry(deps, {
        intent: 'steer',
        text: utterance.text,
        state: receipt.error ? 'refused' : 'sent',
        runId: utterance.target.runId,
        executionId: utterance.target.executionId,
        detail: receipt.error?.message ?? null,
        refusal: receipt.error ?? null,
        commandId: utterance.commandId,
      });
      deps.onChange();
      return receipt.error
        ? { status: 'rejected', message: receipt.error.message }
        : {
            status: 'accepted',
            message: 'Accepted for the next request boundary; not yet delivered.',
          };
    }
    const result = await startNext(deps, utterance.text, utterance.commandId, [], permissionMode);
    await recordEntry(deps, {
      ...(permissionMode ? { permissionMode } : {}),
      intent: 'next',
      text: utterance.text,
      state: result.runId ? 'started' : 'refused',
      runId: result.runId,
      detail: result.detail,
      refusal: result.error ?? null,
      commandId: utterance.commandId,
      ...(result.auto ? { auto: result.auto } : {}),
      ...(result.request ? { start: entryStart(result.request) } : {}),
    });
    await deps.invalidate();
    deps.onChange();
    return result.runId
      ? { status: 'accepted' }
      : { status: 'rejected', message: result.detail ?? 'The request was not accepted.' };
  } finally {
    deps.voiceSubmitting.current = false;
    if (deps.mounted.current) deps.setBusy(false);
  }
}

/** The live voice transcript handler for this render's state. */
export function useVoiceTranscript(deps: Omit<VoiceDeps, 'voiceSubmitting'>, busy: boolean) {
  const voiceSubmitting = useRef(false);
  const submissions = useRef(new Map<string, () => Promise<VoiceTranscriptReceipt>>());
  return (utterance: VoiceTranscript) =>
    submitVoice(
      {
        hostId: deps.hostId,
        sessionId: deps.session.sessionId,
        busy,
        autoSaving: deps.autoSaving,
        submissions: submissions.current,
        perform: (value) => performVoice({ ...deps, voiceSubmitting }, value),
      },
      utterance,
    );
}

/**
 * Keeps the original request closure (model, policy, execution and startFrom) across a lost
 * receipt. New renders may already show the run started by this very command.
 */
export function submitVoice(
  {
    hostId,
    sessionId,
    busy,
    autoSaving,
    submissions,
    perform,
  }: {
    hostId: string;
    sessionId: string;
    busy: boolean;
    autoSaving: Ref<boolean>;
    submissions: Map<string, () => Promise<VoiceTranscriptReceipt>>;
    perform: (utterance: VoiceTranscript) => Promise<VoiceTranscriptReceipt>;
  },
  utterance: VoiceTranscript,
): Promise<VoiceTranscriptReceipt> {
  if (utterance.target.hostId !== hostId || utterance.target.sessionId !== sessionId)
    return Promise.resolve({
      status: 'rejected',
      message: 'The voice destination changed. Reconnect explicitly.',
    });
  if (busy || autoSaving.current)
    return Promise.resolve({
      status: 'rejected',
      message: 'Another request is being submitted. Retry this same utterance.',
    });
  let submit = submissions.get(utterance.commandId);
  if (!submit) {
    submit = () => perform(utterance);
    submissions.set(utterance.commandId, submit);
  }
  return submit();
}
