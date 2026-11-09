import type { RoutingBackend, RoutingEngine } from '@corral/contracts';
import type { D1Engine } from '@corral/local-intelligence';
import type { DecisionApis } from './decision-apis.ts';

// The engine a saved effort routing setting names (features/effort-routing.md#설정). Only that
// one is asked: choosing an API never starts, installs or asks Local, and the reverse.

export interface RoutingEngineDeps {
  /** Absent on a server that cannot keep keys; an API engine is then unavailable. */
  decisionApis: DecisionApis | undefined;
  /** Absent on a server without real models; a Local engine is then unavailable. */
  local: D1Engine | undefined;
}

export function routingEngines(deps: RoutingEngineDeps) {
  return (engine: RoutingEngine): RoutingBackend | null =>
    engine.kind === 'api'
      ? (deps.decisionApis?.backend(engine) ?? null)
      : (deps.local?.backend(engine) ?? null);
}
