import type { DecisionProvider } from '@corral/contracts';
import { defaultModelDir, OnnxEffortProvider } from '@corral/effort-judge';

/**
 * The judgment providers every entry point offers (#21): the local judge model from the OS's
 * data directory. `local-heuristic` is always added by the server. A model that is not
 * installed reports itself unavailable; the server runs without it.
 */
export function defaultDecisionProviders(): DecisionProvider[] {
  return [new OnnxEffortProvider({ dir: defaultModelDir() })];
}
