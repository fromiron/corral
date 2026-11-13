import type { MeetingHold } from '@corral/contracts';
import type { MeetingResult } from '@corral/core';
import { DecisionInbox } from '@corral/react/design-kit';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { newCommandId } from '../sessionActions.ts';

/**
 * The focus left with the answer (its button gave way to the result, or the card left): to the
 * message box of the conversation it was answered in. Focus a person moved elsewhere stays.
 */
function toBox(handoff: { current: Element | null }) {
  const chat = handoff.current;
  handoff.current = null;
  if (!chat?.isConnected) return;
  if (document.activeElement && document.activeElement !== document.body) return;
  chat.querySelector<HTMLElement>('[data-testid=chat-composer] textarea')?.focus({
    preventScroll: true,
  });
}

/**
 * A held mention chain's continue card (workbench.md, the meeting): at the end of the timeline,
 * in the place of what the conversation needs now, with one answer, Continue. The kit's decision
 * stack answers only on its receipt: a press sends the command and the button waits, unpressable,
 * until it comes; a refusal frees it with the reason in its place; a receipt that never came is
 * sent again with the same command. Mount one per hold (keyed by it): each hold has its command.
 */
export function MeetingContinue({
  hold,
  continueChain,
  onSettled,
  newId = newCommandId,
}: {
  hold: MeetingHold;
  continueChain: (commandId: string) => Promise<MeetingResult>;
  /** The meeting is read again: the hold goes once the chain goes on. */
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
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (handoff.current) requestAnimationFrame(() => toBox(handoff));
    };
  }, []);
  useEffect(() => {
    if (!continued || !handoff.current) return;
    const frame = requestAnimationFrame(() => toBox(handoff));
    return () => cancelAnimationFrame(frame);
  }, [continued]);

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
      // Not confirmed: the hold still waits, and the next press sends this same command.
      result = null;
    } finally {
      inFlight.current = false;
    }
    // Released while it was on its way (the meeting went on): nothing here to say.
    if (!live.current) return;
    setPending(false);
    if (result && !result.ok) {
      handoff.current = null;
      setRefused(t('hold.refused', { message: result.message }));
    } else if (result) setContinued(true);
    else handoff.current = null;
    if (result?.ok) await onSettled();
  };
  return (
    <div ref={box} data-meeting-hold className="flex flex-col gap-2">
      <DecisionInbox
        decisions={[
          {
            id: hold.after,
            title: t('hold.title'),
            // Refused: the reason stands in the card, under what it asks.
            ...(refused ? { detail: refused } : {}),
            primary: { label: t('hold.continue'), doneLabel: t('hold.continued') },
            pending,
            ...(continued ? { resolution: t('hold.continued') } : {}),
          },
        ]}
        optimistic={false}
        onDecide={() => void decide()}
        heading={() => t('hold.heading')}
        clearHeading={t('hold.continued')}
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
