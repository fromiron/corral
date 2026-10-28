import type { CommandError } from '@corral/contracts';

// UX-04: why a run did not start, as something the person can act on. A refusal is final for
// that command (a new attempt is a new command); a lost answer is not a refusal and is retried
// with the same command ID so the runtime returns the first receipt instead of a second run.

export type RefusalKind =
  | 'signin'
  | 'profile'
  | 'terminal'
  | 'terminalUncertain'
  | 'busy'
  | 'limit'
  | 'reference'
  | 'network'
  | 'other';

export function terminalOwner(message: string): string | undefined {
  const match =
    /^working copy (?:terminal writer (\S+)|writer (terminal_\S+)) has not released ownership$/.exec(
      message,
    );
  return match?.[1] ?? match?.[2];
}

export function refusalKind({
  code,
  message,
  network = false,
  owner,
}: {
  code?: string | undefined;
  message: string;
  network?: boolean;
  owner?: CommandError['owner'];
}): RefusalKind {
  if (network) return 'network';
  if (owner && (code === 'RUN_ALREADY_ACTIVE' || code === 'RESOURCE_CAPACITY'))
    return owner.state === 'uncertain' ? 'terminalUncertain' : 'terminal';
  if (!owner && terminalOwner(message)) return 'terminal';
  if (/\bsign[ -]?in\b|login has expired|subscription sign-in/i.test(message)) return 'signin';
  if (/no such model profile|has no model|model profile/i.test(message)) return 'profile';
  switch (code) {
    case 'RUN_ALREADY_ACTIVE':
    case 'RESOURCE_CAPACITY':
      return 'busy';
    case 'LIMIT_REACHED':
      return 'limit';
    case 'TARGET_NOT_FOUND':
      return 'reference';
    case 'CAPABILITY_DENIED':
      return 'signin';
    default:
      return 'other';
  }
}
