// The send keys alone, without the preferences store, so a page that holds no app state (the
// desktop's annotation overlay) can read a key press the composer's way.

/** The composer's send key setting (preferences' `sendKey`). */
export type SendKey = 'enter' | 'mod-enter';

/**
 * Which of the composer's three send keys a key press is (features/composer-flow.md "전송"):
 * the send key; the interrupt key (Mod+Enter, or Mod+Shift+Enter when Mod+Enter sends); Alt+Enter.
 * Anything else, such as the line-break key, is null. The caller rules out an IME composition.
 */
export function sendKeyRole(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  sendKey: SendKey,
): 'send' | 'interrupt' | 'queue' | null {
  if (event.key !== 'Enter') return null;
  const mod = event.ctrlKey || event.metaKey;
  if (event.altKey) return mod || event.shiftKey ? null : 'queue';
  if (sendKey === 'mod-enter') return mod ? (event.shiftKey ? 'interrupt' : 'send') : null;
  if (event.shiftKey) return null;
  return mod ? 'interrupt' : 'send';
}

/** Whether a key press in a request box sends it, per the person's choice; never mid-IME. */
export function isSendKey(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  sendKey: SendKey,
): boolean {
  if (event.key !== 'Enter' || event.altKey) return false;
  if (sendKey === 'mod-enter') return event.ctrlKey || event.metaKey;
  return !event.shiftKey;
}
