import type { AutoModelChoice, RunReference } from '@corral/contracts';
import type { ProfileInfo } from './useModels.ts';

// CR-024: sessions run live wherever live is possible, so a session never falls back to
// simulated agents on its own. An auto session uses one model and reasoning for the choice
// and for every role of the template it runs.

/** Simulation only where live cannot run: the in-browser demo or a simulated-only server. */
export function sessionRunMode(runtime: 'server' | 'browser', live: boolean): 'mock' | 'live' {
  return runtime === 'server' && live ? 'live' : 'mock';
}

/** The saved choice, or the first connected model; the demo's agents use the default profile. */
export function autoChoiceFor(
  saved: AutoModelChoice | null,
  profiles: ProfileInfo[] | null,
): AutoModelChoice {
  if (saved) return saved;
  const first = profiles?.find((p) => p.available) ?? profiles?.[0];
  return { modelProfile: first?.profileId ?? 'model-a' };
}

/** A live auto request whose model is unknown or not connected does not start. */
export function autoNotReady(
  choice: AutoModelChoice,
  profiles: ProfileInfo[] | null,
  mode: 'mock' | 'live',
): boolean {
  if (mode !== 'live') return false;
  return !profiles?.some((p) => p.profileId === choice.modelProfile && p.available);
}

/** What makes two sends the same command: the text, references and the model choice. */
export function autoCommandSeed(
  text: string,
  references: RunReference[],
  choice: AutoModelChoice,
): string {
  return `auto\u0000${text}\u0000${JSON.stringify([references, choice.modelProfile, choice.reasoning ?? null])}`;
}
