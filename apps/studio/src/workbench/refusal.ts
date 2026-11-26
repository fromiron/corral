import type { CommandError } from '@corral/contracts';

// UX-04: why a run did not start, as something the person can act on. A refusal is final for
// that command (a new attempt is a new command); a lost answer is not a refusal and is retried
// with the same command ID so the runtime returns the first receipt instead of a second run.

/** What holds the copy, as a refusal's owner names it. */
export type HolderKind =
  | 'terminal'
  | 'terminalUncertain'
  | 'busy'
  | 'heldTask'
  | 'heldDocument'
  | 'heldGit'
  | 'heldDebug'
  | 'heldDeployment'
  | 'heldSetup'
  | 'heldLanguage'
  | 'heldOperation'
  | 'runUncertain'
  | 'taskUncertain'
  | 'operationUncertain';

export type RefusalKind =
  | 'signin'
  | 'profile'
  | 'advisor'
  | 'image'
  | 'capability'
  | HolderKind
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

/** The kinds that name what holds the copy. */
export const HOLDER_KINDS = new Set<RefusalKind>([
  'terminal',
  'terminalUncertain',
  'heldTask',
  'heldDocument',
  'heldGit',
  'heldDebug',
  'heldDeployment',
  'heldSetup',
  'heldLanguage',
  'heldOperation',
  'runUncertain',
  'taskUncertain',
  'operationUncertain',
]);

/**
 * What holds the copy, as the refusal's owner names it (api-contract.md 오류): another run is
 * busy and may be queued after; a person's work is named without the queue (workbench.md 공유 개발
 * 모드); an owner whose end is unconfirmed is told apart from one at work.
 */
export function holderKind(owner: NonNullable<CommandError['owner']>): HolderKind {
  const unconfirmed = owner.state === 'uncertain';
  switch (owner.kind) {
    case 'run':
      return unconfirmed ? 'runUncertain' : 'busy';
    case 'terminal':
      return unconfirmed ? 'terminalUncertain' : 'terminal';
    case 'task':
      return unconfirmed ? 'taskUncertain' : 'heldTask';
    default: {
      if (unconfirmed) return 'operationUncertain';
      const operation = owner.operationKind ?? '';
      if (operation.startsWith('document.')) return 'heldDocument';
      if (operation.startsWith('git.')) return 'heldGit';
      if (operation === 'debug') return 'heldDebug';
      if (operation === 'deployment') return 'heldDeployment';
      if (operation === 'setup') return 'heldSetup';
      if (operation === 'language') return 'heldLanguage';
      return 'heldOperation';
    }
  }
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
    return holderKind(owner);
  if (!owner && terminalOwner(message)) return 'terminal';
  // The conversation's advisor's model, whatever its own trouble (features/advisor.md "두는 곳").
  if (message.startsWith('Advisor model ')) return 'advisor';
  if (/no confirmed image input support|image input is not supported/i.test(message))
    return 'image';
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
      return 'capability';
    default:
      return 'other';
  }
}
