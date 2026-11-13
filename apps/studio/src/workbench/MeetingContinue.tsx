import type { MeetingHold } from '@corral/contracts';
import type { MeetingResult } from '@corral/core';
import { AgentStatusLabel, DecisionInbox } from '@corral/react/design-kit';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { newCommandId } from '../sessionActions.ts';
import { HOLD_LABEL } from './meetingActivity.ts';

/** Nothing has the focus: it was on something that went (or could no longer be focused). */
const focusLost = () => !document.activeElement || document.activeElement === document.body;

/**
 * The focus left with the answer (its button gave way to the result, or the card left): to the
 * message box of the conversation it was answered in, or, after a continue whose receipt was lost
 * and that came back as a new card (`toCard`), to that card's Continue. Focus a person moved
 * elsewhere stays.
 */
function toBox(handoff: { current: Element | null }, toCard = false) {
  const chat = handoff.current;
  handoff.current = null;
  if (!chat?.isConnected || !focusLost()) return;
  const card = toCard
    ? chat.querySelector<HTMLElement>('[data-meeting-hold] button:not([disabled])')
    : null;
  (card ?? chat.querySelector<HTMLElement>('[data-testid=chat-composer] textarea'))?.focus({
    preventScroll: true,
  });
}

/** After what is rendering now has been committed and painted. */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'undefined') setTimeout(resolve, 0);
    else requestAnimationFrame(() => resolve());
  });

/**
 * A held mention chain's continue card (workbench.md, the meeting): at the end of the timeline,
 * in the place of what the conversation needs now, with one answer, Continue. The kit's decision
 * stack answers only on its receipt: a press sends the command and the button waits, unpressable,
 * until it comes; a refusal frees it with the reason in its place; a receipt that never came is
 * sent again with the same command, after the meeting is read once more. Mount one per hold and
 * per continue before it (keyed by both): each such hold has its command.
 */
export function MeetingContinue({
  hold,
  continueChain,
  onSettled,
  newId = newCommandId,
}: {
  hold: MeetingHold;
  continueChain: (commandId: string) => Promise<MeetingResult>;
  /** The meeting is read again: the hold goes, or comes again as a new card, once it went on. */
  onSettled: () => Promise<void> | void;
  newId?: () => string;
}) {
  const t = useTranslations('Meetings');
  const [commandId] = useState(newId);
  // On its way; the ref closes the gap before a render.
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [continued, setContinued] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  // Answered from the card: when it folds or leaves, the focus goes to the message box.
  const handoff = useRef<Element | null>(null);
  // Not confirmed, and the meeting read again: if the card leaves, a new card takes the focus.
  const lost = useRef(false);
  // Pressable again (refused, or not confirmed) with the focus lost on the way: back to it.
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      const toCard = lost.current;
      if (handoff.current) requestAnimationFrame(() => toBox(handoff, toCard));
    };
  }, []);
  useEffect(() => {
    if (!continued || !handoff.current) return;
    const frame = requestAnimationFrame(() => toBox(handoff));
    return () => cancelAnimationFrame(frame);
  }, [continued]);
  useLayoutEffect(() => {
    if (!refocus || !focusLost()) return;
    box.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus({
      preventScroll: true,
    });
  }, [refocus]);

  const decide = async () => {
    if (inFlight.current || continued) return;
    inFlight.current = true;
    handoff.current = box.current?.contains(document.activeElement)
      ? box.current.closest('[data-chat-view]')
      : null;
    setPending(true);
    setRefused(null);
    let result: MeetingResult | null = null;
    try {
      result = await continueChain(commandId);
    } catch {
      // Not confirmed: read below whether the meeting went on anyway.
      result = null;
    } finally {
      inFlight.current = false;
    }
    // Released while it was on its way (the meeting went on): nothing here to say.
    if (!live.current) return;
    if (result?.ok) {
      setPending(false);
      setContinued(true);
      await onSettled();
      return;
    }
    if (result) {
      setPending(false);
      setRefused(t('hold.refused', { message: result.message }));
    } else {
      // Read the meeting once: if the chain went on, its hold goes or comes again as a new card
      // and this one leaves; if not, this card waits to be pressed again, with the same command.
      lost.current = true;
      await onSettled();
      // What the read brought may not be on screen yet: judge once it is, so a card about to
      // leave does not take back its hand-off.
      await nextFrame();
      if (!live.current) return;
      lost.current = false;
      setPending(false);
    }
    const owned = handoff.current !== null;
    handoff.current = null;
    if (owned) setRefocus((count) => count + 1);
  };
  if (continued)
    // Answered: one line with the answer, no card around it, until the meeting is read again.
    return (
      <div ref={box} data-meeting-hold className="flex min-h-8 items-center px-1">
        <AgentStatusLabel
          data-presence-label={HOLD_LABEL}
          role="status"
          status="done"
          label={t('hold.continued')}
        />
      </div>
    );
  return (
    <div ref={box} data-meeting-hold>
      <DecisionInbox
        decisions={[
          {
            id: hold.after,
            title: t('hold.title'),
            // Refused: the reason stands in the card, under what it asks.
            ...(refused ? { detail: refused } : {}),
            primary: { label: t('hold.continue'), doneLabel: t('hold.continued') },
            pending,
          },
        ]}
        optimistic={false}
        onDecide={() => void decide()}
        // The card's head says it is there: the activity bar says it while the head is out of view.
        heading={() => <span data-presence-label={HOLD_LABEL}>{t('hold.heading')}</span>}
        emptyLabel=""
        labels={{ region: t('hold.region') }}
      />
      {/* The card shows the refusal; this announces it. */}
      <p role="alert" className="sr-only">
        {refused}
      </p>
    </div>
  );
}
