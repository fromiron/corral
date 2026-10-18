import type { AutoModelChoice, RunReference } from '@corral/contracts';
import type { ProfileInfo } from './useModels.ts';

// CR-024: not implemented yet.

export function sessionRunMode(_runtime: 'server' | 'browser', _live: boolean): 'mock' | 'live' {
  throw new Error('not implemented');
}

export function autoChoiceFor(
  _saved: AutoModelChoice | null,
  _profiles: ProfileInfo[] | null,
): AutoModelChoice {
  throw new Error('not implemented');
}

export function autoNotReady(
  _choice: AutoModelChoice,
  _profiles: ProfileInfo[] | null,
  _mode: 'mock' | 'live',
): boolean {
  throw new Error('not implemented');
}

export function autoCommandSeed(
  _text: string,
  _references: RunReference[],
  _choice: AutoModelChoice,
): string {
  throw new Error('not implemented');
}
