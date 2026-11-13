/**
 * Where focus goes once a decision sent from its card has left it (workbench.md): the main action
 * of the next card that still waits in the same response place (its decline when that action
 * cannot be taken yet), else the conversation's request box. `place` is the response place the
 * card stood in (a conversation's needed-now tray, else the card's own area); `chat` the chat view
 * around it, if any. Null when neither has a target, so the host places focus itself.
 */
export function nextResponseTarget(
  place: ParentNode | null | undefined,
  chat: Element | null | undefined,
): HTMLElement | null {
  // Cards in reading order: approvals and continue-or-stop decisions. A card already answered,
  // or one whose decision is on its way, has no button to take focus and is passed over.
  const cards = place?.querySelectorAll<HTMLElement>(
    '[data-approval], [data-continue-decisions] [data-open="true"]',
  );
  for (const card of cards ?? []) {
    const target = card.matches('[data-approval]')
      ? (card.querySelector<HTMLElement>('[data-approval-action="primary"]:not(:disabled)') ??
        card.querySelector<HTMLElement>('[data-approval-action]:not(:disabled)'))
      : card.querySelector<HTMLElement>('button:not(:disabled)');
    if (target) return target;
  }
  return chat?.isConnected
    ? chat.querySelector<HTMLElement>('[data-testid=chat-composer] textarea')
    : null;
}
