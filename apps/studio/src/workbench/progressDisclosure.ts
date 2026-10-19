/** Whether the chat tool list is open.
 *  `userOpen === null` means the person has not toggled it: open while work is
 *  unfinished or a failure still needs a look, closed after an ordinary success.
 *  A toggle the person made stays as they left it.
 */
export function progressListOpen(
  working: boolean,
  needsAttention: boolean,
  userOpen: boolean | null,
): boolean {
  if (userOpen !== null) return userOpen;
  return working || needsAttention;
}

/** A finished success does not need the tool list open. A failure, a stop, or an unsettled tool does. */
export function disclosureNeedsAttention(input: {
  runStatus: string;
  exposedExecutions: number;
  tools: readonly {
    status: string;
    phase?: string;
    reason: string | null;
    effectOutcome?: string | null;
  }[];
}): boolean {
  return (
    input.runStatus === 'failed' ||
    input.runStatus === 'cancelled' ||
    input.runStatus === 'interrupted' ||
    input.exposedExecutions > 0 ||
    input.tools.some(
      (call) =>
        call.status === 'blocked' ||
        call.phase === 'failed' ||
        Boolean(call.reason) ||
        call.effectOutcome === 'unknown' ||
        call.effectOutcome === 'cancelled',
    )
  );
}
