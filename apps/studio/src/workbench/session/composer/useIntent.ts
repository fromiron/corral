import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary } from '@corral/core';
import { useState } from 'react';
import {
  intentOf,
  resolveIntent,
  type SendChoice,
  type SendKeyRole,
  type SendKind,
  type SteerTarget,
} from '../../composerIntent.ts';
import type { Ref } from './send.ts';
import type { ComposerDraftState } from './useComposerDraft.ts';

// What each send key does now (features/composer-flow.md "전송"), the target an instruction
// goes to, and the person's choices that fix them.

export function useComposerIntent({
  draft,
  targets,
  lead,
  ready,
  targetNames,
  ownActive,
  active,
}: {
  draft: Pick<ComposerDraftState, 'text' | 'setText' | 'lock' | 'setLock' | 'chosen' | 'setChosen'>;
  targets: SteerTarget[];
  /** The execution writing the conversation's answer. */
  lead: string | null;
  /** The run's projection is read, so the targets are known. */
  ready: boolean;
  targetNames: Ref<Map<string, string>>;
  ownActive: RunSummary | null;
  active: RunSummary | null;
}) {
  const { text, setText, lock, setLock } = draft;
  // The target picked in the target menu, for the run it was picked in.
  const [picked, setPicked] = useState<{ runId: string; id: string } | null>(null);
  const runId = ownActive?.runId ?? null;
  const chosenTarget = picked && picked.runId === runId ? picked.id : null;
  // A new request sent now waits behind a run that is still going in the workspace.
  const waiting = Boolean(active && !TERMINAL_RUN_STATUSES.has(active.status));
  const resolved = resolveIntent({
    running: Boolean(ownActive),
    waiting,
    targets,
    lead,
    chosenTarget,
    lock,
    chosen: draft.chosen,
  });
  const steerTarget = resolved.target ?? '';
  const targetName = (id: string) => targetNames.current.get(id) ?? id;
  /** The intent and delivery a send kind is recorded and sent as. */
  const sendAs = (kind: SendKind) => ({ kind, ...intentOf(kind, waiting) });
  /** What a key sends now. */
  const forKey = (role: SendKeyRole) => sendAs(resolved.keys[role]);
  // The send key's meaning, which Send says and the composer's checks follow.
  const { intent } = forKey('send');

  /** Changes the text; with a picked target, the first character fixes it. */
  const write = (value: string | ((current: string) => string)) => {
    setText(value);
    if (value === '') setLock(null);
    else if (!lock && chosenTarget && resolved.target === chosenTarget)
      setLock({ intent: 'steer', target: chosenTarget });
  };
  /** A send picked for the next send only (`/next`, `/steer`, `/interrupt`). */
  const chooseIntent = (value: SendChoice) => {
    draft.setChosen(value);
    // Choosing to queue leaves a fixed instruction: the person sends this another way.
    if (value === 'queue') setLock(null);
  };
  const chooseTarget = (value: string) => {
    if (!runId) return;
    setPicked({ runId, id: value });
    if (text) setLock({ intent: 'steer', target: value });
  };
  return {
    situation: resolved.situation,
    keys: resolved.keys,
    blocked: resolved.blocked,
    // Until the run's record is read, the target is unknown: nothing is sent to a guess.
    loading: Boolean(ownActive) && !ready && !lock,
    intent,
    forKey,
    sendAs,
    steerTarget,
    targetName,
    write,
    chooseIntent,
    chooseTarget,
  };
}
