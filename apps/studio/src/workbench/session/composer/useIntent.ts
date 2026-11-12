import type { RunSummary } from '@corral/core';
import { useState } from 'react';
import { type IntentChoice, resolveIntent } from '../../composerIntent.ts';
import type { Ref } from './send.ts';
import type { ComposerDraftState } from './useComposerDraft.ts';

// What Send does now: a next request (started or queued) or an instruction to an execution of
// the session's run, and the person's choices that fix it.

export function useComposerIntent({
  draft,
  targets,
  targetNames,
  ownActive,
  active,
}: {
  draft: Pick<ComposerDraftState, 'text' | 'setText' | 'lock' | 'setLock' | 'chosen' | 'setChosen'>;
  targets: { id: string; label: string }[];
  targetNames: Ref<Map<string, string>>;
  ownActive: RunSummary | null;
  active: RunSummary | null;
}) {
  const { text, setText, lock, setLock } = draft;
  const [target, setTarget] = useState<string>('');
  // A next request, or an instruction to this session's current execution. A next request sent
  // while the session's run is going waits behind it; an instruction needs an execution that can
  // still take one (none while a decision waits).
  const allowed: IntentChoice[] = ownActive && targets.length > 0 ? ['next', 'steer'] : ['next'];
  const resolved = resolveIntent({
    allowed,
    chosen: draft.chosen,
    chosenTarget: target || null,
    lock,
    targets: targets.map((x) => x.id),
    running: Boolean(ownActive),
    waiting: Boolean(active),
  });
  const intent = resolved.intent;
  const steerTarget = resolved.target ?? '';
  const targetName = (id: string) => targetNames.current.get(id) ?? id;

  /** Changes the text; the first character fixes an instruction's target. */
  const write = (value: string | ((current: string) => string)) => {
    setText(value);
    if (value === '') setLock(null);
    else if (!lock && intent === 'steer') setLock({ intent: 'steer', target: steerTarget || null });
  };
  /** An explicit choice by the person; an instruction is fixed while text is typed. */
  const chooseIntent = (value: IntentChoice) => {
    draft.setChosen(value);
    setLock(
      text && value === 'steer'
        ? { intent: 'steer', target: (lock?.target ?? steerTarget) || targets[0]?.id || null }
        : null,
    );
  };
  const chooseTarget = (value: string) => {
    setTarget(value);
    if (text) setLock({ intent: 'steer', target: value });
  };
  return {
    allowed,
    blocked: resolved.blocked,
    intent,
    steerTarget,
    targetName,
    write,
    chooseIntent,
    chooseTarget,
  };
}
