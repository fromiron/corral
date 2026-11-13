/**
 * Where focus goes once a decision or an answer sent from its card has left it (workbench.md,
 * inbox.md): the main action of the next card that still waits in the same response place (an
 * approval's main action, or its decline when that action cannot be taken yet; a question's first
 * answer field; an extension request's field, else its main answer), else the conversation's
 * request box. `place` is the response place the card stood
 * in (a conversation's needed-now tray, else the run's response area); `chat` the chat view around
 * it, if any; `answered` the card just answered, passed over while it is still drawn. Null when
 * neither has a target, so the host places focus itself.
 */
export function nextResponseTarget(
  place: ParentNode | null | undefined,
  chat: Element | null | undefined,
  answered?: Element | null,
): HTMLElement | null {
  // Cards in reading order: approvals, questions and continue-or-stop decisions. A card already
  // answered, or one whose decision is on its way, has no control to take focus and is passed over.
  const cards = place?.querySelectorAll<HTMLElement>(
    '[data-approval], [data-question], [data-extension], [data-continue-decisions] [data-open="true"]',
  );
  for (const card of cards ?? []) {
    if (answered && (card === answered || answered.contains(card))) continue;
    const target = card.matches('[data-approval]')
      ? (card.querySelector<HTMLElement>('[data-approval-action="primary"]:not(:disabled)') ??
        card.querySelector<HTMLElement>('[data-approval-action]:not(:disabled)'))
      : card.matches('[data-question]')
        ? card.querySelector<HTMLElement>(
            'form input:not(:disabled), form textarea:not(:disabled), form select:not(:disabled)',
          )
        : card.matches('[data-extension]')
          ? // An extension's field (its input or its choice), else its main answer.
            (card.querySelector<HTMLElement>(
              'input:not(:disabled), textarea:not(:disabled), [role="combobox"]:not([disabled])',
            ) ??
            card.querySelector<HTMLElement>('[data-extension-action="primary"]:not(:disabled)'))
          : card.querySelector<HTMLElement>('button:not(:disabled)');
    if (target) return target;
  }
  return chat?.isConnected
    ? chat.querySelector<HTMLElement>('[data-testid=chat-composer] textarea')
    : null;
}
