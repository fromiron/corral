import {
  type AutoModelChoice,
  type AutoReasoning,
  ReasoningLevel,
  type RunReference,
} from '@corral/contracts';
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

/** Preserve an unsupported request; the person chooses a new effort explicitly. */
export function autoReasoningUnsupported(
  choice: AutoModelChoice,
  profiles: ProfileInfo[] | null,
  mode: 'mock' | 'live',
): boolean {
  if (!choice.reasoning || mode === 'mock' || !profiles) return false;
  const capability = profiles.find(
    (profile) => profile.profileId === choice.modelProfile,
  )?.reasoningCapabilities;
  return choice.reasoning.mode === 'provider_default'
    ? !capability?.providerDefault
    : !capability?.levels.includes(
        choice.reasoning.mode === 'fixed' ? choice.reasoning.level : 'medium',
      );
}

/**
 * User-edited request identity; the pending command separately freezes mode and startFrom.
 * `team` is the composer's team choice (CR-055): `none` is the default and adds nothing.
 */
export function autoCommandSeed(
  text: string,
  references: RunReference[],
  choice: AutoModelChoice,
  team = 'none',
): string {
  const identity: unknown[] = [references, choice.modelProfile, choice.reasoning ?? null];
  if (team !== 'none') identity.push({ team });
  return `auto\u0000${text}\u0000${JSON.stringify(identity)}`;
}

/** The reasoning chip's value: a level, a mode, `route`, or '' for unset (CR-021, CR-024). */
export function reasoningValue(policy: AutoReasoning | undefined): string {
  return policy?.mode === 'fixed' ? policy.level : (policy?.mode ?? '');
}

export function reasoningFrom(value: string): AutoReasoning | undefined {
  if (!value) return undefined;
  if (value === 'auto' || value === 'provider_default' || value === 'route') return { mode: value };
  return { mode: 'fixed', level: ReasoningLevel.parse(value) };
}
